// Types shared between the main process, preload and renderer.

export type AuthMethod = 'password' | 'key' | 'agent'

export interface Folder {
  id: string
  name: string
  parentId: string | null
  collapsed?: boolean
}

export interface Session {
  id: string
  name: string
  folderId: string | null
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  /** Path to a private key file on this computer (authMethod === 'key'). */
  keyPath?: string
  /** Optional accent colour shown next to the session and on its tab. */
  color?: string
  notes?: string
  /** Directory the SFTP browser opens in. Defaults to the remote home dir. */
  sftpStartDir?: string
  /** Also allow SHA-1 / CBC / ssh-rsa algorithms (for old switches and appliances). */
  legacyAlgorithms?: boolean
  /** Set by the main process: is a password / passphrase stored for this session? */
  hasSecret?: boolean
}

export interface SessionStoreData {
  version: 1
  folders: Folder[]
  sessions: Session[]
}

/** What the renderer sends when saving a session. Secrets travel one way only. */
export interface SessionSaveRequest {
  session: Session
  /** undefined = leave stored secret unchanged, '' = clear it, otherwise store it. */
  secret?: string
}

/** Connection parameters for a tab. A tab is either a saved session or a quick connect. */
export interface ConnectRequest {
  connId: string
  sessionId?: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  keyPath?: string
  cols: number
  rows: number
}

export type ConnState = 'connecting' | 'connected' | 'closed' | 'error'

export interface ConnStatusEvent {
  connId: string
  state: ConnState
  message?: string
}

export interface RemoteEntry {
  name: string
  path: string
  isDir: boolean
  isLink: boolean
  size: number
  mtime: number // ms since epoch
  mode: number
  permissions: string // e.g. drwxr-xr-x
}

export type TransferDirection = 'upload' | 'download'

export interface TransferProgress {
  transferId: string
  connId: string
  direction: TransferDirection
  name: string
  transferred: number
  total: number
  done: boolean
  error?: string
}

/** A question the main process needs the user to answer (password, passphrase, MFA code...). */
export interface PromptRequest {
  promptId: string
  title: string
  message?: string
  fields: { label: string; secret: boolean }[]
  /** Offer a "remember" checkbox (saves the answer to the session). */
  allowRemember?: boolean
}

export interface PromptResponse {
  promptId: string
  /** null = the user cancelled. */
  answers: string[] | null
  remember?: boolean
}

export interface AppInfo {
  version: string
  platform: string
  encryptionAvailable: boolean
}

export interface AuthStatus {
  signedIn: boolean
  username?: string
  /** Does any account exist on this PC? */
  hasAccounts: boolean
  /** Sessions saved by an older version that the first new account will take over. */
  legacySessions: number
}
