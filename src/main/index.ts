import { app, BrowserWindow, dialog, Menu, protocol, session, shell } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'
import { activeConnectionCount, closeAllConnections, registerIpc, setMainWindow } from './ipc'

app.setAppUserModelId('com.shellport.app')

// The UI is served from a private app:// scheme instead of file://, so the page gets
// no file-system privileges (see the grantFileProtocolExtraPrivileges fuse).
export const APP_ORIGIN = 'app://shellport'
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'"
].join('; ')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json'
}

function registerAppProtocol(): void {
  const root = path.join(__dirname, '../renderer')
  protocol.handle('app', async (req) => {
    const url = new URL(req.url)
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
    const file = path.resolve(root, '.' + rel)
    if (url.host !== 'shellport' || (file !== root && !file.startsWith(root + path.sep))) {
      return new Response('Not found', { status: 404 })
    }
    try {
      const body = await fs.readFile(file)
      return new Response(body, {
        headers: {
          'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
          'Content-Security-Policy': CSP,
          'X-Content-Type-Options': 'nosniff'
        }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

// The app never needs a debugger port or remote debugging; refuse them even if passed on the command line.
for (const flag of ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk']) {
  if (app.commandLine.hasSwitch(flag) && app.isPackaged) app.exit(1)
}

/** Only real web links leave the app, and only to the default browser. */
function openExternalSafely(url: string): void {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:' || u.protocol === 'http:') void shell.openExternal(u.href)
  } catch {
    /* not a URL */
  }
}

// Defence in depth for every web contents the app creates (there is only one window,
// but this also covers anything created by accident later).
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (ev) => ev.preventDefault())
  contents.on('will-navigate', (ev) => ev.preventDefault())
  contents.on('will-redirect', (ev) => ev.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let quitConfirmed = false

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 480,
    show: false,
    backgroundColor: '#0f1115',
    title: 'Shellport',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      devTools: !app.isPackaged
    }
  })

  setMainWindow(mainWindow)
  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.on('close', async (e) => {
    if (quitConfirmed || activeConnectionCount() === 0) return
    e.preventDefault()
    const n = activeConnectionCount()
    const res = await dialog.showMessageBox(mainWindow!, {
      type: 'question',
      message: `Close Shellport?`,
      detail: `${n} connection${n === 1 ? ' is' : 's are'} still open and will be disconnected.`,
      buttons: ['Cancel', 'Close'],
      defaultId: 1,
      cancelId: 0,
      noLink: true
    })
    if (res.response === 1) {
      quitConfirmed = true
      closeAllConnections()
      mainWindow?.close()
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadURL(`${APP_ORIGIN}/index.html`)
  }
}

function hardenSession(): void {
  const ses = session.defaultSession
  // Clipboard access (copy on select, paste) is the only browser permission the UI uses.
  const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write'])
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
  ses.setDevicePermissionHandler(() => false)
  // The app loads nothing from the network: block any request that isn't a local file
  // (or the Vite dev server while developing).
  const dev = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined
  ses.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url
    const ok =
      url.startsWith(APP_ORIGIN + '/') || url.startsWith('devtools:') || url.startsWith('data:') || (dev ? url.startsWith(new URL(dev).origin) || url.startsWith('ws:') : false)
    callback({ cancel: !ok })
  })
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.whenReady().then(async () => {
  // No default menu bar; keep reload / devtools shortcuts only in development.
  Menu.setApplicationMenu(
    app.isPackaged
      ? null
      : Menu.buildFromTemplate([{ label: 'Dev', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }] }])
  )
  hardenSession()
  registerAppProtocol()
  registerIpc()
  createWindow()
})

app.on('window-all-closed', () => {
  closeAllConnections()
  app.quit()
})
