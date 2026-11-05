// IPC handlers: the bridge between the renderer (UI) and SSH / storage in the main process.
//
// Security model:
// - Every message must come from our own window and our own page (checkSender).
// - Every argument is validated (./validate) before use.
// - Secrets only flow renderer -> main, never back.
// - Local file system access is limited to what the user picked in a dialog, dropped
//   onto the window, or the Downloads folder; the app's own data folder is off limits.

import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'crypto'
import * as path from 'path'
import { store } from './store'
import { knownKeyTypes, verifyHostKey } from './knownHosts'
import { SshConnection, type PromptAnswer } from './sshConnection'
import * as sftpOps from './sftpOps'
import * as v from './validate'
import * as updater from './updater'
import type { UpdateStatus } from '../shared/types'
import type { AppInfo, AuthStatus, ConnStatusEvent, PromptRequest, TransferDirection, TransferProgress } from '../shared/types'

const MAX_CONNECTIONS = 100
const MAX_WRITE = 1024 * 1024

const connections = new Map<string, SshConnection>()
const pendingPrompts = new Map<string, (a: PromptAnswer) => void>()
/** Folders the user picked in a "Download to…" dialog. */
const chosenDownloadDirs = new Set<string>()
/** Files this session downloaded (the only paths "Show in folder" may reveal). */
const downloadedPaths = new Set<string>()

let mainWindow: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win
}

