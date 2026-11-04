// Persistent storage for sessions, folders and secrets.
//
// sessions.json  – plain JSON, no secrets.
// secrets.json   – passwords / key passphrases, each encrypted with Electron's
//                  safeStorage (DPAPI on Windows: only readable by this Windows user).

import { app, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'
import type { Folder, Session, SessionSaveRequest, SessionStoreData } from '../shared/types'

const EMPTY: SessionStoreData = { version: 1, folders: [], sessions: [] }

function dataDir(): string {
  return app.getPath('userData')
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    // Corrupt file: keep a copy so nothing is silently lost, then start fresh.
    try {
      await fs.copyFile(file, `${file}.corrupt-${Date.now()}`)
    } catch {
      /* ignore */
    }
    return fallback
  }
}

/** Write atomically (tmp file + rename) so a crash never leaves a half-written file. */
async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

export async function encryptionAvailable(): Promise<boolean> {
  try {
    return await safeStorage.isAsyncEncryptionAvailable()
  } catch {
    return false
  }
}

class Store {
  private data: SessionStoreData = EMPTY
  private secrets: Record<string, string> = {} // sessionId -> base64(encrypted)
  private loaded = false
  private queue: Promise<void> = Promise.resolve()

  private get sessionsFile(): string {
    return path.join(dataDir(), 'sessions.json')
  }
  private get secretsFile(): string {
    return path.join(dataDir(), 'secrets.json')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.data = await readJson(this.sessionsFile, structuredClone(EMPTY))
    this.data.folders ??= []
    this.data.sessions ??= []
    this.secrets = await readJson(this.secretsFile, {})
    this.loaded = true
  }

  /** Serialise writes so two quick saves can't interleave. */
  private persist(): Promise<void> {
    const snapshot = structuredClone(this.data)
    const secrets = { ...this.secrets }
    this.queue = this.queue.then(async () => {
      await writeJson(this.sessionsFile, snapshot)
      await writeJson(this.secretsFile, secrets)
    })
    return this.queue
  }

  getAll(): SessionStoreData {
    return {
      ...this.data,
      sessions: this.data.sessions.map((s) => ({ ...s, hasSecret: !!this.secrets[s.id] }))
    }
  }

  getSession(id: string): Session | undefined {
    return this.data.sessions.find((s) => s.id === id)
  }

  async saveSession(req: SessionSaveRequest): Promise<void> {
    const { hasSecret: _ignored, ...session } = req.session
    const i = this.data.sessions.findIndex((s) => s.id === session.id)
    if (i >= 0) this.data.sessions[i] = session
    else this.data.sessions.push(session)
    if (req.secret !== undefined) await this.encryptInto(session.id, req.secret)
    await this.persist()
  }

  async deleteSession(id: string): Promise<void> {
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id)
    delete this.secrets[id]
    await this.persist()
  }

  async saveFolder(folder: Folder): Promise<void> {
    const i = this.data.folders.findIndex((f) => f.id === folder.id)
    if (i >= 0) this.data.folders[i] = folder
    else this.data.folders.push(folder)
    await this.persist()
  }

  /** Delete a folder; its sessions and sub-folders move up to the parent. */
  async deleteFolder(id: string): Promise<void> {
    const folder = this.data.folders.find((f) => f.id === id)
    if (!folder) return
    for (const f of this.data.folders) if (f.parentId === id) f.parentId = folder.parentId
    for (const s of this.data.sessions) if (s.folderId === id) s.folderId = folder.parentId
    this.data.folders = this.data.folders.filter((f) => f.id !== id)
    await this.persist()
  }

  /** Replace the whole tree (used for drag-and-drop reordering). */
  async replaceAll(data: SessionStoreData): Promise<void> {
    const ids = new Set(data.sessions.map((s) => s.id))
    for (const id of Object.keys(this.secrets)) if (!ids.has(id)) delete this.secrets[id]
    this.data = {
      version: 1,
      folders: data.folders,
      sessions: data.sessions.map(({ hasSecret: _h, ...s }) => s)
    }
    await this.persist()
  }

  // ---- secrets -------------------------------------------------------------

  private async encryptInto(sessionId: string, secret: string): Promise<void> {
    if (!secret) {
      delete this.secrets[sessionId]
      return
    }
    if (!(await encryptionAvailable())) {
      throw new Error('Secure storage is not available on this system, so the password was not saved.')
    }
    this.secrets[sessionId] = (await safeStorage.encryptStringAsync(secret)).toString('base64')
  }

  async setSecret(sessionId: string, secret: string): Promise<void> {
    await this.encryptInto(sessionId, secret)
    await this.persist()
  }

  async getSecret(sessionId: string): Promise<string | undefined> {
    const enc = this.secrets[sessionId]
    if (!enc) return undefined
    try {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(enc, 'base64'))
      if (shouldReEncrypt) void this.setSecret(sessionId, result)
      return result
    } catch {
      return undefined // e.g. the file was copied from another Windows account
    }
  }
}

export const store = new Store()
