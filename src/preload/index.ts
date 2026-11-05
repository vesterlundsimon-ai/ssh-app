// The only API the UI can use. Runs in a sandboxed preload with contextIsolation.

import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  AppInfo,
  AuthStatus,
  UpdateStatus,
  ConnectRequest,
  ConnStatusEvent,
  Folder,
  PromptRequest,
  PromptResponse,
  RemoteEntry,
  SessionSaveRequest,
  SessionStoreData,
  TransferProgress
} from '../shared/types'

function on<T extends unknown[]>(channel: string, fn: (...args: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => fn(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),

  update: {
    status: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:status'),
    check: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:check'),
    download: (): Promise<void> => ipcRenderer.invoke('update:download'),
    install: (): Promise<void> => ipcRenderer.invoke('update:install'),
    onStatus: (fn: (s: UpdateStatus) => void) => on('update:status', fn)
  },

  auth: {
    status: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:status'),
    create: (username: string, password: string): Promise<void> => ipcRenderer.invoke('auth:create', username, password),
    signIn: (username: string, password: string): Promise<void> => ipcRenderer.invoke('auth:signIn', username, password),
    signOut: (): Promise<void> => ipcRenderer.invoke('auth:signOut'),
    changePassword: (current: string, next: string): Promise<void> => ipcRenderer.invoke('auth:changePassword', current, next),
    deleteAccount: (password: string): Promise<void> => ipcRenderer.invoke('auth:deleteAccount', password)
  },

  store: {
    get: (): Promise<SessionStoreData> => ipcRenderer.invoke('store:get'),
    saveSession: (req: SessionSaveRequest): Promise<void> => ipcRenderer.invoke('store:saveSession', req),
    deleteSession: (id: string): Promise<void> => ipcRenderer.invoke('store:deleteSession', id),
    saveFolder: (f: Folder): Promise<void> => ipcRenderer.invoke('store:saveFolder', f),
    deleteFolder: (id: string): Promise<void> => ipcRenderer.invoke('store:deleteFolder', id),
    replaceAll: (d: SessionStoreData): Promise<void> => ipcRenderer.invoke('store:replaceAll', d),
    onChanged: (fn: () => void) => on('store:changed', fn)
  },

  chooseKeyFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:openKey'),

  ssh: {
    connect: (req: ConnectRequest): Promise<void> => ipcRenderer.invoke('ssh:connect', req),
    write: (connId: string, data: string): void => ipcRenderer.send('ssh:write', connId, data),
    resize: (connId: string, cols: number, rows: number): void => ipcRenderer.send('ssh:resize', connId, cols, rows),
    close: (connId: string): void => ipcRenderer.send('ssh:close', connId),
    onData: (fn: (connId: string, data: Uint8Array) => void) => on('ssh:data', fn),
    onStatus: (fn: (e: ConnStatusEvent) => void) => on('ssh:status', fn)
  },

  prompt: {
    onRequest: (fn: (req: PromptRequest) => void) => on('prompt:request', fn),
    respond: (res: PromptResponse): void => ipcRenderer.send('prompt:respond', res)
  },

  sftp: {
    home: (connId: string, startDir?: string): Promise<string> => ipcRenderer.invoke('sftp:home', connId, startDir),
    list: (connId: string, dir: string): Promise<RemoteEntry[]> => ipcRenderer.invoke('sftp:list', connId, dir),
    mkdir: (connId: string, dir: string): Promise<void> => ipcRenderer.invoke('sftp:mkdir', connId, dir),
    rename: (connId: string, from: string, to: string): Promise<void> => ipcRenderer.invoke('sftp:rename', connId, from, to),
    chmod: (connId: string, target: string, mode: number): Promise<void> => ipcRenderer.invoke('sftp:chmod', connId, target, mode),
    remove: (connId: string, paths: string[]): Promise<void> => ipcRenderer.invoke('sftp:delete', connId, paths),
    upload: (connId: string, localPaths: string[], remoteDir: string): Promise<string[]> =>
      ipcRenderer.invoke('sftp:upload', connId, localPaths, remoteDir),
    download: (connId: string, remotePaths: string[], localDir?: string): Promise<string[]> =>
      ipcRenderer.invoke('sftp:download', connId, remotePaths, localDir),
    chooseLocal: (mode: 'files' | 'folder' | 'downloadDir'): Promise<string[]> => ipcRenderer.invoke('sftp:chooseLocal', mode),
    onTransfer: (fn: (p: TransferProgress) => void) => on('sftp:transfer', fn),
    onDownloaded: (fn: (transferId: string, localPath: string) => void) => on('sftp:downloaded', fn)
  },

  /** Local path of a file dropped from Explorer. */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  showItemInFolder: (p: string): void => ipcRenderer.send('shell:showItem', p)
}

export type SimSSHApi = typeof api

contextBridge.exposeInMainWorld('api', api)
