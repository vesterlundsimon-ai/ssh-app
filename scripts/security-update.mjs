// Daily security check (run by .github/workflows/security.yml, or locally).
//
// 1. Audits the dependencies that ship inside the app (npm audit --omit=dev) and applies
//    every fix npm can make without a breaking (major) upgrade.
// 2. Moves Electron to the newest release of the major version we're on. Electron patch
//    releases carry Chromium / Node.js / V8 security fixes, so staying on the newest one
//    is how Electron apps stay patched.
// 3. Flags what needs a person: vulnerabilities with no compatible fix, or an Electron
//    major that has dropped out of Electron's support window (the newest 3 majors).
// 4. If anything changed, bumps the patch version (0.4.1 -> 0.4.2) so the in-app updater
//    offers it.
//
// Outputs (GitHub Actions step outputs, also printed): changed, version, attention, and
// two Markdown files: release-notes.md and attention.md.

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const SUPPORTED_MAJORS = 3

function npm(args, { allowFail = false } = {}) {
  try {
    return execFileSync(NPM, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  } catch (err) {
    if (allowFail) return err.stdout ?? ''
    throw new Error(`npm ${args.join(' ')} failed:\n${err.stderr ?? err.message}`)
  }
}

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
  return m ? m.slice(1).map(Number) : null
}
function newer(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return false
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

/** Vulnerabilities in what ships with the app (devDependencies are build tools only). */
function shippedVulns() {
  const out = npm(['audit', '--omit=dev', '--json'], { allowFail: true })
  let report
  try {
    report = JSON.parse(out || '{}')
  } catch {
    throw new Error('Could not read the npm audit report.')
  }
  const list = []
  for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
    const advisories = (v.via ?? []).filter((x) => typeof x === 'object')
    list.push({
      name,
      severity: v.severity,
      fix: v.fixAvailable === true ? 'compatible' : v.fixAvailable ? 'breaking' : 'none',
      advisories: advisories.map((a) => ({ title: a.title, url: a.url }))
    })
  }
  return list
}

function describe(v) {
  const adv = v.advisories.map((a) => `[${a.title}](${a.url})`).join(', ')
  return `- **${v.name}** (${v.severity})${adv ? `: ${adv}` : ''}`
}

const notes = []
const attention = []

// ---- 1. shipped dependencies ----------------------------------------------------
const before = shippedVulns()
if (before.length) {
  console.log(`Found ${before.length} vulnerable shipped package(s); applying compatible fixes.`)
  npm(['audit', 'fix', '--ignore-scripts'], { allowFail: true })
  const after = shippedVulns()
  const remaining = new Set(after.map((v) => v.name))
  const fixed = before.filter((v) => !remaining.has(v.name))
  if (fixed.length) notes.push('### Fixed vulnerabilities', ...fixed.map(describe), '')
  if (after.length) {
    attention.push(
      '### Vulnerabilities without a compatible fix',
      'These need a breaking upgrade or have no fix yet, so they were not changed automatically:',
      ...after.map((v) => `${describe(v)}. Fix: ${v.fix === 'breaking' ? 'needs a major upgrade' : 'none published yet'}`),
      ''
    )
  }
}

// ---- 2. Electron ------------------------------------------------------------------
const current = JSON.parse(readFileSync('node_modules/electron/package.json', 'utf8')).version
const major = Number(current.split('.')[0])
const inMajor = JSON.parse(npm(['view', `electron@^${major}.0.0`, 'version', '--json']) || '[]')
const latestInMajor = [inMajor]
  .flat()
  .filter((v) => parseVersion(v))
  .reduce((best, v) => (newer(v, best) ? v : best), current)
if (newer(latestInMajor, current)) {
  console.log(`Updating Electron ${current} -> ${latestInMajor}.`)
  npm(['install', '--save-dev', '--ignore-scripts', `electron@${latestInMajor}`])
  notes.push(
    '### Electron',
    `- Updated Electron ${current} → ${latestInMajor} for the latest Chromium, V8 and Node.js security fixes. ` +
      `[Release notes](https://releases.electronjs.org/release/v${latestInMajor})`,
    ''
  )
}
const latestMajor = Number(npm(['view', 'electron', 'version']).trim().split('.')[0])
if (major <= latestMajor - SUPPORTED_MAJORS) {
  attention.push(
    '### Electron is out of support',
    `SimSSH is on Electron ${major}, but Electron only supports its newest ${SUPPORTED_MAJORS} major versions ` +
      `(${latestMajor - SUPPORTED_MAJORS + 1}–${latestMajor}). Version ${major} gets no more security fixes. ` +
      'A major upgrade needs testing, so it is not done automatically.',
    ''
  )
}

// ---- 3. version bump ------------------------------------------------------------
const changed = notes.length > 0
let version = JSON.parse(readFileSync('package.json', 'utf8')).version
if (changed) {
  version = npm(['version', 'patch', '--no-git-tag-version', '--ignore-scripts']).trim().replace(/^v/, '')
  notes.unshift(`Automatic security update, released by the daily security check.`, '')
}

writeFileSync('release-notes.md', notes.join('\n'))
writeFileSync('attention.md', attention.join('\n'))

const outputs = { changed: String(changed), version, attention: String(attention.length > 0) }
console.log(outputs)
if (notes.length) console.log('\n' + notes.join('\n'))
if (attention.length) console.log('\n' + attention.join('\n'))
if (process.env.GITHUB_OUTPUT) {
  for (const [k, v] of Object.entries(outputs)) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`)
}
