// The signed-in account's sessions, folders, secrets and host keys.
//
// Everything lives in the account's encrypted vault (./accounts, ./vault). While nobody
// is signed in, the store is empty and every method throws.
//
// Before accounts existed (v0.1–0.2) data lived in sessions.json / secrets.json /
// known_hosts.json. The first account created on a PC takes that data over, and the
// old files are deleted once the vault has been written and read back.

import { app, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'
import { AccountManager, emptyVault, sanitizeVault, type KnownKey, type Unlocked, type VaultData } from './accounts'
import { deriveKey, unseal, parseVaultFile } from './vault'
import type { Folder, Session, SessionSaveRequest, SessionStoreData } from '../shared/types'

export class SignedOutError extends Error {
  constructor() {
    super('You are signed out.')
  }
}

function legacyFiles(): { sessions: string; secrets: string; knownHosts: string } {
  const dir = app.getPath('userData')
  return {
    sessions: path.join(dir, 'sessions.json'),
    secrets: path.join(dir, 'secrets.json'),
    knownHosts: path.join(dir, 'known_hosts.json')
  }
}

async function readJsonIfExists(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Data saved by versions 0.1–0.2 (then called Shellport), or null if there is none. */
async function readLegacy(): Promise<VaultData | null> {
  const files = legacyFiles()
  const [sessionsRaw, secretsRaw, hostsRaw] = await Promise.all([
    readJsonIfExists(files.sessions),
    readJsonIfExists(files.secrets),
    readJsonIfExists(files.knownHosts)
  ])
  if (sessionsRaw === undefined && secretsRaw === undefined && hostsRaw === undefined) return null
  const s = (sessionsRaw ?? {}) as { folders?: unknown; sessions?: unknown }

  // Old secrets were encrypted with Windows DPAPI; decrypt them so they can move into the vault.
  const secrets: Record<string, string> = {}
  if (secretsRaw && typeof secretsRaw === 'object') {
    for (const [id, enc] of Object.entries(secretsRaw as Record<string, unknown>)) {
      if (typeof enc !== 'string') continue
      try {
        secrets[id] = (await safeStorage.decryptStringAsync(Buffer.from(enc, 'base64'))).result
      } catch {
        /* saved by another Windows user; skip */
      }
    }
  }
  return sanitizeVault({ folders: s.folders, sessions: s.sessions, secrets, knownHosts: hostsRaw })
}

async function deleteLegacy(): Promise<void> {
  const files = legacyFiles()
  await Promise.all(Object.values(files).map((f) => fs.rm(f, { force: true })))
}

class Store {
  private accounts: AccountManager | null = null
  private current: Unlocked | null = null

  private get mgr(): AccountManager {
    this.accounts ??= new AccountManager(path.join(app.getPath('userData'), 'accounts'))
    return this.accounts
  }

  private get u(): Unlocked {
    if (!this.current) throw new SignedOutError()
    return this.current
  }

  private get data(): VaultData {
    return this.u.data
  }

  private persist(): Promise<void> {
    return this.mgr.save(this.u)
  }

  // ---- accounts ------------------------------------------------------------------

  isSignedIn(): boolean {
    return this.current !== null
  }

  username(): string | undefined {
    return this.current?.username
  }

  hasAccounts(): Promise<boolean> {
    return this.mgr.hasAccounts()
  }

  /** How many sessions the first new account will take over from an older version. */
  async legacySessionCount(): Promise<number> {
    if (await this.mgr.hasAccounts()) return 0
    const legacy = await readLegacy()
    return legacy ? legacy.sessions.length : 0
  }

  async create(username: unknown, password: unknown): Promise<void> {
    this.lock()
    const firstAccount = !(await this.mgr.hasAccounts())
    const legacy = firstAccount ? await readLegacy() : null
    const u = await this.mgr.create(username, password, legacy ?? emptyVault())
    if (legacy) {
      // Only delete the old files once the new vault is safely on disk and opens.
      const file = parseVaultFile(
        await fs.readFile(path.join(app.getPath('userData'), 'accounts', `${u.id}.vault.json`), 'utf8')
      )
      const check = sanitizeVault(unseal(file, await deriveKey(String(password), file.kdf)))
      if (check.sessions.length === legacy.sessions.length) await deleteLegacy()
    }
    this.current = u
  }

  async signIn(username: unknown, password: unknown): Promise<void> {
    this.lock()
    this.current = await this.mgr.signIn(username, password)
  }

  async changePassword(current: unknown, next: unknown): Promise<void> {
    await this.mgr.changePassword(this.u, current, next)
  }

  async deleteAccount(password: unknown): Promise<void> {
    await this.mgr.remove(this.u, password)
    this.lock()
  }

  /** Forget the key and all decrypted data. */
  lock(): void {
    if (!this.current) return
    this.current.key.fill(0)
    this.current = null
  }

  // ---- sessions & folders ----------------------------------------------------------

  getAll(): SessionStoreData {
    return {
      version: 1,
      folders: structuredClone(this.data.folders),
      sessions: this.data.sessions.map((s) => ({ ...s, hasSecret: !!this.data.secrets[s.id] }))
    }
  }

  getSession(id: string): Session | undefined {
    return this.data.sessions.find((s) => s.id === id)
  }

  async saveSession(req: SessionSaveRequest): Promise<void> {
    const { hasSecret: _ignored, ...session } = req.session
    const list = this.data.sessions
    const i = list.findIndex((s) => s.id === session.id)
    if (i >= 0) list[i] = session
    else list.push(session)
    if (req.secret !== undefined) this.putSecret(session.id, req.secret)
    await this.persist()
  }

  async deleteSession(id: string): Promise<void> {
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id)
    delete this.data.secrets[id]
    await this.persist()
  }

  async saveFolder(folder: Folder): Promise<void> {
    const list = this.data.folders
    const i = list.findIndex((f) => f.id === folder.id)
    if (i >= 0) list[i] = folder
    else list.push(folder)
    await this.persist()
  }

  /** Delete a folder; its sessions and sub-folders move up to the parent. */
  async deleteFolder(id: string): Promise<void> {
    const d = this.data
    const folder = d.folders.find((f) => f.id === id)
    if (!folder) return
    for (const f of d.folders) if (f.parentId === id) f.parentId = folder.parentId
    for (const s of d.sessions) if (s.folderId === id) s.folderId = folder.parentId
    d.folders = d.folders.filter((f) => f.id !== id)
    await this.persist()
  }

  /** Replace the whole tree (used for drag-and-drop reordering). */
  async replaceAll(next: SessionStoreData): Promise<void> {
    const d = this.data
    const ids = new Set(next.sessions.map((s) => s.id))
    for (const id of Object.keys(d.secrets)) if (!ids.has(id)) delete d.secrets[id]
    d.folders = next.folders
    d.sessions = next.sessions.map(({ hasSecret: _h, ...s }) => s)
    await this.persist()
  }

  // ---- secrets -----------------------------------------------------------------------

  private putSecret(sessionId: string, secret: string): void {
    if (secret) this.data.secrets[sessionId] = secret
    else delete this.data.secrets[sessionId]
  }

  async setSecret(sessionId: string, secret: string): Promise<void> {
    if (!this.getSession(sessionId)) return
    this.putSecret(sessionId, secret)
    await this.persist()
  }

  async getSecret(sessionId: string): Promise<string | undefined> {
    return this.data.secrets[sessionId]
  }

  // ---- host keys ---------------------------------------------------------------------

  getKnownHosts(): Record<string, KnownKey[]> {
    return structuredClone(this.data.knownHosts)
  }

  async setKnownHosts(db: Record<string, KnownKey[]>): Promise<void> {
    this.data.knownHosts = structuredClone(db)
    await this.persist()
  }
}

export const store = new Store()
