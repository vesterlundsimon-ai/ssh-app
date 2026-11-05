// The app used to be called Shellport, and Electron keeps app data in a folder named
// after the app: %APPDATA%\Shellport before, %APPDATA%\SimSSH now. On first start
// after the rename, move SimSSH's own files across so nobody's accounts disappear.

import { app } from 'electron'
import { promises as fs } from 'fs'
import * as path from 'path'

/** Our files (not Chromium's caches), oldest format last. */
const ITEMS = ['accounts', 'sessions.json', 'secrets.json', 'known_hosts.json']

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export async function migrateFromShellport(): Promise<void> {
  const newDir = app.getPath('userData')
  const oldDir = path.join(app.getPath('appData'), 'Shellport')
  if (path.resolve(oldDir).toLowerCase() === path.resolve(newDir).toLowerCase()) return

  // Never overwrite: if SimSSH already has data, leave both folders alone.
  for (const item of ITEMS) if (await exists(path.join(newDir, item))) return
  const present: string[] = []
  for (const item of ITEMS) if (await exists(path.join(oldDir, item))) present.push(item)
  if (present.length === 0) return

  try {
    await fs.mkdir(newDir, { recursive: true })
    // Copy to temporary names first, then rename, so a crash can't leave half a copy
    // that would stop the migration from running again.
    for (const item of present) {
      await fs.cp(path.join(oldDir, item), path.join(newDir, `${item}.migrating`), { recursive: true, errorOnExist: true, force: false })
    }
    for (const item of present) await fs.rename(path.join(newDir, `${item}.migrating`), path.join(newDir, item))
  } catch (err) {
    // Clean up and keep using the old data where it is; we'll try again next start.
    for (const item of present) await fs.rm(path.join(newDir, `${item}.migrating`), { recursive: true, force: true })
    console.error('[migrate] could not move data from Shellport:', err)
    return
  }
  // Copied and in place: remove the originals so there's one copy of the vaults.
  for (const item of present) await fs.rm(path.join(oldDir, item), { recursive: true, force: true })
}
