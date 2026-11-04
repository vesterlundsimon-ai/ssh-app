// IPC handlers: the bridge between the renderer (UI) and SSH / storage in the main process.

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { randomUUID } from 'crypto'
import * as path from 'path'
import { encryptionAvailable, store } from './store'
import { verifyHostKey } from './knownHosts'
import { SshConnection, type PromptAnswer } from './sshConnection'
import * as sftpOps from './sftpOps'
import type {
  AppInfo,
  ConnectRequest,
  ConnStatusEvent,
  Folder,
  PromptRequest,
  PromptResponse,
  SessionSaveRequest,
  SessionStoreData,
  TransferDirection,
  TransferProgress
} from '../shared/types'

const connections = new Map<string, SshConnection>()
const pendingPrompts = new Map<string, (a: PromptAnswer) => void>()

function getWin(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null
}

function send(channel: string, ...args: unknown[]): void {
  const win = getWin()
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function conn(connId: string): SshConnection {
  const c = connections.get(connId)
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

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

export function registerIpc(): void {
  // ---- app ------------------------------------------------------------------
  ipcMain.handle('app:info', async (): Promise<AppInfo> => ({
    version: app.getVersion(),
    platform: process.platform,
    encryptionAvailable: await encryptionAvailable()
  }))

  // ---- session store --------------------------------------------------------
  ipcMain.handle('store:get', () => store.getAll())
  ipcMain.handle('store:saveSession', (_e, req: SessionSaveRequest) => store.saveSession(req))
  ipcMain.handle('store:deleteSession', (_e, id: string) => store.deleteSession(id))
  ipcMain.handle('store:saveFolder', (_e, f: Folder) => store.saveFolder(f))
  ipcMain.handle('store:deleteFolder', (_e, id: string) => store.deleteFolder(id))
  ipcMain.handle('store:replaceAll', (_e, data: SessionStoreData) => store.replaceAll(data))

  ipcMain.handle('dialog:openKey', async () => {
    const win = getWin()
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose private key',
      defaultPath: path.join(app.getPath('home'), '.ssh'),
      properties: ['openFile', 'showHiddenFiles'],
      filters: [
        { name: 'Private keys', extensions: ['*', 'pem', 'key'] }
      ]
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return res.canceled ? null : res.filePaths[0]
  })

  // ---- prompts ----------------------------------------------------------------
  ipcMain.on('prompt:respond', (_e, res: PromptResponse) => {
    const resolve = pendingPrompts.get(res.promptId)
    if (!resolve) return
    pendingPrompts.delete(res.promptId)
    resolve({ answers: res.answers, remember: res.remember })
  })

  // ---- ssh ------------------------------------------------------------------
  ipcMain.handle('ssh:connect', async (_e, req: ConnectRequest) => {
    if (!isNonEmptyString(req.connId) || !isNonEmptyString(req.host) || !isNonEmptyString(req.username)) {
      throw new Error('Host and username are required.')
    }
    connections.get(req.connId)?.close()

    // For saved sessions, read connection details from the store, not from the renderer.
    const saved = req.sessionId ? store.getSession(req.sessionId) : undefined
    const opts = saved
      ? {
          host: saved.host,
          port: saved.port || 22,
          username: saved.username,
          authMethod: saved.authMethod,
          keyPath: saved.keyPath
        }
      : { host: req.host, port: req.port || 22, username: req.username, authMethod: req.authMethod, keyPath: req.keyPath }

    const c = new SshConnection(
      {
        ...opts,
        cols: req.cols,
        rows: req.rows,
        secret: saved ? await store.getSecret(saved.id) : undefined,
        canRemember: !!saved && (await encryptionAvailable())
      },
      {
        verifyHost: (host, port, key) => verifyHostKey(host, port, key, getWin()),
        prompt: askUser,
        onData: (data) => send('ssh:data', req.connId, data),
        onStatus: (state, message) => {
          send('ssh:status', { connId: req.connId, state, message } satisfies ConnStatusEvent)
          if (state === 'closed' || state === 'error') {
            if (connections.get(req.connId) === c) connections.delete(req.connId)
          }
        },
        saveSecret: (secret) => {
          if (saved) void store.setSecret(saved.id, secret).then(() => send('store:changed'))
        }
      }
    )
    connections.set(req.connId, c)
    c.connect()
  })

  ipcMain.on('ssh:write', (_e, connId: string, data: string) => connections.get(connId)?.write(data))
  ipcMain.on('ssh:resize', (_e, connId: string, cols: number, rows: number) => {
    if (cols > 0 && rows > 0) connections.get(connId)?.resize(cols, rows)
  })
  ipcMain.on('ssh:close', (_e, connId: string) => {
    connections.get(connId)?.close()
    connections.delete(connId)
  })

  // ---- sftp -----------------------------------------------------------------
  ipcMain.handle('sftp:home', async (_e, connId: string, startDir?: string) => {
    const sftp = await conn(connId).sftp()
    if (startDir) {
      try {
        return await sftpOps.realpath(sftp, startDir)
      } catch {
        /* fall back to home */
      }
    }
    return sftpOps.realpath(sftp, '.')
  })
  ipcMain.handle('sftp:list', async (_e, connId: string, dir: string) => sftpOps.list(await conn(connId).sftp(), dir))
  ipcMain.handle('sftp:mkdir', async (_e, connId: string, dir: string) => sftpOps.mkdir(await conn(connId).sftp(), dir))
  ipcMain.handle('sftp:rename', async (_e, connId: string, from: string, to: string) =>
    sftpOps.rename(await conn(connId).sftp(), from, to)
  )
  ipcMain.handle('sftp:chmod', async (_e, connId: string, target: string, mode: number) =>
    sftpOps.chmod(await conn(connId).sftp(), target, mode)
  )
  ipcMain.handle('sftp:delete', async (_e, connId: string, paths: string[]) => {
    const sftp = await conn(connId).sftp()
    for (const p of paths) await sftpOps.remove(sftp, p)
  })

  ipcMain.handle('sftp:chooseLocal', async (_e, mode: 'files' | 'folder') => {
    const win = getWin()
    const opts: Electron.OpenDialogOptions =
      mode === 'folder'
        ? { title: 'Choose folder', properties: ['openDirectory', 'createDirectory'] }
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
        if (direction === 'download' && typeof result === 'string') send('sftp:downloaded', transferId, result)
      },
      (err: Error) =>
        send('sftp:transfer', { ...base, transferred, total, done: true, error: err.message } satisfies TransferProgress)
    )
    return transferId
  }

  ipcMain.handle('sftp:upload', async (_e, connId: string, localPaths: string[], remoteDir: string) => {
    const sftp = await conn(connId).sftp()
    return localPaths.map((lp) =>
      startTransfer(connId, 'upload', path.basename(lp), (prog) => sftpOps.upload(sftp, lp, remoteDir, prog))
    )
  })

  ipcMain.handle('sftp:download', async (_e, connId: string, remotePaths: string[], localDir?: string) => {
    const sftp = await conn(connId).sftp()
    const dir = localDir || app.getPath('downloads')
    return remotePaths.map((rp) =>
      startTransfer(connId, 'download', path.posix.basename(rp), (prog) => sftpOps.download(sftp, rp, dir, prog))
    )
  })

  ipcMain.on('shell:showItem', (_e, p: string) => {
    if (isNonEmptyString(p)) shell.showItemInFolder(p)
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
