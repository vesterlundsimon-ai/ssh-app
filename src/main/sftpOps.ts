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
      .filter((it) => it.filename !== '.' && it.filename !== '..')
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

/** Upload a local file or folder into remoteDir. */
export async function upload(sftp: SFTPWrapper, localPath: string, remoteDir: string, onProgress: ProgressFn): Promise<void> {
  const jobs: FileJob[] = []
  const dirs: string[] = []

  async function walk(local: string, remote: string): Promise<void> {
    const st = await fs.stat(local)
    if (st.isDirectory()) {
      dirs.push(remote)
      for (const name of await fs.readdir(local)) await walk(path.join(local, name), posix.join(remote, name))
    } else if (st.isFile()) {
      jobs.push({ from: local, to: remote, size: st.size })
    }
  }
  await walk(localPath, posix.join(remoteDir, path.basename(localPath)))

  for (const d of dirs) {
    const st = await remoteExists(sftp, d)
    if (!st) await mkdir(sftp, d)
    else if (!st.isDirectory()) throw new Error(`${d} exists and is not a folder`)
  }
  await runJobs(jobs, onProgress, (job, step) =>
    p<void>((cb) => sftp.fastPut(job.from, job.to, { step }, (err) => cb(err, undefined)))
  )
}

/** Download a remote file or folder into localDir. Never overwrites: picks "name (1).ext" instead. */
export async function download(sftp: SFTPWrapper, remotePath: string, localDir: string, onProgress: ProgressFn): Promise<string> {
  const jobs: FileJob[] = []
  const dirs: string[] = []

  async function walk(remote: string, local: string): Promise<void> {
    const st = await p<Stats>((cb) => sftp.stat(remote, cb))
    if (st.isDirectory()) {
      dirs.push(local)
      for (const e of await list(sftp, remote)) await walk(e.path, path.join(local, e.name))
    } else {
      jobs.push({ from: remote, to: local, size: st.size ?? 0 })
    }
  }
  await fs.mkdir(localDir, { recursive: true })
  const target = await uniqueLocalPath(path.join(localDir, posix.basename(remotePath)))
  await walk(remotePath, target)

  for (const d of dirs) await fs.mkdir(d, { recursive: true })
  await runJobs(jobs, onProgress, (job, step) =>
    p<void>((cb) => sftp.fastGet(job.from, job.to, { step }, (err) => cb(err, undefined)))
  )
  return target
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
