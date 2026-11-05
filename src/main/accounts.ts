// Local user accounts. Each account is one encrypted vault file holding that person's
// sessions, folders, saved passwords and trusted host keys. No Electron imports.
//
//   accounts/index.json        – user names and ids (no secrets)
//   accounts/<id>.vault.json   – everything else, encrypted (see ./vault)

import { randomUUID, timingSafeEqual } from 'crypto'
import { promises as fs } from 'fs'
import * as path from 'path'
import type { Folder, Session } from '../shared/types'
import * as v from './validate.ts'
import {
  deriveKey,
  kdfIsCurrent,
  newKdf,
  parseVaultFile,
  seal,
  unseal,
  WrongPasswordError,
  type KdfParams
} from './vault.ts'

export interface KnownKey {
  type: string
  fingerprint: string // SHA256:base64 (OpenSSH style)
  added: string
}

export interface VaultData {
  folders: Folder[]
  sessions: Session[]
  /** sessionId -> password or key passphrase. Only ever stored inside the encrypted vault. */
  secrets: Record<string, string>
  /** "host" or "[host]:port" -> trusted keys */
  knownHosts: Record<string, KnownKey[]>
}

export interface Unlocked {
  id: string
  username: string
  kdf: KdfParams
  key: Buffer
  data: VaultData
}

interface IndexEntry {
  id: string
  username: string
  created: string
}

interface IndexFile {
  version: 1
  accounts: IndexEntry[]
}

export const MIN_PASSWORD = 12
export const MAX_PASSWORD = 256
const USERNAME = /^[\p{L}\p{N}._-]{1,32}$/u

export function emptyVault(): VaultData {
  return { folders: [], sessions: [], secrets: {}, knownHosts: {} }
}

export function checkUsername(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('Enter a user name.')
  const u = raw.trim().normalize('NFC')
  if (!USERNAME.test(u)) throw new Error('User names can have up to 32 letters, digits, dots, dashes and underscores.')
  return u
}

export function checkNewPassword(raw: unknown, username: string): string {
  if (typeof raw !== 'string' || raw.length < MIN_PASSWORD) {
    throw new Error(`Use at least ${MIN_PASSWORD} characters. A few random words work well.`)
  }
  if (raw.length > MAX_PASSWORD) throw new Error(`Use at most ${MAX_PASSWORD} characters.`)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new Error("Passwords can't contain control characters.")
  if (raw.toLowerCase().includes(username.toLowerCase())) throw new Error("Don't put your user name in your password.")
  if (/^(.)\1+$/.test(raw)) throw new Error('Choose a password that is harder to guess.')
  return raw
}

function sameUser(a: string, b: string): boolean {
  return a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase()
}

/**
 * Keep only well-formed entries. The vault is authenticated, so this is about tolerating
 * older or hand-made data rather than attackers; one bad entry shouldn't lock you out.
 */
export function sanitizeVault(raw: unknown): VaultData {
  const d = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const keep = <T>(list: unknown, fn: (x: unknown) => T): T[] =>
    Array.isArray(list)
      ? list.flatMap((x) => {
          try {
            return [fn(x)]
          } catch {
            return []
          }
        })
      : []
  const folders = keep(d.folders, v.folder)
  const folderIds = new Set(folders.map((f) => f.id))
  for (const f of folders) if (f.parentId && !folderIds.has(f.parentId)) f.parentId = null
  const sessions = keep(d.sessions, v.session)
  const sessionIds = new Set(sessions.map((s) => s.id))
  const secrets: Record<string, string> = {}
  if (d.secrets && typeof d.secrets === 'object') {
    for (const [k, val] of Object.entries(d.secrets as Record<string, unknown>)) {
      if (sessionIds.has(k) && typeof val === 'string' && val) secrets[k] = val
    }
  }
  const knownHosts: Record<string, KnownKey[]> = {}
  if (d.knownHosts && typeof d.knownHosts === 'object') {
    for (const [host, keys] of Object.entries(d.knownHosts as Record<string, unknown>)) {
      const good = keep(keys, (k) => {
        const kk = k as KnownKey
        if (typeof kk?.type !== 'string' || typeof kk.fingerprint !== 'string') throw new Error()
        return { type: kk.type, fingerprint: kk.fingerprint, added: String(kk.added ?? '') }
      })
      if (good.length) knownHosts[host] = good
    }
  }
  try {
    v.storeData({ folders, sessions }) // rejects folder cycles
  } catch {
    for (const f of folders) f.parentId = null
  }
  return { folders, sessions, secrets, knownHosts }
}

/** Write atomically (tmp file + rename) so a crash never leaves a half-written file. */
async function writeFileAtomic(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, contents, 'utf8')
  await fs.rename(tmp, file)
}

