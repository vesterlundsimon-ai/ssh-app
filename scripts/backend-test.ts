// Backend test: runs the real SSH/SFTP code against an SSH server.
//
//   TEST_HOST=127.0.0.1 TEST_PORT=2222 TEST_USER=tester TEST_PASSWORD=... \
//   TEST_KEY=/path/id_plain TEST_ENC_KEY=/path/id_enc TEST_KEY_PASS=... npm run test:backend

import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SshConnection, type ConnectionHooks, type ConnectionOptions } from '../src/main/sshConnection.ts'
import * as sftpOps from '../src/main/sftpOps.ts'

const env = (k: string): string => {
  const v = process.env[k]
  if (!v) throw new Error(`Set ${k}`)
  return v
}
const HOST = env('TEST_HOST')
const PORT = Number(process.env.TEST_PORT ?? 22)
const USER = env('TEST_USER')

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!ok) failures++
}

interface Run {
  conn: SshConnection
  output: () => string
  states: string[]
  prompts: string[]
  saved: string[]
  ready: Promise<string> // resolves with final state ('connected' | 'error' | 'closed')
}

function start(opts: Partial<ConnectionOptions>, answers: (string | null)[] = [], trustHost = true, remember = false): Run {
  let out = ''
  const states: string[] = []
  const prompts: string[] = []
  const saved: string[] = []
  let resolveReady!: (s: string) => void
  const ready = new Promise<string>((r) => (resolveReady = r))
  const hooks: ConnectionHooks = {
    verifyHost: async () => trustHost,
    prompt: async (req) => {
      prompts.push(req.title + (req.message ? ` [${req.message}]` : ''))
      const a = answers.shift()
      return a === null || a === undefined ? { answers: null } : { answers: [a], remember }
    },
    onData: (d) => (out += Buffer.from(d).toString('utf8')),
    onStatus: (s, msg) => {
      states.push(msg ? `${s}: ${msg}` : s)
      if (s !== 'connecting') resolveReady(s)
    },
    saveSecret: (s) => saved.push(s)
  }
  const conn = new SshConnection(
    { host: HOST, port: PORT, username: USER, authMethod: 'password', cols: 100, rows: 30, canRemember: true, ...opts },
    hooks
  )
  conn.connect()
  return { conn, output: () => out, states, prompts, saved, ready }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function runCommand(r: Run, marker: string): Promise<boolean> {
  r.conn.write(`echo ${marker}-$((40+2))\n`)
  for (let i = 0; i < 50; i++) {
    if (r.output().includes(`${marker}-42`)) return true
    await sleep(100)
  }
  return false
}

async function main(): Promise<void> {
  // 1. stored password
  {
    const r = start({ secret: env('TEST_PASSWORD') })
    const st = await r.ready
    check('password auth with stored password', st === 'connected', r.states.join(', '))
    check('shell runs commands', await runCommand(r, 'pw'))
    r.conn.resize(120, 40)
    check('no prompt needed', r.prompts.length === 0, r.prompts.join(' | '))

    // SFTP round-trip on the same connection
    const sftp = await r.conn.sftp()
    const home = await sftpOps.realpath(sftp, '.')
    check('sftp realpath home', home.startsWith('/'), home)
    const remoteDir = `${home}/simssh-test-${Date.now()}`
    await sftpOps.mkdir(sftp, remoteDir)

    const local = await fs.mkdtemp(path.join(os.tmpdir(), 'simssh-'))
    const srcDir = path.join(local, 'payload')
    await fs.mkdir(path.join(srcDir, 'nested'), { recursive: true })
    const big = Buffer.alloc(3 * 1024 * 1024 + 123, 7)
    await fs.writeFile(path.join(srcDir, 'big.bin'), big)
    await fs.writeFile(path.join(srcDir, 'nested', 'hello.txt'), 'hello from simssh\n')

    let lastProgress: [number, number] = [0, 0]
    await sftpOps.upload(sftp, srcDir, remoteDir, (t, tot) => (lastProgress = [t, tot]))
    check('upload folder reports full progress', lastProgress[0] === lastProgress[1] && lastProgress[1] === big.length + Buffer.byteLength('hello from simssh\n'), String(lastProgress))

    const listing = await sftpOps.list(sftp, `${remoteDir}/payload`)
    check(
      'list shows uploaded items (dirs first)',
      listing.map((e) => e.name).join(',') === 'nested,big.bin' && listing[0].isDir && listing[1].size === big.length,
      listing.map((e) => `${e.name}:${e.isDir}:${e.size}:${e.permissions}`).join(' ')
    )

    await sftpOps.rename(sftp, `${remoteDir}/payload/big.bin`, `${remoteDir}/payload/renamed.bin`)
    const dlDir = path.join(local, 'downloads')
    await fs.mkdir(dlDir)
    const got = await sftpOps.download(sftp, `${remoteDir}/payload`, dlDir, () => undefined)
    const again = await sftpOps.download(sftp, `${remoteDir}/payload/renamed.bin`, dlDir, () => undefined)
    const again2 = await sftpOps.download(sftp, `${remoteDir}/payload/renamed.bin`, dlDir, () => undefined)
    const dlBig = await fs.readFile(path.join(got, 'renamed.bin'))
    const dlTxt = await fs.readFile(path.join(got, 'nested', 'hello.txt'), 'utf8')
    check('download folder matches', dlBig.equals(big) && dlTxt === 'hello from simssh\n')
    check('download never overwrites', path.basename(again) === 'renamed.bin' && path.basename(again2) === 'renamed (1).bin', `${again} ${again2}`)

    // Hostile file names: a Windows path-traversal name, a reserved device name, a link loop.
    const hostile = `${remoteDir}/hostile`
    await sftpOps.mkdir(sftp, hostile)
    for (const name of ['..\\..\\escaped.txt', 'con', 'ok.txt']) {
      await new Promise<void>((res, rej) =>
        sftp.writeFile(`${hostile}/${name}`, 'x', (err) => (err ? rej(err) : res()))
      )
    }
    await new Promise<void>((res, rej) => sftp.symlink(hostile, `${hostile}/loop`, (err) => (err ? rej(err) : res())))
    const safeDir = path.join(local, 'safe')
    const hostileOut = await sftpOps.download(sftp, hostile, safeDir, () => undefined)
    const names = (await fs.readdir(hostileOut)).sort()
    const escaped = await fs.readdir(local)
    check(
      'download sanitises hostile names and skips link loops',
      names.join(',') === '.._.._escaped.txt,_con,ok.txt' && !escaped.includes('escaped.txt'),
      names.join(',')
    )

    await sftpOps.remove(sftp, remoteDir)
    const after = await sftpOps.list(sftp, home)
    check('recursive delete', !after.some((e) => e.path === remoteDir))
    await fs.rm(local, { recursive: true, force: true })

    r.conn.write('exit\n')
    await sleep(500)
    check('exit closes the session', r.states.some((s) => s.startsWith('closed')), r.states.join(', '))
  }

  // 2. wrong stored password -> asks, then succeeds; remember is saved
  {
    const r = start({ secret: 'wrong' }, [env('TEST_PASSWORD')], true, true)
    const st = await r.ready
    check('wrong saved password → prompt → connected', st === 'connected' && r.prompts.length === 1, `${r.states.join(', ')} | ${r.prompts.join(' | ')}`)
    check('remembered password saved after success', r.saved[0] === env('TEST_PASSWORD'))
    r.conn.close()
  }

  // 3. no password, user cancels
  {
    const r = start({}, [null])
    const st = await r.ready
    check('cancelled prompt ends with error', st === 'error' && /cancel/i.test(r.states.at(-1) ?? ''), r.states.join(', '))
  }

  // 4. plain key
  {
    const r = start({ authMethod: 'key', keyPath: env('TEST_KEY') })
    const st = await r.ready
    check('key auth', st === 'connected' && r.prompts.length === 0, r.states.join(', '))
    check('key auth shell', await runCommand(r, 'key'))
    r.conn.close()
  }

  // 5. encrypted key: wrong passphrase first, then right one
  {
    const r = start({ authMethod: 'key', keyPath: env('TEST_ENC_KEY') }, ['nope', env('TEST_KEY_PASS')], true, true)
    const st = await r.ready
    check('encrypted key asks again after wrong passphrase', st === 'connected' && r.prompts.length === 2, `${r.states.join(', ')} | ${r.prompts.join(' | ')}`)
    check('passphrase remembered', r.saved[0] === env('TEST_KEY_PASS'))
    r.conn.close()
  }

  // 6. stored passphrase
  {
    const r = start({ authMethod: 'key', keyPath: env('TEST_ENC_KEY'), secret: env('TEST_KEY_PASS') })
    check('stored passphrase', (await r.ready) === 'connected' && r.prompts.length === 0, r.states.join(', '))
    r.conn.close()
  }

  // 7. host key rejected
  {
    const r = start({ secret: env('TEST_PASSWORD') }, [], false)
    const st = await r.ready
    check('untrusted host key aborts', st === 'error' && /host key/i.test(r.states.at(-1) ?? ''), r.states.join(', '))
  }

  // 8. connection refused
  {
    const r = start({ port: 1, secret: 'x' })
    const st = await r.ready
    check('refused port gives a clear error', st === 'error' && /refused/i.test(r.states.at(-1) ?? ''), r.states.join(', '))
  }

  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
