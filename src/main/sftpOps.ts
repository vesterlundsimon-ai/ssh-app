// SFTP operations on top of an ssh2 SFTPWrapper. No Electron imports (testable in Node).

import type { SFTPWrapper, Stats } from 'ssh2'
import { promises as fs } from 'fs'
import * as path from 'path'
import type { RemoteEntry } from '../shared/types'

const posix = path.posix

function p<T>(fn: (cb: (err: Error | null | undefined, res: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, res) => (err ? reject(err) : resolve(res))))
}

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

export function modeString(mode: number): string {
  const type = (mode & S_IFMT) === S_IFDIR ? 'd' : (mode & S_IFMT) === S_IFLNK ? 'l' : '-'
  const bits = 'rwxrwxrwx'
  let out = type
  for (let i = 0; i < 9; i++) out += mode & (1 << (8 - i)) ? bits[i] : '-'
  return out
}

export async function realpath(sftp: SFTPWrapper, dir: string): Promise<string> {
  return p<string>((cb) => sftp.realpath(dir, cb))
}

export async function list(sftp: SFTPWrapper, dir: string): Promise<RemoteEntry[]> {
  const items = await p<{ filename: string; attrs: Stats }[]>((cb) => sftp.readdir(dir, cb))
  const entries = await Promise.all(
    items
      // Drop "." / ".." and anything containing a separator: never valid from a well-behaved server.
      .filter((it) => isSafeRemoteName(it.filename))
      .map(async (it): Promise<RemoteEntry> => {
        const full = posix.join(dir, it.filename)
        const mode = it.attrs.mode ?? 0
        const isLink = (mode & S_IFMT) === S_IFLNK
        let isDir = (mode & S_IFMT) === S_IFDIR
        if (isLink) {
          // Follow the link to find out whether it points to a directory.
          try {
            const target = await p<Stats>((cb) => sftp.stat(full, cb))
            isDir = target.isDirectory()
          } catch {
            /* broken link */
          }
        }
        return {
          name: it.filename,
          path: full,
          isDir,
          isLink,
          size: it.attrs.size ?? 0,
          mtime: (it.attrs.mtime ?? 0) * 1000,
          mode,
          permissions: modeString(mode)
        }
      })
  )
  return entries.sort((a, b) =>
    a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
  )
}

export async function mkdir(sftp: SFTPWrapper, dir: string): Promise<void> {
  await p<void>((cb) => sftp.mkdir(dir, (err) => cb(err, undefined)))
}

export async function rename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  await p<void>((cb) => sftp.rename(from, to, (err) => cb(err, undefined)))
}

export async function chmod(sftp: SFTPWrapper, target: string, mode: number): Promise<void> {
  await p<void>((cb) => sftp.chmod(target, mode, (err) => cb(err, undefined)))
}

/** Delete a file, link or (recursively) a directory. */
export async function remove(sftp: SFTPWrapper, target: string): Promise<void> {
  const st = await p<Stats>((cb) => sftp.lstat(target, cb))
  if (st.isDirectory()) {
    for (const e of await list(sftp, target)) {
      if (e.isLink) await p<void>((cb) => sftp.unlink(e.path, (err) => cb(err, undefined)))
      else await remove(sftp, e.path)
    }
    await p<void>((cb) => sftp.rmdir(target, (err) => cb(err, undefined)))
  } else {
    await p<void>((cb) => sftp.unlink(target, (err) => cb(err, undefined)))
  }
}

async function remoteExists(sftp: SFTPWrapper, target: string): Promise<Stats | null> {
  try {
    return await p<Stats>((cb) => sftp.stat(target, cb))
  } catch {
    return null
  }
}

// ---- transfers ---------------------------------------------------------------

export type ProgressFn = (transferred: number, total: number) => void

interface FileJob {
  from: string
  to: string
  size: number
}

/** Throttle progress callbacks to ~10 per second. */
function throttled(fn: ProgressFn): ProgressFn & { flush: () => void } {
  let last = 0
  let pending: [number, number] | null = null
  const t = ((a: number, b: number) => {
    pending = [a, b]
    const now = Date.now()
    if (now - last >= 100) {
      last = now
      fn(a, b)
      pending = null
    }
  }) as ProgressFn & { flush: () => void }
  t.flush = () => {
    if (pending) fn(...pending)
    pending = null
  }
  return t
}

/** Recursion limits so a symlink loop or a hostile server can't make a transfer run forever. */
export const MAX_DEPTH = 64
export const MAX_FILES = 200_000

