export function uid(): string {
  return crypto.randomUUID()
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

export function formatDate(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleString(undefined, {
    year: sameYear ? undefined : 'numeric',
    month: 'short',
    day: 'numeric',
    hour: sameYear ? '2-digit' : undefined,
    minute: sameYear ? '2-digit' : undefined,
    hourCycle: 'h23'
  })
}

/** Parse "user@host:port" (port and user optional). */
export function parseQuickConnect(input: string): { username: string; host: string; port: number } | null {
  const m = /^\s*(?:([^@\s]+)@)?(\[[^\]]+\]|[^:\s]+)(?::(\d{1,5}))?\s*$/.exec(input)
  if (!m) return null
  const host = m[2].replace(/^\[|\]$/g, '')
  const port = m[3] ? Number(m[3]) : 22
  if (port < 1 || port > 65535) return null
  return { username: m[1] ?? '', host, port }
}

export const SESSION_COLORS = ['#6cc3d5', '#7fd08a', '#e6c35c', '#e2687a', '#b48ce8', '#8da2b8']

export function joinRemote(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}

export function parentDir(dir: string): string {
  if (dir === '/' || !dir) return '/'
  const trimmed = dir.replace(/\/+$/, '')
  const i = trimmed.lastIndexOf('/')
  return i <= 0 ? '/' : trimmed.slice(0, i)
}
