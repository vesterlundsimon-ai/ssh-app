// Input validation for everything arriving over IPC.
//
// The UI is our own code, but it renders data from remote servers (terminal output,
// file names). Treating every IPC message as untrusted means a bug in the UI can't
// be turned into "read any file" or "run with arbitrary options" in the main process.

import type { AuthMethod, Folder, Session, SessionSaveRequest, SessionStoreData } from '../shared/types'

export class ValidationError extends Error {}

function fail(what: string): never {
  throw new ValidationError(`Invalid ${what}.`)
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

export function str(v: unknown, what: string, max = 1024, opts: { allowEmpty?: boolean; allowControl?: boolean } = {}): string {
  if (typeof v !== 'string') fail(what)
  if (!opts.allowEmpty && v.length === 0) fail(what)
  if (v.length > max) fail(what)
  if (!opts.allowControl && CONTROL.test(v)) fail(what)
  return v
}

export function optStr(v: unknown, what: string, max = 1024): string | undefined {
  return v === undefined || v === null || v === '' ? undefined : str(v, what, max)
}

export function int(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(what)
  return v
}

export function bool(v: unknown): boolean {
  return v === true
}

export function oneOf<T extends string>(v: unknown, what: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) fail(what)
  return v as T
}

export function strArray(v: unknown, what: string, maxItems: number, maxLen = 4096): string[] {
  if (!Array.isArray(v) || v.length > maxItems) fail(what)
  return v.map((x) => str(x, what, maxLen))
}

const ID = /^[A-Za-z0-9-]{1,64}$/
export function id(v: unknown, what = 'id'): string {
  if (typeof v !== 'string' || !ID.test(v)) fail(what)
  return v
}

/** Host name, IPv4, or IPv6 (optionally with zone). No spaces, no option-like values. */
const HOST = /^(?:[A-Za-z0-9_](?:[A-Za-z0-9_.-]{0,252})|\[?[0-9A-Fa-f:.]+(?:%[A-Za-z0-9._-]+)?\]?)$/
export function host(v: unknown): string {
  const h = str(v, 'host name', 255).trim().replace(/^\[|\]$/g, '')
  if (!HOST.test(h) || h.startsWith('-')) fail('host name')
  return h
}

export function username(v: unknown): string {
  const u = str(v, 'user name', 128)
  if (u.startsWith('-') || /\s/.test(u)) fail('user name')
  return u
}

export function port(v: unknown): number {
  return int(v, 'port', 1, 65535)
}

const AUTH: readonly AuthMethod[] = ['password', 'key', 'agent']
export function authMethod(v: unknown): AuthMethod {
  return oneOf(v, 'login method', AUTH)
}

/** A remote (POSIX) path. */
export function remotePath(v: unknown): string {
  return str(v, 'remote path', 4096)
}

const COLOR = /^#[0-9a-fA-F]{6}$/

export function session(v: unknown): Session {
  if (!v || typeof v !== 'object') fail('session')
  const s = v as Record<string, unknown>
  return {
    id: id(s.id, 'session id'),
    name: str(s.name, 'session name', 200),
    folderId: s.folderId == null ? null : id(s.folderId, 'folder id'),
    host: host(s.host),
    port: port(s.port),
    username: username(s.username),
    authMethod: authMethod(s.authMethod),
    keyPath: optStr(s.keyPath, 'key path', 1024),
    color: s.color == null ? undefined : COLOR.test(String(s.color)) ? String(s.color) : fail('colour'),
    notes: s.notes == null || s.notes === '' ? undefined : str(s.notes, 'notes', 4000, { allowControl: true }),
    sftpStartDir: optStr(s.sftpStartDir, 'start folder', 4096),
    legacyAlgorithms: bool(s.legacyAlgorithms) || undefined
  }
}

export function sessionSave(v: unknown): SessionSaveRequest {
  if (!v || typeof v !== 'object') fail('request')
  const r = v as Record<string, unknown>
  return {
    session: session(r.session),
    secret: r.secret === undefined ? undefined : str(r.secret, 'password', 4096, { allowEmpty: true })
  }
}

export function folder(v: unknown): Folder {
  if (!v || typeof v !== 'object') fail('folder')
  const f = v as Record<string, unknown>
  return {
    id: id(f.id, 'folder id'),
    name: str(f.name, 'folder name', 200),
    parentId: f.parentId == null ? null : id(f.parentId, 'folder id'),
    collapsed: bool(f.collapsed) || undefined
  }
}

export function storeData(v: unknown): SessionStoreData {
  if (!v || typeof v !== 'object') fail('session list')
  const d = v as Record<string, unknown>
  if (!Array.isArray(d.folders) || !Array.isArray(d.sessions)) fail('session list')
  if (d.folders.length > 5000 || d.sessions.length > 20000) fail('session list')
  const folders = d.folders.map(folder)
  // Reject parent cycles (a folder inside itself), which would hang the tree.
  const byId = new Map(folders.map((f) => [f.id, f]))
  for (const f of folders) {
    const seen = new Set<string>()
    for (let cur: Folder | undefined = f; cur?.parentId; cur = byId.get(cur.parentId)) {
      if (seen.has(cur.id)) fail('folder structure')
      seen.add(cur.id)
    }
  }
  return { version: 1, folders, sessions: d.sessions.map(session) }
}
