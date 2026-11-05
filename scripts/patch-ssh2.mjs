// Adds the hybrid post-quantum key exchange mlkem768x25519-sha256 to ssh2.
//
// ssh2 keeps its key exchange code private, so this script patches the installed copy
// in node_modules. It runs before every build, dev run and test. It's idempotent, and it
// refuses to run against any ssh2 version other than the one it was written and tested
// for, so an ssh2 update can't silently drop or break it.
//
// The method (as specified in draft-ietf-sshm-mlkem-hybrid-kex and used by default in
// OpenSSH 10):
//   C_INIT  (client -> server) = ML-KEM-768 public key (1184 bytes) || X25519 public key (32)
//   S_REPLY (server -> client) = ML-KEM-768 ciphertext (1088 bytes) || X25519 public key (32)
//   K = SHA-256(ML-KEM shared secret || X25519 shared secret), encoded as an SSH string
// Messages and exchange hash are otherwise those of curve25519-sha256 (RFC 8731).
// ML-KEM comes from the runtime's native crypto (Electron / Node.js 24), not from JS code.

import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'

const EXPECTED_VERSION = '1.17.0'
const MARK = '/* simssh-patch: mlkem768x25519-sha256 */'

const require = createRequire(import.meta.url)
const pkgPath = require.resolve('ssh2/package.json')
const root = path.dirname(pkgPath)
const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version
if (version !== EXPECTED_VERSION) {
  console.error(
    `patch-ssh2: ssh2 is ${version}, but this patch was written for ${EXPECTED_VERSION}.\n` +
      'Review scripts/patch-ssh2.mjs against the new ssh2 release, update EXPECTED_VERSION, and run the tests.'
  )
  process.exit(1)
}

function patch(file, edits) {
  const full = path.join(root, file)
  let src = readFileSync(full, 'utf8')
  if (src.includes(MARK)) return false
  for (const [anchor, replacement] of edits) {
    const count = src.split(anchor).length - 1
    if (count !== 1) {
      console.error(`patch-ssh2: expected exactly one "${anchor.trim().slice(0, 60)}" in ${file}, found ${count}.`)
      process.exit(1)
    }
    src = src.replace(anchor, replacement)
  }
  writeFileSync(full, src)
  return true
}

// ---- constants.js: advertise the method when the runtime has ML-KEM-768 ---------------
const constantsChanged = patch('lib/protocol/constants.js', [
  [
    'const SUPPORTED_KEX = DEFAULT_KEX.concat([',
    `${MARK}
const mlkem768Supported = (() => {
  try {
    if (!curve25519Supported
        || typeof crypto.encapsulate !== 'function'
        || typeof crypto.decapsulate !== 'function') {
      return false;
    }
    crypto.generateKeyPairSync('ml-kem-768');
    return true;
  } catch {
    return false;
  }
})();
if (mlkem768Supported)
  DEFAULT_KEX.unshift('mlkem768x25519-sha256');
const SUPPORTED_KEX = DEFAULT_KEX.concat([`
  ]
])

// ---- kex.js: the exchange itself -------------------------------------------------------
const kexChanged = patch('lib/protocol/kex.js', [
  [
    `  return (negotiated, ...args) => {
    if (typeof negotiated !== 'object' || negotiated === null)`,
    `  ${MARK}
  const MLKEM768_SPKI_PREFIX =
    Buffer.from('308204b2300b0609608648016503040402038204a100', 'hex');
  const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
  const MLKEM768_PUBLIC_LEN = 1184;
  const MLKEM768_CIPHERTEXT_LEN = 1088;
  const X25519_LEN = 32;

  class MLKEM768X25519Exchange extends KeyExchange {
    constructor(...args) {
      super(...args);

      this.type = 'mlkem768x25519';
      this.hashName = 'sha256';
      this._x25519 = null;
      this._mlkem = null;
      this._serverCiphertext = null;
    }
    generateKeys() {
      if (!this._x25519)
        this._x25519 = generateKeyPairSync('x25519');
      if (!this._protocol._server && !this._mlkem)
        this._mlkem = generateKeyPairSync('ml-kem-768');
    }
    getPublicKey() {
      this.generateKeys();
      const x25519 = this._x25519.publicKey
        .export({ type: 'spki', format: 'der' })
        .subarray(-X25519_LEN);
      if (this._protocol._server) {
        // S_REPLY: the ciphertext exists once computeSecret() has run.
        if (!this._serverCiphertext)
          throw new Error('ML-KEM ciphertext not computed yet');
        return Buffer.concat([this._serverCiphertext, x25519]);
      }
      // C_INIT
      const mlkem = this._mlkem.publicKey
        .export({ type: 'spki', format: 'der' })
        .subarray(-MLKEM768_PUBLIC_LEN);
      return Buffer.concat([mlkem, x25519]);
    }
    convertPublicKey(key) {
      return key;
    }
    computeSecret(peerData) {
      this.generateKeys();
      try {
        const isServer = this._protocol._server;
        const pqLen = (isServer ? MLKEM768_PUBLIC_LEN : MLKEM768_CIPHERTEXT_LEN);
        if (!Buffer.isBuffer(peerData) || peerData.length !== pqLen + X25519_LEN) {
          throw new Error(
            \`Invalid \${isServer ? 'C_INIT' : 'S_REPLY'} length: \${peerData && peerData.length}\`
          );
        }
        const pq = peerData.subarray(0, pqLen);
        const peerX25519 = peerData.subarray(pqLen);

        let pqSecret;
        if (isServer) {
          const result = crypto.encapsulate(createPublicKey({
            key: Buffer.concat([MLKEM768_SPKI_PREFIX, pq]),
            type: 'spki',
            format: 'der',
          }));
          this._serverCiphertext = result.ciphertext;
          pqSecret = result.sharedKey;
        } else {
          pqSecret = crypto.decapsulate(this._mlkem.privateKey, pq);
        }

        const classicSecret = diffieHellman({
          privateKey: this._x25519.privateKey,
          publicKey: createPublicKey({
            key: Buffer.concat([X25519_SPKI_PREFIX, peerX25519]),
            type: 'spki',
            format: 'der',
          }),
        });
        if (classicSecret.every((b) => b === 0))
          throw new Error('X25519 shared secret is all zeroes');

        const secret = createHash('sha256')
          .update(pqSecret)
          .update(classicSecret)
          .digest();
        pqSecret.fill(0);
        classicSecret.fill(0);
        // Raw 32 bytes: finish() and generateKEXVal() encode it as an SSH string.
        return secret;
      } catch (ex) {
        return ex;
      }
    }
  }

  return (negotiated, ...args) => {
    if (typeof negotiated !== 'object' || negotiated === null)`
  ],
  [
    `        case 'curve25519-sha256':
        case 'curve25519-sha256@libssh.org':
          if (!curve25519Supported)`,
    `        case 'mlkem768x25519-sha256':
          return new MLKEM768X25519Exchange(...args);

        case 'curve25519-sha256':
        case 'curve25519-sha256@libssh.org':
          if (!curve25519Supported)`
  ],
  [
    `} = require('crypto');`,
    `} = require('crypto');
const crypto = require('crypto');`
  ]
])

console.log(constantsChanged || kexChanged ? 'patch-ssh2: added mlkem768x25519-sha256' : 'patch-ssh2: already applied')
