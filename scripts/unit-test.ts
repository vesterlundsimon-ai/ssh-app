// Unit tests for the security-relevant helpers (no SSH server needed).
//   npm run test:unit

import * as path from 'path'
import * as os from 'os'
import { promises as fs } from 'fs'
import { AccountManager, emptyVault } from '../src/main/accounts.ts'
import { safeLocalName, assertInside, isSafeRemoteName } from '../src/main/sftpOps.ts'
import { algorithmsFor, MODERN_ALGORITHMS } from '../src/main/sshConnection.ts'
import * as v from '../src/main/validate.ts'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!ok) failures++
}
function throws(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

// ---- local file names from a (possibly malicious) server ------------------------
const evil: [string, (out: string) => boolean][] = [
  ['..', (o) => o === '_'],
  ['.', (o) => o === '_'],
  ['...', (o) => o === '_'],
  ['..\\..\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.exe', (o) => !/[\\/]/.test(o)],
  ['C:\\Windows\\system32\\evil.dll', (o) => !/[\\/:]/.test(o)],
  ['a/b', (o) => o === 'a_b'],
  ['con', (o) => o === '_con'],
  ['NUL.txt', (o) => o === '_NUL.txt'],
  ['com1', (o) => o === '_com1'],
  ['file.txt.', (o) => o === 'file.txt'],
  ['trailing space ', (o) => o === 'trailing space'],
  ['bad\u0000name\u001b[31m', (o) => !/[\u0000-\u001f]/.test(o)],
  ['x'.repeat(400) + '.tar.gz', (o) => o.length <= 200 && o.endsWith('.gz')],
  ['normal-file_1.txt', (o) => o === 'normal-file_1.txt']
]
for (const [input, ok] of evil) {
  const out = safeLocalName(input)
  check(`safeLocalName(${JSON.stringify(input.slice(0, 40))})`, ok(out) && out.length > 0, JSON.stringify(out))
}

const root = path.resolve('/tmp/dl-root')
check('assertInside accepts children', !throws(() => assertInside(root, path.join(root, 'a', 'b.txt'))))
check('assertInside rejects ..', throws(() => assertInside(root, path.join(root, '..', 'x'))))
check('assertInside rejects sibling prefix', throws(() => assertInside(root, root + '-evil/x')))
check('assertInside rejects absolute elsewhere', throws(() => assertInside(root, path.resolve('/etc/passwd'))))

check('remote names: rejects ..', !isSafeRemoteName('..') && !isSafeRemoteName('.') && !isSafeRemoteName('a/b') && !isSafeRemoteName(''))
check('remote names: accepts normal', isSafeRemoteName('.bashrc') && isSafeRemoteName('my file.txt'))

// ---- algorithm policy -------------------------------------------------------------
const flat = (a: typeof MODERN_ALGORITHMS): string[] => Object.values(a).flat()
const modern = flat(algorithmsFor(false))
check('modern policy has no SHA-1 / CBC / ssh-rsa / DSA', !modern.some((x) => /sha1|cbc|^ssh-rsa$|ssh-dss|3des|md5/.test(x)), modern.filter((x) => /sha1|cbc|^ssh-rsa$|dss/.test(x)).join(','))
check('legacy policy adds them after modern ones', algorithmsFor(true).kex.at(-1) === 'diffie-hellman-group1-sha1' && algorithmsFor(true).kex[0] === algorithmsFor(false).kex[0])
const pref = algorithmsFor(false, ['ssh-rsa']).serverHostKey
check('known RSA host prefers rsa-sha2, still no ssh-rsa (SHA-1)', pref[0] === 'rsa-sha2-512' && !pref.includes('ssh-rsa'), pref.join(','))
check('known ecdsa host asks for ecdsa first', algorithmsFor(false, ['ecdsa-sha2-nistp256']).serverHostKey[0] === 'ecdsa-sha2-nistp256')

// ---- post-quantum key exchange ----------------------------------------------------------
{
  const nodeCrypto = await import('node:crypto')
  const hasMlkem = typeof (nodeCrypto as unknown as { encapsulate?: unknown }).encapsulate === 'function'
  const kex = algorithmsFor(false).kex
  if (hasMlkem) {
    check('post-quantum kex is offered first', kex[0] === 'mlkem768x25519-sha256', kex.slice(0, 3).join(','))
  } else {
    console.log('SKIP  post-quantum kex (this Node.js has no ML-KEM; Electron and Node 24 do)')
  }
  check('Curve25519 stays as the fallback', kex.includes('curve25519-sha256'))
}

// ---- IPC validation ------------------------------------------------------------------
check('host: accepts names and IPs', ['server.example.com', '10.0.0.1', '::1', '[fe80::1%eth0]', 'my_host'].every((h) => !throws(() => v.host(h))))
check('host: rejects option-like and junk', ['-oProxyCommand=calc', 'a b', 'host;rm', '', 'x'.repeat(300), 'a\nb'].every((h) => throws(() => v.host(h))))
check('user: rejects option-like / spaces', throws(() => v.username('-l root')) && throws(() => v.username('a b')) && !throws(() => v.username('deploy')))
check('port range', throws(() => v.port(0)) && throws(() => v.port(70000)) && throws(() => v.port('22')) && !throws(() => v.port(2222)))
check('id format', throws(() => v.id('../x')) && throws(() => v.id('__proto__')) && !throws(() => v.id(crypto.randomUUID())))
const base = { id: 's1', name: 'n', folderId: null, host: 'h', port: 22, username: 'u', authMethod: 'password' }
check('session: valid passes, extra fields dropped', JSON.stringify(Object.keys(v.session({ ...base, evil: 1 }))).indexOf('evil') < 0)
check('session: bad colour rejected', throws(() => v.session({ ...base, color: 'red;background:url(x)' })))
check('session: bad auth method rejected', throws(() => v.session({ ...base, authMethod: 'none' })))
check(
  'store: folder cycle rejected',
  throws(() =>
    v.storeData({
      folders: [
        { id: 'a', name: 'A', parentId: 'b' },
        { id: 'b', name: 'B', parentId: 'a' }
      ],
      sessions: []
    })
  )
)

// ---- accounts / vault -------------------------------------------------------------------
async function rejects(p: Promise<unknown>, re?: RegExp): Promise<boolean> {
  try {
    await p
    return false
  } catch (e) {
    return re ? re.test((e as Error).message) : true
  }
}

async function accountTests(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'simssh-acct-'))
  const mgr = new AccountManager(dir)
  const pw = 'correct horse battery staple'
  const data = emptyVault()
  data.sessions.push({ id: 's1', name: 'prod db', folderId: null, host: 'db.internal.example', port: 22, username: 'root', authMethod: 'password' })
  data.secrets.s1 = 'super-secret-db-password'
  data.knownHosts['db.internal.example'] = [{ type: 'ssh-ed25519', fingerprint: 'SHA256:abc', added: '' }]

  check('rejects short password', await rejects(mgr.create('simon', 'short'), /at least 12/))
  check('rejects password containing user name', await rejects(mgr.create('simon', 'simon-is-great-123'), /user name/))
  check('rejects bad user name', await rejects(mgr.create('../evil', pw), /User names/))

  const u = await mgr.create('Simon', pw, data)
  check('create account', u.username === 'Simon' && u.data.sessions.length === 1)
  check('user names are case-insensitive and unique', await rejects(mgr.create('simon', pw + '!'), /taken/))

  const raw = await fs.readFile(path.join(dir, `${u.id}.vault.json`), 'utf8')
  check('vault file has no plaintext', !/db\.internal|super-secret|prod db|root|SHA256:abc/.test(raw))

  check('wrong password rejected', await rejects(mgr.signIn('simon', pw + 'x'), /Wrong user name or password/))
  check('unknown user gives the same error', await rejects(mgr.signIn('nobody', pw), /Wrong user name or password/))

  const again = await mgr.signIn('SIMON', pw)
  check('sign in decrypts data', again.data.secrets.s1 === 'super-secret-db-password' && again.data.knownHosts['db.internal.example'][0].type === 'ssh-ed25519')

  // Tampering with the ciphertext or the header makes the vault refuse to open.
  const file = JSON.parse(raw)
  const flipped = Buffer.from(file.data, 'base64')
  flipped[5] ^= 1
  await fs.writeFile(path.join(dir, `${u.id}.vault.json`), JSON.stringify({ ...file, data: flipped.toString('base64') }))
  check('tampered ciphertext rejected', await rejects(mgr.signIn('simon', pw)))
  await fs.writeFile(path.join(dir, `${u.id}.vault.json`), JSON.stringify({ ...file, kdf: { ...file.kdf, N: 2 ** 16 } }))
  check('tampered header rejected', await rejects(mgr.signIn('simon', pw)))
  await fs.writeFile(path.join(dir, `${u.id}.vault.json`), raw)

  // Second account can't read the first one's data.
  const other = await mgr.create('friend', 'another long passphrase here')
  check('second account starts empty', other.data.sessions.length === 0)
  const otherFile = path.join(dir, `${other.id}.vault.json`)
  await fs.copyFile(path.join(dir, `${u.id}.vault.json`), otherFile)
  check("swapping in another account's vault is rejected", await rejects(mgr.signIn('friend', 'another long passphrase here')))
  await mgr.save(other)

  // Change password.
  check('change password needs the current one', await rejects(mgr.changePassword(again, 'nope', 'brand new passphrase 2026'), /current password/))
  await mgr.changePassword(again, pw, 'brand new passphrase 2026')
  check('old password stops working', await rejects(mgr.signIn('simon', pw)))
  await new Promise((r) => setTimeout(r, 2100)) // the failed attempts above trigger a short wait
  const after = await mgr.signIn('simon', 'brand new passphrase 2026')
  check('new password works, data kept', after.data.secrets.s1 === 'super-secret-db-password')

  // Throttling after repeated failures.
  for (let i = 0; i < 3; i++) await rejects(mgr.signIn('friend', 'wrong wrong wrong'))
  check('repeated failures are throttled', await rejects(mgr.signIn('friend', 'another long passphrase here'), /Too many attempts/))

  // Delete.
  check('delete needs the password', await rejects(mgr.remove(after, 'nope')))
  await mgr.remove(after, 'brand new passphrase 2026')
  check('deleted account is gone', (await rejects(mgr.signIn('simon', 'brand new passphrase 2026'))) && (await mgr.hasAccounts()))
  const files = await fs.readdir(dir)
  check('deleted vault file removed', !files.includes(`${u.id}.vault.json`), files.join(','))

  await fs.rm(dir, { recursive: true, force: true })
}

await accountTests()

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
