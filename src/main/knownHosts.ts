// Host key verification (trust on first use), stored in known_hosts.json.
//
// First connection to a host: show the fingerprint and ask the user to trust it.
// Later connections: silently accept a matching key; on a mismatch show a loud
// warning (possible man-in-the-middle) and refuse unless the user explicitly
// replaces the stored key.

import { app, BrowserWindow, dialog } from 'electron'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import * as path from 'path'

interface KnownKey {
  type: string
  fingerprint: string // SHA256:base64 (OpenSSH style)
  added: string
}

type KnownHostsFile = Record<string, KnownKey[]>

function file(): string {
  return path.join(app.getPath('userData'), 'known_hosts.json')
}

async function load(): Promise<KnownHostsFile> {
  try {
    return JSON.parse(await fs.readFile(file(), 'utf8')) as KnownHostsFile
  } catch {
    return {}
  }
}

async function save(data: KnownHostsFile): Promise<void> {
  await fs.mkdir(path.dirname(file()), { recursive: true })
  await fs.writeFile(`${file()}.tmp`, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(`${file()}.tmp`, file())
}

/** Key type is the first SSH string inside the raw public key blob. */
export function keyType(raw: Buffer): string {
  try {
    const len = raw.readUInt32BE(0)
    return raw.subarray(4, 4 + len).toString('ascii')
  } catch {
    return 'unknown'
  }
}

export function fingerprint(raw: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')
}

function hostId(host: string, port: number): string {
  return port === 22 ? host.toLowerCase() : `[${host.toLowerCase()}]:${port}`
}

/** Key types already trusted for a host (used to order host key algorithms). */
export async function knownKeyTypes(host: string, port: number): Promise<string[]> {
  return ((await load())[hostId(host, port)] ?? []).map((k) => k.type)
}

/**
 * Returns true if the connection may proceed.
 * `win` is used as the parent for the confirmation dialog.
 */
export async function verifyHostKey(
  host: string,
  port: number,
  raw: Buffer,
  win: BrowserWindow | null
): Promise<boolean> {
  const id = hostId(host, port)
  const type = keyType(raw)
  const fp = fingerprint(raw)
  const db = await load()
  const known = db[id] ?? []

  const sameType = known.find((k) => k.type === type)
  if (sameType && sameType.fingerprint === fp) return true

  const opts = (o: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> =>
    win ? dialog.showMessageBox(win, o) : dialog.showMessageBox(o)

  if (sameType) {
    // Same key type, different key: this is the dangerous case.
    const res = await opts({
      type: 'warning',
      title: 'Host key has changed!',
      message: `WARNING: the host key for ${id} has changed.`,
      detail:
        `Someone could be intercepting this connection (man-in-the-middle attack), ` +
        `or the server was reinstalled.\n\n` +
        `Stored:  ${sameType.fingerprint}\nNow:     ${fp}\nKey type: ${type}\n\n` +
        `Only continue if you know why the key changed.`,
      buttons: ['Disconnect', 'Replace stored key and connect'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (res.response !== 1) return false
    db[id] = known.filter((k) => k.type !== type)
  } else if (known.length > 0) {
    // We know this host, but it presented a key of a type we've never seen for it.
    // That's what a downgrade / MITM attempt looks like, so don't treat it as a first visit.
    const res = await opts({
      type: 'warning',
      title: 'Different host key type',
      message: `${id} presented a different kind of host key than before.`,
      detail:
        `Trusted before:\n${known.map((k) => `  ${k.type}  ${k.fingerprint}`).join('\n')}\n\n` +
        `Presented now:\n  ${type}  ${fp}\n\n` +
        `This can happen after a server upgrade, but it can also mean someone is intercepting the connection. ` +
        `Only continue if you can confirm the new fingerprint with the server's administrator.`,
      buttons: ['Disconnect', 'Trust the new key and connect'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (res.response !== 1) return false
  } else {
    const res = await opts({
      type: 'question',
      title: 'Unknown host',
      message: `First connection to ${id}`,
      detail:
        `The authenticity of this host can't be established yet.\n\n` +
        `${type} key fingerprint:\n${fp}\n\n` +
        `If you trust this host, its key will be remembered and checked on every future connection.`,
      buttons: ['Cancel', 'Trust and connect'],
      defaultId: 1,
      cancelId: 0,
      noLink: true
    })
    if (res.response !== 1) return false
  }

  db[id] = [...(db[id] ?? []), { type, fingerprint: fp, added: new Date().toISOString() }]
  await save(db)
  return true
}
