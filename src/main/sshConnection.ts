// One SSH connection = one terminal tab (+ an SFTP channel opened on demand).
//
// This file deliberately has no Electron imports: everything UI-related goes
// through the `hooks` object, so the connection logic can be tested in plain Node.

import ssh2, { type AnyAuthMethod, type AuthenticationType, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import { promises as fs, existsSync } from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { AuthMethod, ConnState } from '../shared/types'

export interface ConnectionOptions {
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  keyPath?: string
  cols: number
  rows: number
  /** Stored password (password auth) or key passphrase (key auth). */
  secret?: string
  /** Can the "remember" answer be saved? (only for saved sessions) */
  canRemember: boolean
}

export interface PromptAnswer {
  answers: string[] | null
  remember?: boolean
}

export interface ConnectionHooks {
  verifyHost(host: string, port: number, key: Buffer): Promise<boolean>
  prompt(req: {
    title: string
    message?: string
    fields: { label: string; secret: boolean }[]
    allowRemember?: boolean
  }): Promise<PromptAnswer>
  onData(data: Uint8Array): void
  onStatus(state: ConnState, message?: string): void
  saveSecret(secret: string): void
}

const MAX_ATTEMPTS = 3

export function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

/** Which agent to use: Windows OpenSSH agent if running, otherwise Pageant; SSH_AUTH_SOCK elsewhere. */
export function defaultAgent(): string | undefined {
  if (process.platform === 'win32') {
    const pipe = '\\\\.\\pipe\\openssh-ssh-agent'
    return existsSync(pipe) ? pipe : 'pageant'
  }
  return process.env.SSH_AUTH_SOCK
}

export function friendlyError(err: unknown): string {
  const e = err as NodeJS.ErrnoException & { level?: string }
  switch (e?.code) {
    case 'ECONNREFUSED':
      return 'Connection refused. Is the SSH server running on that port?'
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return 'Host not found. Check the hostname.'
    case 'ETIMEDOUT':
      return 'Connection timed out.'
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'Host unreachable. Check your network / VPN.'
    case 'ECONNRESET':
      return 'Connection reset by the server.'
  }
  const msg = e?.message ?? String(err)
  if (/All configured authentication methods failed/i.test(msg)) return 'Authentication failed.'
  if (/Timed out while waiting for handshake/i.test(msg)) return 'Timed out waiting for the server to respond.'
  return msg
}

export class SshConnection {
  readonly client = new ssh2.Client()
  private shell: ClientChannel | null = null
  private sftpPromise: Promise<SFTPWrapper> | null = null
  private closed = false
  private hostRejected = false

  // auth state
  private password: string | undefined
  private passwordAttempts = 0
  private triedPrimary = false
  private triedKeyboard = false
  private pendingRemember: string | undefined
  private lastAuthError = ''

  // output batching (keeps IPC traffic sane when a command prints a lot)
  private outChunks: Buffer[] = []
  private outTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly opts: ConnectionOptions,
    private readonly hooks: ConnectionHooks
  ) {
    if (opts.authMethod === 'password') this.password = opts.secret
  }

  connect(): void {
    this.hooks.onStatus('connecting')
    const c = this.client

    c.on('ready', () => {
      if (this.pendingRemember !== undefined) this.hooks.saveSecret(this.pendingRemember)
      this.openShell()
    })
    c.on('error', (err) => {
      if (this.closed) return
      const msg = this.hostRejected ? 'Host key not trusted. Connection aborted.' : this.lastAuthError || friendlyError(err)
      this.finish('error', msg)
    })
    c.on('close', () => this.finish('closed', 'Connection closed.'))

    const config: ConnectConfig = {
      host: this.opts.host,
      port: this.opts.port,
      username: this.opts.username,
      readyTimeout: 30_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 4,
      tryKeyboard: true,
      hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
        this.hooks.verifyHost(this.opts.host, this.opts.port, key).then(
          (ok) => {
            if (!ok) this.hostRejected = true
            verify(ok)
          },
          () => {
            this.hostRejected = true
            verify(false)
          }
        )
      },
      authHandler: (methodsLeft, partialSuccess, next) => {
        this.nextAuth(methodsLeft, partialSuccess).then(
          (m) => next(m as AnyAuthMethod),
          (err) => {
            this.lastAuthError = friendlyError(err)
            next(false as unknown as AnyAuthMethod)
          }
        )
      }
    }
    try {
      c.connect(config)
    } catch (err) {
      this.finish('error', friendlyError(err))
    }
  }

  // ---- authentication ----------------------------------------------------

  private async nextAuth(
    methodsLeft: AuthenticationType[] | null,
    _partialSuccess: boolean | null
  ): Promise<AnyAuthMethod | false> {
    const username = this.opts.username
    const allowed = (m: AuthenticationType): boolean => !methodsLeft || methodsLeft.includes(m)

    // 1. The method configured on the session.
    if (!this.triedPrimary) {
      this.triedPrimary = true
      if (this.opts.authMethod === 'key') {
        const key = await this.loadKey()
        if (key) return { type: 'publickey', username, key: key.data, passphrase: key.passphrase }
      } else if (this.opts.authMethod === 'agent') {
        const agent = defaultAgent()
        if (agent) return { type: 'agent', username, agent }
        this.lastAuthError = 'No SSH agent found (start Pageant or the OpenSSH Authentication Agent service).'
      } else {
        if (allowed('password')) {
          const pw = await this.getPassword()
          if (pw === null) return this.cancel()
          return { type: 'password', username, password: pw }
        }
      }
    }

    // 2. Keyboard-interactive (many servers use this for passwords and 2FA codes).
    if (allowed('keyboard-interactive') && !this.triedKeyboard) {
      this.triedKeyboard = true
      return {
        type: 'keyboard-interactive',
        username,
        prompt: (_name, instructions, _lang, prompts, finish) => {
          void this.answerKeyboard(instructions, prompts).then(finish)
        }
      }
    }

    // 3. Ask for the password again, a few times.
    if (allowed('password') && this.passwordAttempts < MAX_ATTEMPTS) {
      const pw = await this.askPassword(this.passwordAttempts > 0 || this.opts.authMethod === 'password' ? 'Access denied. Try again.' : undefined)
      if (pw === null) return this.cancel()
      return { type: 'password', username, password: pw }
    }

    if (!this.lastAuthError) this.lastAuthError = 'Authentication failed.'
    return false
  }

  private cancel(): false {
    this.lastAuthError = 'Authentication cancelled.'
    return false
  }

  /** Stored password, or ask for it. null = user cancelled. */
  private async getPassword(): Promise<string | null> {
    if (this.password !== undefined) {
      this.passwordAttempts++
      return this.password
    }
    return this.askPassword()
  }

  private async askPassword(message?: string): Promise<string | null> {
    this.passwordAttempts++
    const res = await this.hooks.prompt({
      title: `Password for ${this.opts.username}@${this.opts.host}`,
      message,
      fields: [{ label: 'Password', secret: true }],
      allowRemember: this.opts.canRemember && this.opts.authMethod === 'password'
    })
    if (!res.answers) return null
    this.password = res.answers[0]
    this.pendingRemember = res.remember ? this.password : undefined
    return this.password
  }

  private async loadKey(): Promise<{ data: Buffer; passphrase?: string } | null> {
    if (!this.opts.keyPath) {
      this.lastAuthError = 'No private key file selected for this session.'
      return null
    }
    let data: Buffer
    try {
      data = await fs.readFile(expandHome(this.opts.keyPath))
    } catch (err) {
      this.lastAuthError = `Could not read key file: ${(err as Error).message}`
      return null
    }

    let parsed = ssh2.utils.parseKey(data)
    if (!(parsed instanceof Error)) return { data }
    if (/^PuTTY-User-Key-File-3/.test(data.toString('utf8', 0, 40))) {
      this.lastAuthError = 'PuTTY v3 keys are not supported. In PuTTYgen choose Conversions → Export OpenSSH key and use that file.'
      return null
    }
    if (!/passphrase|encrypted/i.test(parsed.message)) {
      this.lastAuthError = `Unsupported or invalid key file: ${parsed.message}`
      return null
    }

    // Encrypted key: stored passphrase first, then ask.
    let passphrase = this.opts.secret
    for (let attempt = 0; attempt <= MAX_ATTEMPTS; attempt++) {
      if (passphrase !== undefined) {
        parsed = ssh2.utils.parseKey(data, passphrase)
        if (!(parsed instanceof Error)) return { data, passphrase }
      }
      if (attempt === MAX_ATTEMPTS) break
      const res = await this.hooks.prompt({
        title: 'Key passphrase',
        message:
          (passphrase !== undefined ? 'Wrong passphrase. ' : '') + `Enter the passphrase for ${path.basename(this.opts.keyPath)}`,
        fields: [{ label: 'Passphrase', secret: true }],
        allowRemember: this.opts.canRemember
      })
      if (!res.answers) {
        this.lastAuthError = 'Authentication cancelled.'
        return null
      }
      passphrase = res.answers[0]
      this.pendingRemember = res.remember ? passphrase : undefined
    }
    this.lastAuthError = 'Wrong key passphrase.'
    return null
  }

  private async answerKeyboard(
    instructions: string,
    prompts: { prompt: string; echo?: boolean }[]
  ): Promise<string[]> {
    if (prompts.length === 0) return []
    // A single "Password:" prompt: answer it with the password we already have.
    if (prompts.length === 1 && /pass(word|code)?/i.test(prompts[0].prompt) && !/verif|code|otp|token/i.test(prompts[0].prompt)) {
      const pw = this.password ?? (await this.askPassword())
      return pw === null ? [] : [pw]
    }
    const res = await this.hooks.prompt({
      title: `${this.opts.username}@${this.opts.host}`,
      message: instructions || undefined,
      fields: prompts.map((p) => ({ label: p.prompt.trim(), secret: !p.echo }))
    })
    return res.answers ?? []
  }

  // ---- shell ---------------------------------------------------------------

  private openShell(): void {
    this.client.shell(
      { term: 'xterm-256color', cols: this.opts.cols, rows: this.opts.rows },
      (err, stream) => {
        if (err) {
          this.finish('error', `Could not open a shell: ${err.message}`)
          return
        }
        this.shell = stream
        this.hooks.onStatus('connected')
        stream.on('data', (d: Buffer) => this.queueOutput(d))
        stream.stderr.on('data', (d: Buffer) => this.queueOutput(d))
        stream.on('close', () => this.client.end())
        if (this.earlyInput) {
          stream.write(this.earlyInput)
          this.earlyInput = ''
        }
      }
    )
  }

  private queueOutput(d: Buffer): void {
    this.outChunks.push(d)
    if (!this.outTimer) this.outTimer = setTimeout(() => this.flushOutput(), 8)
  }

  private flushOutput(): void {
    this.outTimer = null
    if (this.outChunks.length === 0) return
    const buf = this.outChunks.length === 1 ? this.outChunks[0] : Buffer.concat(this.outChunks)
    this.outChunks = []
    this.hooks.onData(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
  }

  /** Keystrokes typed while still connecting are kept and sent once the shell opens. */
  private earlyInput = ''

  write(data: string): void {
    if (this.shell) this.shell.write(data)
    else if (!this.closed && this.earlyInput.length < 65536) this.earlyInput += data
  }

  resize(cols: number, rows: number): void {
    this.opts.cols = cols
    this.opts.rows = rows
    this.shell?.setWindow(rows, cols, 0, 0)
  }

  // ---- sftp ----------------------------------------------------------------

  sftp(): Promise<SFTPWrapper> {
    if (this.closed) return Promise.reject(new Error('Not connected.'))
    if (!this.sftpPromise) {
      this.sftpPromise = new Promise((resolve, reject) => {
        this.client.sftp((err, sftp) => {
          if (err) {
            this.sftpPromise = null
            reject(new Error(`SFTP not available on this server: ${err.message}`))
            return
          }
          sftp.on('close', () => (this.sftpPromise = null))
          resolve(sftp)
        })
      })
    }
    return this.sftpPromise
  }

  // ---- teardown --------------------------------------------------------------

  close(): void {
    this.client.end()
  }

  private finish(state: ConnState, message: string): void {
    if (this.closed) return
    this.closed = true
    this.flushOutput()
    this.hooks.onStatus(state, message)
    this.client.end()
  }
}
