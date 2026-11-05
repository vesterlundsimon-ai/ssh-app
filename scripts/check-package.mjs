// Fails if the packaged app (dist/win-unpacked) doesn't include the post-quantum ssh2 patch.
import { createRequire } from 'node:module'
import * as path from 'node:path'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const archive = path.join('dist', 'win-unpacked', 'resources', 'app.asar')
const file = path.join('node_modules', 'ssh2', 'lib', 'protocol', 'kex.js')
const kex = asar.extractFile(archive, file).toString('utf8')
if (!kex.includes('simssh-patch: mlkem768x25519-sha256')) {
  console.error(`The packaged ${file} is missing the mlkem768x25519-sha256 patch.`)
  process.exit(1)
}
console.log('Packaged app includes mlkem768x25519-sha256.')
