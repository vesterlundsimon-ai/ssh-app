import { app, BrowserWindow, dialog, Menu, shell } from 'electron'
import * as path from 'path'
import { store } from './store'
import { activeConnectionCount, closeAllConnections, registerIpc } from './ipc'

app.setAppUserModelId('com.shellport.app')

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
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // Links (e.g. URLs clicked in the terminal) open in the default browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault())

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
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
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
  await store.load()
  registerIpc()
  createWindow()
})

app.on('window-all-closed', () => {
  closeAllConnections()
  app.quit()
})