export class AccountManager {
  private failures = new Map<string, { count: number; until: number }>()
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly dir: string) {}

  private get indexFile(): string {
    return path.join(this.dir, 'index.json')
  }

  private vaultFile(id: string): string {
    return path.join(this.dir, `${v.id(id)}.vault.json`)
  }

  private async readIndex(): Promise<IndexFile> {
    try {
      const idx = JSON.parse(await fs.readFile(this.indexFile, 'utf8')) as IndexFile
      if (!Array.isArray(idx.accounts)) throw new Error()
      return { version: 1, accounts: idx.accounts.filter((a) => typeof a?.id === 'string' && typeof a.username === 'string') }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, accounts: [] }
      throw new Error('The account list is damaged. Your account files are still in the accounts folder.')
    }
  }

  private writeIndex(idx: IndexFile): Promise<void> {
    return writeFileAtomic(this.indexFile, JSON.stringify(idx, null, 2))
  }

  async hasAccounts(): Promise<boolean> {
    return (await this.readIndex()).accounts.length > 0
  }

  async create(rawUsername: unknown, rawPassword: unknown, initial: VaultData = emptyVault()): Promise<Unlocked> {
    const username = checkUsername(rawUsername)
    const password = checkNewPassword(rawPassword, username)
    const idx = await this.readIndex()
    if (idx.accounts.some((a) => sameUser(a.username, username))) throw new Error('That user name is already taken on this PC.')
    const kdf = newKdf()
    const u: Unlocked = { id: randomUUID(), username, kdf, key: await deriveKey(password, kdf), data: sanitizeVault(initial) }
    await this.save(u)
    idx.accounts.push({ id: u.id, username, created: new Date().toISOString() })
    await this.writeIndex(idx)
    return u
  }

  async signIn(rawUsername: unknown, rawPassword: unknown): Promise<Unlocked> {
    const username = typeof rawUsername === 'string' ? rawUsername.trim().normalize('NFC') : ''
    const password = typeof rawPassword === 'string' ? rawPassword : ''
    if (!username || !password) throw new Error('Enter your user name and password.')
    if (password.length > MAX_PASSWORD) throw new WrongPasswordError()

    const throttleKey = username.toLowerCase()
    const f = this.failures.get(throttleKey)
    if (f && Date.now() < f.until) {
      throw new Error(`Too many attempts. Try again in ${Math.ceil((f.until - Date.now()) / 1000)} seconds.`)
    }

    const entry = (await this.readIndex()).accounts.find((a) => sameUser(a.username, username))
    try {
      if (!entry) {
        // Same work as a real attempt, so timing doesn't reveal which user names exist.
        await deriveKey(password, newKdf())
        throw new WrongPasswordError()
      }
      const file = parseVaultFile(await fs.readFile(this.vaultFile(entry.id), 'utf8'))
      if (file.id !== entry.id) throw new Error('The account file belongs to a different account.')
      const key = await deriveKey(password, file.kdf)
      let data: VaultData
      try {
        data = sanitizeVault(unseal(file, key))
      } catch (err) {
        key.fill(0)
        throw err
      }
      this.failures.delete(throttleKey)
      const u: Unlocked = { id: entry.id, username: entry.username, kdf: file.kdf, key, data }
      // Older, weaker key settings are upgraded the first time you sign in.
      if (!kdfIsCurrent(file.kdf)) await this.rekey(u, password)
      return u
    } catch (err) {
      if (err instanceof WrongPasswordError) {
        const count = (f?.count ?? 0) + 1
        const delay = count >= 3 ? Math.min(60, 2 ** (count - 3)) * 1000 : 0
        this.failures.set(throttleKey, { count, until: Date.now() + delay })
      }
      throw err
    }
  }

  /** Encrypt and write the vault. Writes are serialised so quick saves can't interleave. */
  save(u: Unlocked): Promise<void> {
    const file = seal(u.id, u.kdf, u.key, u.data)
    const target = this.vaultFile(u.id)
    const run = this.queue.then(() => writeFileAtomic(target, JSON.stringify(file)))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async rekey(u: Unlocked, password: string): Promise<void> {
    const kdf = newKdf()
    const key = await deriveKey(password, kdf)
    const old = u.key
    u.kdf = kdf
    u.key = key
    await this.save(u)
    old.fill(0)
  }

  private async verifyPassword(u: Unlocked, password: unknown): Promise<void> {
    if (typeof password !== 'string' || !password) throw new WrongPasswordError()
    const key = await deriveKey(password, u.kdf)
    const ok = key.length === u.key.length && timingSafeEqual(key, u.key)
    key.fill(0)
    if (!ok) throw new Error('Your current password is wrong.')
  }

  async changePassword(u: Unlocked, current: unknown, next: unknown): Promise<void> {
    await this.verifyPassword(u, current)
    const password = checkNewPassword(next, u.username)
    if (password === current) throw new Error('The new password is the same as the current one.')
    await this.rekey(u, password)
  }

  async remove(u: Unlocked, password: unknown): Promise<void> {
    await this.verifyPassword(u, password)
    await this.queue
    const idx = await this.readIndex()
    idx.accounts = idx.accounts.filter((a) => a.id !== u.id)
    await this.writeIndex(idx)
    await fs.rm(this.vaultFile(u.id), { force: true })
  }
}