function getWin(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

function send(channel: string, ...args: unknown[]): void {
  getWin()?.webContents.send(channel, ...args)
}

// ---- sender verification --------------------------------------------------------

function appUrlPrefix(): string {
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (dev && !app.isPackaged) return new URL(dev).origin + '/'
  return 'app://simssh/'
}

function checkSender(e: IpcMainEvent | IpcMainInvokeEvent): void {
  const win = getWin()
  const frameUrl = e.senderFrame?.url ?? ''
  const ok =
    !!win &&
    e.sender === win.webContents &&
    e.senderFrame === win.webContents.mainFrame &&
    frameUrl.split('#')[0].startsWith(appUrlPrefix())
  if (!ok) throw new Error('IPC message from an untrusted sender was rejected.')
}

type Args = unknown[]
interface Opts {
  /** Allowed while signed out (only the sign-in screen's own calls). */
  public?: boolean
}
function requireSignIn(channel: string, opts?: Opts): void {
  if (!opts?.public && !store.isSignedIn()) throw new Error(`Signed out (${channel}).`)
}
function handle(channel: string, fn: (...args: Args) => unknown, opts?: Opts): void {
  ipcMain.handle(channel, (e, ...args) => {
    checkSender(e)
    requireSignIn(channel, opts)
    return fn(...args)
  })
}
function on(channel: string, fn: (...args: Args) => void): void {
  ipcMain.on(channel, (e, ...args) => {
    try {
      checkSender(e)
      requireSignIn(channel)
      fn(...args)
    } catch (err) {
      console.warn(`[ipc] ${channel}: ${(err as Error).message}`)
    }
  })
}

// ---- helpers ----------------------------------------------------------------------

function conn(connId: unknown): SshConnection {
  const c = connections.get(v.id(connId, 'tab id'))
  if (!c) throw new Error('This tab is not connected.')
  return c
}

function askUser(req: Omit<PromptRequest, 'promptId'>): Promise<PromptAnswer> {
  const promptId = randomUUID()
  return new Promise((resolve) => {
    pendingPrompts.set(promptId, resolve)
    send('prompt:request', { ...req, promptId } satisfies PromptRequest)
  })
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Local paths the renderer asks us to upload: absolute, and never the app's own data. */
function uploadPath(p: unknown): string {
  const lp = v.str(p, 'local path', 4096)
  if (!path.isAbsolute(lp)) throw new Error('Invalid local path.')
  if (isInside(app.getPath('userData'), lp)) throw new Error("SimSSH's own data folder can't be uploaded.")
  return lp
}

async function chooseDir(title: string): Promise<string | null> {
  const win = getWin()
  const opts: Electron.OpenDialogOptions = { title, properties: ['openDirectory', 'createDirectory'] }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return res.canceled ? null : res.filePaths[0]
}

// ---- handlers -----------------------------------------------------------------------

/** Sign out: drop every connection, forget per-session permissions, wipe the key. */
function signOut(): void {
  closeAllConnections()
  chosenDownloadDirs.clear()
  downloadedPaths.clear()
  store.lock()
}

export function registerIpc(): void {
  handle(
    'app:info',
    async (): Promise<AppInfo> => ({
      version: app.getVersion(),
      platform: process.platform,
      // Saved passwords live in the account's encrypted vault, so saving is always possible.
      encryptionAvailable: true
    }),
    { public: true }
  )

  // ---- updates ----------------------------------------------------------------
  updater.startUpdater((s) => send('update:status', s))
  handle('update:status', (): UpdateStatus => updater.getUpdateStatus(), { public: true })
  handle('update:check', () => updater.check())
  handle('update:download', () => updater.download())
  handle('update:install', () => {
    // The user already confirmed in the UI; close connections so the window can quit.
    closeAllConnections()
    updater.install()
  })

  // ---- accounts ---------------------------------------------------------------
  handle(
    'auth:status',
    async (): Promise<AuthStatus> => ({
      signedIn: store.isSignedIn(),
      username: store.username(),
      hasAccounts: await store.hasAccounts(),
      legacySessions: await store.legacySessionCount()
    }),
    { public: true }
  )
  handle(
    'auth:create',
    async (username, password) => {
      signOut()
      await store.create(username, password)
    },
    { public: true }
  )
  handle(
    'auth:signIn',
    async (username, password) => {
      signOut()
      await store.signIn(username, password)
    },
    { public: true }
  )
  handle('auth:signOut', () => signOut())
  handle('auth:changePassword', (current, next) => store.changePassword(current, next))
  handle('auth:deleteAccount', async (password) => {
    closeAllConnections()
    await store.deleteAccount(password)
    signOut()
  })

  // ---- session store --------------------------------------------------------
  handle('store:get', () => store.getAll())
  handle('store:saveSession', (req) => store.saveSession(v.sessionSave(req)))
  handle('store:deleteSession', (sid) => store.deleteSession(v.id(sid)))
  handle('store:saveFolder', (f) => store.saveFolder(v.folder(f)))
  handle('store:deleteFolder', (fid) => store.deleteFolder(v.id(fid)))
  handle('store:replaceAll', (data) => store.replaceAll(v.storeData(data)))

  handle('dialog:openKey', async () => {
    const win = getWin()
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose private key',
      defaultPath: path.join(app.getPath('home'), '.ssh'),
      properties: ['openFile', 'showHiddenFiles']
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? null : res.filePaths[0]
  })

  // ---- prompts ----------------------------------------------------------------
  on('prompt:respond', (raw) => {
    if (!raw || typeof raw !== 'object') return
    const r = raw as Record<string, unknown>
    const promptId = v.str(r.promptId, 'prompt id', 64)
    const resolve = pendingPrompts.get(promptId)
    if (!resolve) return
    pendingPrompts.delete(promptId)
    const answers = r.answers === null ? null : v.strArray(r.answers, 'answers', 16, 4096)
    resolve({ answers, remember: v.bool(r.remember) })
  })

  // ---- ssh ------------------------------------------------------------------
  handle('ssh:connect', async (raw) => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid request.')
    const req = raw as Record<string, unknown>
    const connId = v.id(req.connId, 'tab id')
    const cols = v.int(req.cols, 'width', 1, 2000)
    const rows = v.int(req.rows, 'height', 1, 1000)
    if (!connections.has(connId) && connections.size >= MAX_CONNECTIONS) throw new Error('Too many open connections.')

    // Saved sessions: connection details come from the store, never from the renderer.
    const saved = req.sessionId != null ? store.getSession(v.id(req.sessionId, 'session id')) : undefined
    if (req.sessionId != null && !saved) throw new Error('This session no longer exists.')
    // sessions.json could have been edited by hand, so saved values are validated too.
    const checked = saved ? v.session(saved) : undefined
    const target = checked
      ? {
          host: checked.host,
          port: checked.port,
          username: checked.username,
          authMethod: checked.authMethod,
          keyPath: checked.keyPath,
          legacyAlgorithms: checked.legacyAlgorithms
        }
      : {
          host: v.host(req.host),
          port: v.port(req.port),
          username: v.username(req.username),
          authMethod: v.authMethod(req.authMethod),
          keyPath: v.optStr(req.keyPath, 'key path'),
          legacyAlgorithms: false
        }

    connections.get(connId)?.close()

    const c = new SshConnection(
      {
        ...target,
        cols,
        rows,
        secret: saved ? await store.getSecret(saved.id) : undefined,
        canRemember: !!saved,
        knownHostKeyTypes: await knownKeyTypes(target.host, target.port)
      },
      {
        verifyHost: (h, p, key) => verifyHostKey(h, p, key, getWin()),
        prompt: askUser,
        onData: (data) => send('ssh:data', connId, data),
        onStatus: (state, message) => {
          // Error text can contain server-supplied strings; strip control characters so it
          // can't smuggle escape sequences into the terminal where it is printed.
          const clean = message?.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 500)
          send('ssh:status', { connId, state, message: clean } satisfies ConnStatusEvent)
          if ((state === 'closed' || state === 'error') && connections.get(connId) === c) connections.delete(connId)
        },
        saveSecret: (secret) => {
          if (saved) void store.setSecret(saved.id, secret).then(() => send('store:changed'))
        }
      }
    )
    connections.set(connId, c)
    c.connect()
  })

  on('ssh:write', (connId, data) => {
    const d = v.str(data, 'input', MAX_WRITE, { allowControl: true })
    connections.get(v.id(connId))?.write(d)
  })
  on('ssh:resize', (connId, cols, rows) => {
    connections.get(v.id(connId))?.resize(v.int(cols, 'width', 1, 2000), v.int(rows, 'height', 1, 1000))
  })
  on('ssh:close', (connId) => {
    const cid = v.id(connId)
    connections.get(cid)?.close()
    connections.delete(cid)
  })

  // ---- sftp -----------------------------------------------------------------
  handle('sftp:home', async (connId, startDir) => {
    const sftp = await conn(connId).sftp()
    const start = startDir == null || startDir === '' ? undefined : v.remotePath(startDir)
    if (start) {
      try {
        return await sftpOps.realpath(sftp, start)
      } catch {
        /* fall back to home */
      }
    }
    return sftpOps.realpath(sftp, '.')
  })
  handle('sftp:list', async (connId, dir) => sftpOps.list(await conn(connId).sftp(), v.remotePath(dir)))
  handle('sftp:mkdir', async (connId, dir) => sftpOps.mkdir(await conn(connId).sftp(), v.remotePath(dir)))
  handle('sftp:rename', async (connId, from, to) =>
    sftpOps.rename(await conn(connId).sftp(), v.remotePath(from), v.remotePath(to))
  )
  handle('sftp:chmod', async (connId, target, mode) =>
    sftpOps.chmod(await conn(connId).sftp(), v.remotePath(target), v.int(mode, 'mode', 0, 0o7777))
  )
  handle('sftp:delete', async (connId, paths) => {
    const sftp = await conn(connId).sftp()
    for (const p of v.strArray(paths, 'paths', 10000)) {
      if (p === '/' || p === '') throw new Error("The root folder can't be deleted.")
      await sftpOps.remove(sftp, p)
    }
  })

  handle('sftp:chooseLocal', async (mode) => {
    const m = v.oneOf(mode, 'mode', ['files', 'folder', 'downloadDir'] as const)
    if (m === 'downloadDir') {
      const dir = await chooseDir('Download to')
      if (!dir) return []
      chosenDownloadDirs.add(path.resolve(dir))
      return [dir]
    }
    const win = getWin()
    const opts: Electron.OpenDialogOptions =
      m === 'folder'
        ? { title: 'Choose folder to upload', properties: ['openDirectory'] }
        : { title: 'Choose files to upload', properties: ['openFile', 'multiSelections'] }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? [] : res.filePaths
  })

  function startTransfer(
    connId: string,
    direction: TransferDirection,
    name: string,
    work: (progress: (t: number, total: number) => void) => Promise<unknown>
  ): string {
    const transferId = randomUUID()
    const base: Omit<TransferProgress, 'transferred' | 'total' | 'done'> = { transferId, connId, direction, name }
    let total = 0
    let transferred = 0
    work((t, tot) => {
      transferred = t
      total = tot
      send('sftp:transfer', { ...base, transferred, total, done: false } satisfies TransferProgress)
    }).then(
      (result) => {
        send('sftp:transfer', { ...base, transferred: total, total, done: true } satisfies TransferProgress)
        if (direction === 'download' && typeof result === 'string') {
          downloadedPaths.add(path.resolve(result))
          send('sftp:downloaded', transferId, result)
        }
      },
      (err: Error) => send('sftp:transfer', { ...base, transferred, total, done: true, error: err.message } satisfies TransferProgress)
    )
    return transferId
  }

  handle('sftp:upload', async (connId, localPaths, remoteDir) => {
    const cid = v.id(connId)
    const sftp = await conn(cid).sftp()
    const dir = v.remotePath(remoteDir)
    const paths = v.strArray(localPaths, 'files', 1000).map(uploadPath)
    return paths.map((lp) => startTransfer(cid, 'upload', path.basename(lp), (prog) => sftpOps.upload(sftp, lp, dir, prog)))
  })

  handle('sftp:download', async (connId, remotePaths, localDir) => {
    const cid = v.id(connId)
    const sftp = await conn(cid).sftp()
    let dir = app.getPath('downloads')
    if (localDir != null && localDir !== '') {
      const requested = path.resolve(v.str(localDir, 'folder', 4096))
      // Only folders the user picked in a dialog this session.
      if (!chosenDownloadDirs.has(requested)) throw new Error('Choose the download folder with "Download to…".')
      dir = requested
    }
    return v
      .strArray(remotePaths, 'files', 10000)
      .map((rp) => startTransfer(cid, 'download', path.posix.basename(rp), (prog) => sftpOps.download(sftp, rp, dir, prog)))
  })

  on('shell:showItem', (p) => {
    const lp = path.resolve(v.str(p, 'path', 4096))
    if (downloadedPaths.has(lp)) shell.showItemInFolder(lp)
  })
}

export function activeConnectionCount(): number {
  return connections.size
}

export function closeAllConnections(): void {
  for (const c of connections.values()) c.close()
  connections.clear()
  for (const resolve of pendingPrompts.values()) resolve({ answers: null })
  pendingPrompts.clear()
}
