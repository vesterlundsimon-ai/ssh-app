// Registry of live xterm instances, keyed by connection id.
// SSH output can arrive before a terminal is mounted, so it is buffered until then.

import type { Terminal } from '@xterm/xterm'

const terms = new Map<string, Terminal>()
const pending = new Map<string, Uint8Array[]>()

export function registerTerminal(id: string, t: Terminal): void {
  terms.set(id, t)
  const queued = pending.get(id)
  if (queued) {
    for (const d of queued) t.write(d)
    pending.delete(id)
  }
}

export function unregisterTerminal(id: string): void {
  terms.delete(id)
  pending.delete(id)
}

export function getTerminal(id: string): Terminal | undefined {
  return terms.get(id)
}

export function writeToTerminal(id: string, data: Uint8Array | string): void {
  const t = terms.get(id)
  if (t) {
    t.write(data)
    return
  }
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const q = pending.get(id) ?? []
  q.push(bytes)
  pending.set(id, q)
}
