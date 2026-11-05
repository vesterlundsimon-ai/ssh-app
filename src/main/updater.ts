// In-app updates from GitHub Releases (electron-updater).
//
// - Checks shortly after start and every 4 hours. Nothing downloads until the user
//   clicks "Update".
// - Downloads only the changed blocks of the installer when possible (differential
//   update via the .blockmap files), and verifies the result against the SHA-512 in
//   the release's latest.yml before installing.
// - Never downgrades and ignores pre-releases.
// - Only runs in the installed app, never in development.

import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '../shared/types'

const { autoUpdater } = electronUpdater

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000
const FIRST_CHECK_MS = 10 * 1000

let status: UpdateStatus = { state: 'idle', currentVersion: app.getVersion() }
let notify: (s: UpdateStatus) => void = () => undefined
let started = false

function set(next: Omit<UpdateStatus, 'currentVersion'>): void {
  status = { ...next, currentVersion: app.getVersion() }
  notify(status)
}

export function updatesSupported(): boolean {
  return app.isPackaged && process.platform === 'win32'
}

export function getUpdateStatus(): UpdateStatus {
  return status
}

export function startUpdater(onChange: (s: UpdateStatus) => void): void {
  notify = onChange
  if (started || !updatesSupported()) return
  started = true

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowDowngrade = false
  autoUpdater.allowPrerelease = false
  autoUpdater.logger = null

  autoUpdater.on('checking-for-update', () => {
    if (status.state !== 'downloading' && status.state !== 'ready') set({ state: 'checking' })
  })
  autoUpdater.on('update-available', (info) => set({ state: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => set({ state: 'idle' }))
  autoUpdater.on('download-progress', (p) =>
    set({ state: 'downloading', version: status.version, percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', version: info.version }))
  autoUpdater.on('error', (err) => {
    // A release without update files (or no network) isn't worth bothering anyone about
    // unless they were in the middle of downloading.
    if (status.state === 'downloading') set({ state: 'error', version: status.version, message: friendly(err) })
    else set({ state: 'idle' })
  })

  setTimeout(() => void check(), FIRST_CHECK_MS)
  setInterval(() => void check(), CHECK_EVERY_MS).unref()
}

function friendly(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err)
  if (/sha512 checksum mismatch/i.test(msg)) return "The download didn't match the release, so it wasn't installed. Try again."
  if (/net::|ENOTFOUND|ETIMEDOUT|ECONNRESET/i.test(msg)) return "Couldn't reach GitHub. Check your connection and try again."
  return 'The update could not be downloaded. Try again later.'
}

/** Check now (from "Check for updates"). A failed check says so instead of claiming you're up to date. */
export async function check(): Promise<UpdateStatus> {
  if (!updatesSupported()) return { ...status, message: 'Updates only work in the installed app.' }
  if (status.state === 'downloading' || status.state === 'ready') return status
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    const msg = (err as Error)?.message ?? ''
    // A release without update files means there's simply nothing to update to yet.
    if (/latest\.yml|404|Cannot find/i.test(msg)) set({ state: 'idle' })
    else return { ...status, message: "Couldn't check for updates. Check your connection and try again." }
  }
  return status
}

export async function download(): Promise<void> {
  if (!updatesSupported() || (status.state !== 'available' && status.state !== 'error')) return
  set({ state: 'downloading', version: status.version, percent: 0 })
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    set({ state: 'error', version: status.version, message: friendly(err) })
  }
}

/** Close the app and run the downloaded installer silently, then start the new version. */
export function install(): void {
  if (status.state !== 'ready') return
  setImmediate(() => autoUpdater.quitAndInstall(true, true))
}
