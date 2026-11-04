import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RemoteEntry, TransferProgress } from '../../../shared/types'
import { formatBytes, formatDate, joinRemote, parentDir } from '../lib/util'
import type { MenuState } from './ContextMenu'

export interface TransferItem extends TransferProgress {
  localPath?: string
}

interface Props {
  connId: string | null
  connected: boolean
  tabTitle?: string
  startDir?: string
  transfers: TransferItem[]
  onClearTransfers: () => void
  openMenu: (m: MenuState) => void
}

/** Remember the folder each tab was in, so switching tabs doesn't reset it. */
const cwdByConn = new Map<string, string>()

type SortKey = 'name' | 'size' | 'mtime'

export function SftpPanel({ connId, connected, tabTitle, startDir, transfers, onClearTransfers, openMenu }: Props): React.JSX.Element {
  const [cwd, setCwd] = useState('')
  const [pathInput, setPathInput] = useState('')
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [dropOn, setDropOn] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(true)
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'name', asc: true })
  const listRef = useRef<HTMLDivElement>(null)
  const reqSeq = useRef(0)

  const load = useCallback(
    async (dir: string) => {
      if (!connId) return
      const seq = ++reqSeq.current
      setLoading(true)
      setError('')
      try {
        const list = await window.api.sftp.list(connId, dir)
        if (seq !== reqSeq.current) return
        setEntries(list)
        setCwd(dir)
        setPathInput(dir)
        cwdByConn.set(connId, dir)
        setSelection(new Set())
        setAnchor(null)
      } catch (e) {
        if (seq !== reqSeq.current) return
        setError(cleanError(e))
        setPathInput(cwdByConn.get(connId) ?? dir)
      } finally {
        if (seq === reqSeq.current) setLoading(false)
      }
    },
    [connId]
  )

  // Open the remembered folder, the session's start folder, or home.
  useEffect(() => {
    setEntries([])
    setCwd('')
    setError('')
    setRenaming(null)
    setCreating(false)
    if (!connId || !connected) return
    const remembered = cwdByConn.get(connId)
    if (remembered) {
      void load(remembered)
      return
    }
    setLoading(true)
    window.api.sftp
      .home(connId, startDir)
      .then((home) => load(home))
      .catch((e) => {
        setLoading(false)
        setError(cleanError(e))
      })
  }, [connId, connected, startDir, load])

  // Refresh when an upload into this tab finishes.
  const finishedUploads = transfers.filter((t) => t.connId === connId && t.direction === 'upload' && t.done).length
  useEffect(() => {
    if (finishedUploads > 0 && cwd) void load(cwd)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishedUploads])

  const visible = useMemo(() => {
    const list = showHidden ? entries : entries.filter((e) => !e.name.startsWith('.'))
    const dir = sort.asc ? 1 : -1
    return [...list].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      if (sort.key === 'size') return (a.size - b.size) * dir
      if (sort.key === 'mtime') return (a.mtime - b.mtime) * dir
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) * dir
    })
  }, [entries, showHidden, sort])

  if (!connId) {
    return (
      <div className="sftp-empty">
        <p>Open an SSH tab to browse its files here.</p>
      </div>
    )
  }
  if (!connected) {
    return (
      <div className="sftp-empty">
        <p>{tabTitle} is not connected.</p>
      </div>
    )
  }

  const selectedEntries = visible.filter((e) => selection.has(e.path))

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      setError('')
      await fn()
    } catch (e) {
      setError(cleanError(e))
    }
  }

  const upload = async (localPaths: string[], targetDir: string): Promise<void> => {
    if (!localPaths.length) return
    if (targetDir === cwd) {
      const names = new Set(entries.map((e) => e.name))
      const clashes = localPaths.map((p) => p.split(/[\\/]/).pop()!).filter((n) => names.has(n))
      if (clashes.length && !window.confirm(`Replace ${clashes.length === 1 ? `“${clashes[0]}”` : `${clashes.length} existing items`} in ${cwd}?`)) return
    }
    await run(() => window.api.sftp.upload(connId, localPaths, targetDir))
  }

  const download = (items: RemoteEntry[]): Promise<void> => run(() => window.api.sftp.download(connId, items.map((e) => e.path)))

  const downloadTo = async (items: RemoteEntry[]): Promise<void> => {
    const [dir] = await window.api.sftp.chooseLocal('downloadDir')
    if (dir) await run(() => window.api.sftp.download(connId, items.map((e) => e.path), dir))
  }

  const remove = async (items: RemoteEntry[]): Promise<void> => {
    if (!items.length) return
    const what = items.length === 1 ? `“${items[0].name}”${items[0].isDir ? ' and everything in it' : ''}` : `${items.length} items`
    if (!window.confirm(`Delete ${what}? This can't be undone.`)) return
    await run(async () => {
      await window.api.sftp.remove(connId, items.map((e) => e.path))
      await load(cwd)
    })
  }

  const commitRename = async (entry: RemoteEntry, name: string): Promise<void> => {
    setRenaming(null)
    name = name.trim()
    if (!name || name === entry.name) return
    await run(async () => {
      await window.api.sftp.rename(connId, entry.path, joinRemote(cwd, name))
      await load(cwd)
    })
  }

  const commitMkdir = async (name: string): Promise<void> => {
    setCreating(false)
    name = name.trim()
    if (!name) return
    await run(async () => {
      await window.api.sftp.mkdir(connId, joinRemote(cwd, name))
      await load(cwd)
    })
  }

  const open = (e: RemoteEntry): void => {
    if (e.isDir) void load(e.path)
    else void download([e])
  }

  const clickRow = (e: React.MouseEvent, entry: RemoteEntry): void => {
    if (e.shiftKey && anchor) {
      const a = visible.findIndex((x) => x.path === anchor)
      const b = visible.findIndex((x) => x.path === entry.path)
      const [lo, hi] = a < b ? [a, b] : [b, a]
      setSelection(new Set(visible.slice(lo, hi + 1).map((x) => x.path)))
      return
    }
    if (e.ctrlKey) {
      const next = new Set(selection)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      setSelection(next)
    } else {
      setSelection(new Set([entry.path]))
    }
    setAnchor(entry.path)
  }

  const rowMenu = (e: React.MouseEvent, entry: RemoteEntry): void => {
    e.preventDefault()
    let items = selectedEntries
    if (!selection.has(entry.path)) {
      setSelection(new Set([entry.path]))
      items = [entry]
    }
    const one = items.length === 1
    openMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        ...(one && entry.isDir ? [{ label: 'Open', onClick: () => void load(entry.path) }] : []),
        { label: one ? 'Download' : `Download ${items.length} items`, onClick: () => void download(items) },
        { label: 'Download to…', onClick: () => void downloadTo(items) },
        'separator',
        { label: 'Rename', disabled: !one, onClick: () => setRenaming(entry.path), shortcut: 'F2' },
        { label: 'Copy path', disabled: !one, onClick: () => void navigator.clipboard.writeText(entry.path) },
        'separator',
        { label: one ? 'Delete' : `Delete ${items.length} items`, danger: true, onClick: () => void remove(items), shortcut: 'Del' }
      ]
    })
  }

  const fileDrop = (target: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
      setDropOn(target)
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDropOn(null)
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setDropOn(null)
      const paths = Array.from(e.dataTransfer.files)
        .map((f) => window.api.pathForFile(f))
        .filter(Boolean)
      void upload(paths, target)
    }
  })

  const crumbs = cwd.split('/').filter(Boolean)
  const activeTransfers = transfers.filter((t) => !t.done).length
  const sortHeader = (key: SortKey, label: string, cls: string): React.JSX.Element => (
    <button className={`col ${cls} ${sort.key === key ? 'sorted' : ''}`} onClick={() => setSort((s) => ({ key, asc: s.key === key ? !s.asc : true }))}>
      {label}
      {sort.key === key && <span className={`sort-arrow ${sort.asc ? '' : 'desc'}`} />}
    </button>
  )

  return (
    <div className="sftp">
      <div className="sftp-toolbar">
        <button className="icon-btn" title="Up one folder (Backspace)" disabled={cwd === '/'} onClick={() => void load(parentDir(cwd))}>
          <svg viewBox="0 0 16 16" aria-hidden><path d="M8 13V3 M3.5 7.5 8 3l4.5 4.5" /></svg>
        </button>
        <button className="icon-btn" title="Refresh" onClick={() => void load(cwd)}>
          <svg viewBox="0 0 16 16" aria-hidden><path d="M13 8a5 5 0 1 1-1.5-3.6 M13 2.5v3h-3" /></svg>
        </button>
        <button className="icon-btn" title="New folder" onClick={() => setCreating(true)}>
          <svg viewBox="0 0 16 16" aria-hidden><path d="M1.5 3.5h4l1.5 1.5h7.5v8h-13z M8 7.5v4 M6 9.5h4" /></svg>
        </button>
        <button className="icon-btn" title="Upload files" onClick={async () => void upload(await window.api.sftp.chooseLocal('files'), cwd)}>
          <svg viewBox="0 0 16 16" aria-hidden><path d="M8 11V2.5 M4.5 6 8 2.5 11.5 6 M2.5 11v2.5h11V11" /></svg>
        </button>
        <button className="icon-btn" title="Download selected" disabled={!selectedEntries.length} onClick={() => void download(selectedEntries)}>
          <svg viewBox="0 0 16 16" aria-hidden><path d="M8 2.5V11 M4.5 7.5 8 11l3.5-3.5 M2.5 11v2.5h11V11" /></svg>
        </button>
        <button className="icon-btn" title="Delete selected" disabled={!selectedEntries.length} onClick={() => void remove(selectedEntries)}>
          <svg viewBox="0 0 16 16" aria-hidden><path d="M3 4.5h10 M6.5 4.5V3h3v1.5 M4.5 4.5l.7 9h5.6l.7-9" /></svg>
        </button>
        <span className="spacer" />
        <button className={`icon-btn ${showHidden ? 'on' : ''}`} title={showHidden ? 'Hide dotfiles' : 'Show dotfiles'} onClick={() => setShowHidden((v) => !v)}>
          <svg viewBox="0 0 16 16" aria-hidden><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z M8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z" /></svg>
        </button>
      </div>

      <form
        className="path-bar"
        onSubmit={(e) => {
          e.preventDefault()
          void load(pathInput.trim() || '/')
        }}
      >
        <input value={pathInput} onChange={(e) => setPathInput(e.target.value)} spellCheck={false} title={crumbs.join(' / ')} />
      </form>

      {error && (
        <div className="sftp-error" role="alert">
          {error}
          <button className="link" onClick={() => setError('')}>
            Dismiss
          </button>
        </div>
      )}

      <div className="file-head">
        {sortHeader('name', 'Name', 'c-name')}
        {sortHeader('size', 'Size', 'c-size')}
        {sortHeader('mtime', 'Modified', 'c-date')}
      </div>

      <div
        ref={listRef}
        className={`file-list ${dropOn === cwd ? 'drop' : ''} ${loading ? 'loading' : ''}`}
        tabIndex={0}
        {...fileDrop(cwd)}
        onClick={(e) => e.target === e.currentTarget && setSelection(new Set())}
        onKeyDown={(e) => {
          if (renaming || creating) return
          if (e.key === 'Backspace') void load(parentDir(cwd))
          if (e.key === 'Delete') void remove(selectedEntries)
          if (e.key === 'F2' && selectedEntries.length === 1) setRenaming(selectedEntries[0].path)
          if (e.key === 'F5') void load(cwd)
          if (e.key === 'Enter' && selectedEntries.length === 1) open(selectedEntries[0])
          if (e.ctrlKey && e.key === 'a') {
            e.preventDefault()
            setSelection(new Set(visible.map((x) => x.path)))
          }
        }}
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return
          e.preventDefault()
          openMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
              { label: 'Upload files…', onClick: async () => void upload(await window.api.sftp.chooseLocal('files'), cwd) },
              { label: 'Upload folder…', onClick: async () => void upload(await window.api.sftp.chooseLocal('folder'), cwd) },
              { label: 'New folder', onClick: () => setCreating(true) },
              'separator',
              { label: 'Refresh', onClick: () => void load(cwd), shortcut: 'F5' },
              { label: 'Copy path', onClick: () => void navigator.clipboard.writeText(cwd) }
            ]
          })
        }}
      >
        {creating && (
          <div className="file-row editing">
            <span className="ficon dir" />
            <input
              className="inline-edit"
              autoFocus
              placeholder="New folder"
              onBlur={(e) => void commitMkdir(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setCreating(false)
              }}
            />
          </div>
        )}
        {visible.map((entry) => (
          <div
            key={entry.path}
            className={`file-row ${selection.has(entry.path) ? 'selected' : ''} ${dropOn === entry.path ? 'drop' : ''} ${entry.name.startsWith('.') ? 'hidden-file' : ''}`}
            title={`${entry.permissions}  ${entry.name}`}
            onClick={(e) => clickRow(e, entry)}
            onDoubleClick={() => open(entry)}
            onContextMenu={(e) => rowMenu(e, entry)}
            {...(entry.isDir ? fileDrop(entry.path) : {})}
          >
            <span className={`ficon ${entry.isDir ? 'dir' : 'file'} ${entry.isLink ? 'link' : ''}`} />
            {renaming === entry.path ? (
              <input
                className="inline-edit"
                autoFocus
                defaultValue={entry.name}
                onFocus={(e) => {
                  const dot = entry.isDir ? -1 : entry.name.lastIndexOf('.')
                  e.target.setSelectionRange(0, dot > 0 ? dot : entry.name.length)
                }}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => void commitRename(entry, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setRenaming(null)
                }}
              />
            ) : (
              <span className="c-name">{entry.name}</span>
            )}
            <span className="c-size">{entry.isDir ? '' : formatBytes(entry.size)}</span>
            <span className="c-date">{formatDate(entry.mtime)}</span>
          </div>
        ))}
        {!loading && !error && visible.length === 0 && !creating && (
          <p className="muted pad">This folder is empty. Drop files here to upload them.</p>
        )}
      </div>

      {transfers.length > 0 && (
        <div className="transfers">
          <div className="transfers-head">
            <span>{activeTransfers ? `Transferring ${activeTransfers}` : 'Transfers'}</span>
            <button className="link" onClick={onClearTransfers} disabled={transfers.every((t) => !t.done)}>
              Clear finished
            </button>
          </div>
          {transfers
            .slice(-6)
            .reverse()
            .map((t) => {
              const pct = t.total ? Math.round((t.transferred / t.total) * 100) : t.done ? 100 : 0
              return (
                <div key={t.transferId} className={`transfer ${t.error ? 'failed' : ''} ${t.done ? 'done' : ''}`}>
                  <span className={`dir-mark ${t.direction}`} title={t.direction === 'upload' ? 'Upload' : 'Download'} />
                  <span className="t-name" title={t.error ?? t.name}>
                    {t.name}
                  </span>
                  {t.error ? (
                    <span className="t-status">Failed</span>
                  ) : t.done && t.direction === 'download' && t.localPath ? (
                    <button className="link t-status" onClick={() => window.api.showItemInFolder(t.localPath!)}>
                      Show
                    </button>
                  ) : (
                    <span className="t-status">{t.done ? formatBytes(t.total) : `${pct}%`}</span>
                  )}
                  {!t.done && (
                    <span className="bar">
                      <span style={{ width: `${pct}%` }} />
                    </span>
                  )}
                </div>
              )
            })}
        </div>
      )}
    </div>
  )
}

function cleanError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  // Strip Electron's "Error invoking remote method 'x': Error: " prefix.
  return msg.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}
