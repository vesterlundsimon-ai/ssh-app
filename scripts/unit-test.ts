// Unit tests for the security-relevant helpers (no SSH server needed).
//   npm run test:unit

import * as path from 'path'
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
check('legacy policy adds them after modern ones', algorithmsFor(true).kex.at(-1) === 'diffie-hellman-group1-sha1' && algorithmsFor(true).kex[0] === 'curve25519-sha256')
const pref = algorithmsFor(false, ['ssh-rsa']).serverHostKey
check('known RSA host prefers rsa-sha2, still no ssh-rsa (SHA-1)', pref[0] === 'rsa-sha2-512' && !pref.includes('ssh-rsa'), pref.join(','))
check('known ecdsa host asks for ecdsa first', algorithmsFor(false, ['ecdsa-sha2-nistp256']).serverHostKey[0] === 'ecdsa-sha2-nistp256')

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

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
