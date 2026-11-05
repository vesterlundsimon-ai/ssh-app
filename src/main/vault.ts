// Password-encrypted vault file. No Electron imports (testable in plain Node).
//
// Key   = scrypt(password, random salt), N=2^17 r=8 p=1 (OWASP's recommended scrypt
//         setting; ~0.5 s per attempt, which makes offline guessing expensive).
// Data  = AES-256-GCM with a fresh random 96-bit IV on every write. The file header
//         (format, account id, KDF parameters) is bound in as additional authenticated
//         data, so any change to the file, header or body, makes it fail to open.

import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from 'crypto'

export interface KdfParams {
  name: 'scrypt'
  N: number
  r: number
  p: number
  salt: string // base64
}

export interface VaultFile {
  format: 'shellport-vault'
  version: 1
  id: string
  kdf: KdfParams
  iv: string // base64
  tag: string // base64
  data: string // base64 ciphertext
}

export const DEFAULT_KDF = { N: 2 ** 17, r: 8, p: 1 } as const
const KEY_BYTES = 32
const MAXMEM = 256 * 1024 * 1024

export class WrongPasswordError extends Error {
  constructor() {
    super('Wrong user name or password.')
  }
}

export class CorruptVaultError extends Error {}

export function newKdf(): KdfParams {
  return { name: 'scrypt', ...DEFAULT_KDF, salt: randomBytes(16).toString('base64') }
}

export function kdfIsCurrent(kdf: KdfParams): boolean {
  return kdf.N >= DEFAULT_KDF.N && kdf.r >= DEFAULT_KDF.r
}

function checkKdf(kdf: KdfParams): void {
  const salt = Buffer.from(kdf?.salt ?? '', 'base64')
  const ok =
    kdf?.name === 'scrypt' &&
    Number.isInteger(kdf.N) &&
    kdf.N >= 2 ** 14 &&
    kdf.N <= 2 ** 20 &&
    (kdf.N & (kdf.N - 1)) === 0 &&
    Number.isInteger(kdf.r) &&
    kdf.r >= 1 &&
    kdf.r <= 32 &&
    Number.isInteger(kdf.p) &&
    kdf.p >= 1 &&
    kdf.p <= 16 &&
    salt.length >= 16 &&
    salt.length <= 64
  if (!ok) throw new CorruptVaultError('The account file has invalid key settings.')
}

export function deriveKey(password: string, kdf: KdfParams): Promise<Buffer> {
  checkKdf(kdf)
  return new Promise((resolve, reject) =>
    scryptCb(
      Buffer.from(password.normalize('NFC'), 'utf8'),
      Buffer.from(kdf.salt, 'base64'),
      KEY_BYTES,
      { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key))
    )
  )
}

function aad(id: string, kdf: KdfParams): Buffer {
  return Buffer.from(JSON.stringify(['shellport-vault', 1, id, kdf.name, kdf.N, kdf.r, kdf.p, kdf.salt]), 'utf8')
}

export function seal(id: string, kdf: KdfParams, key: Buffer, payload: unknown): VaultFile {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad(id, kdf))
  const plain = Buffer.from(JSON.stringify(payload), 'utf8')
  const data = Buffer.concat([cipher.update(plain), cipher.final()])
  plain.fill(0)
  return {
    format: 'shellport-vault',
    version: 1,
    id,
    kdf,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  }
}

/** Decrypt a vault. Throws WrongPasswordError if the key is wrong or the file was changed. */
export function unseal(file: VaultFile, key: Buffer): unknown {
  const iv = Buffer.from(file.iv, 'base64')
  const tag = Buffer.from(file.tag, 'base64')
  if (iv.length !== 12 || tag.length !== 16) throw new CorruptVaultError('The account file is damaged.')
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
  decipher.setAAD(aad(file.id, file.kdf))
  decipher.setAuthTag(tag)
  let plain: Buffer
  try {
    plain = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()])
  } catch {
    throw new WrongPasswordError()
  }
  try {
    return JSON.parse(plain.toString('utf8'))
  } finally {
    plain.fill(0)
  }
}

export function parseVaultFile(raw: string): VaultFile {
  let f: VaultFile
  try {
    f = JSON.parse(raw) as VaultFile
  } catch {
    throw new CorruptVaultError('The account file is damaged.')
  }
  if (
    f?.format !== 'shellport-vault' ||
    f.version !== 1 ||
    typeof f.id !== 'string' ||
    typeof f.iv !== 'string' ||
    typeof f.tag !== 'string' ||
    typeof f.data !== 'string'
  ) {
    throw new CorruptVaultError('The account file is damaged or from a newer version of Shellport.')
  }
  checkKdf(f.kdf)
  return f
}