/** Upload a local file or folder into remoteDir. Symlinks / junctions inside folders are skipped. */
export async function upload(sftp: SFTPWrapper, localPath: string, remoteDir: string, onProgress: ProgressFn): Promise<void> {
  const jobs: FileJob[] = []
  const dirs: string[] = []

  async function walk(local: string, remote: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) throw new Error(`Folder nesting is deeper than ${MAX_DEPTH} levels: ${local}`)
    if (jobs.length + dirs.length > MAX_FILES) throw new Error(`More than ${MAX_FILES} files; upload a smaller folder.`)
    // The item the user picked may be a link; anything found inside a folder is not followed.
    const st = depth === 0 ? await fs.stat(local) : await fs.lstat(local)
    if (st.isDirectory()) {
      dirs.push(remote)
      for (const name of await fs.readdir(local)) await walk(path.join(local, name), posix.join(remote, name), depth + 1)
    } else if (st.isFile()) {
      jobs.push({ from: local, to: remote, size: st.size })
    }
  }
  const name = path.basename(localPath)
  if (!isSafeRemoteName(name)) throw new Error(`Can't upload an item named “${name}”.`)
  await walk(localPath, posix.join(remoteDir, name), 0)

  for (const d of dirs) {
    const st = await remoteExists(sftp, d)
    if (!st) await mkdir(sftp, d)
    else if (!st.isDirectory()) throw new Error(`${d} exists and is not a folder`)
  }
  await runJobs(jobs, onProgress, (job, step) =>
    p<void>((cb) => sftp.fastPut(job.from, job.to, { step }, (err) => cb(err, undefined)))
  )
}

/**
 * Download a remote file or folder into localDir. Never overwrites: picks "name (1).ext" instead.
 *
 * File names come from the server, so they are untrusted: a malicious server could send
 * names like "..\\..\\Startup\\evil.exe". Every name is made safe for Windows and every
 * destination is checked to be inside the folder the user chose.
 */
export async function download(sftp: SFTPWrapper, remotePath: string, localDir: string, onProgress: ProgressFn): Promise<string> {
  const jobs: FileJob[] = []
  const dirs: string[] = []
  const root = path.resolve(localDir)

  async function walk(remote: string, local: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) throw new Error(`Folder nesting is deeper than ${MAX_DEPTH} levels: ${remote}`)
    if (jobs.length + dirs.length > MAX_FILES) throw new Error(`More than ${MAX_FILES} files; download a smaller folder.`)
    assertInside(root, local)
    const st = await p<Stats>((cb) => sftp.stat(remote, cb))
    if (st.isDirectory()) {
      dirs.push(local)
      for (const e of await list(sftp, remote)) {
        if (e.isLink && e.isDir) continue // don't follow linked folders (loops, surprise size)
        await walk(e.path, path.join(local, safeLocalName(e.name)), depth + 1)
      }
    } else if (st.isFile()) {
      jobs.push({ from: remote, to: local, size: st.size ?? 0 })
    }
  }
  await fs.mkdir(root, { recursive: true })
  const target = await uniqueLocalPath(path.join(root, safeLocalName(posix.basename(remotePath))))
  await walk(remotePath, target, 0)

  for (const d of dirs) await fs.mkdir(d, { recursive: true })
  await runJobs(jobs, onProgress, (job, step) =>
    p<void>((cb) => sftp.fastGet(job.from, job.to, { step }, (err) => cb(err, undefined)))
  )
  return target
}

// ---- name safety --------------------------------------------------------------

/** A single path component that is valid on the server: no separators, no "." / "..". */
export function isSafeRemoteName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && name !== '.' && name !== '..' && !/[/\0]/.test(name)
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i

/** Turn a server-supplied name into one safe file name on Windows (and everywhere else). */
export function safeLocalName(name: string): string {
  let out = name
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '') // Windows strips trailing dots and spaces
  if (out === '' || out === '.' || out === '..' || /^\.+$/.test(out)) out = '_'
  if (WINDOWS_RESERVED.test(out)) out = '_' + out
  if (out.length > 200) {
    const ext = path.extname(out).slice(0, 20)
    out = out.slice(0, 200 - ext.length) + ext
  }
  return out
}

/** Throw unless `child` resolves to somewhere inside `root`. */
export function assertInside(root: string, child: string): void {
  const r = path.resolve(root)
  const c = path.resolve(child)
  const rel = path.relative(r, c)
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return
  throw new Error(`Refusing to write outside the download folder: ${child}`)
}

async function uniqueLocalPath(target: string): Promise<string> {
  const ext = path.extname(target)
  const base = target.slice(0, target.length - ext.length)
  let candidate = target
  for (let i = 1; ; i++) {
    try {
      await fs.access(candidate)
      candidate = `${base} (${i})${ext}`
    } catch {
      return candidate
    }
  }
}

async function runJobs(
  jobs: FileJob[],
  onProgress: ProgressFn,
  run: (job: FileJob, step: (transferred: number, chunk: number, total: number) => void) => Promise<void>
): Promise<void> {
  const total = jobs.reduce((n, j) => n + j.size, 0)
  let done = 0
  const report = throttled(onProgress)
  report(0, total)
  for (const job of jobs) {
    await run(job, (transferred) => report(done + transferred, total))
    done += job.size
    report(done, total)
  }
  report.flush()
  onProgress(done, total)
}
