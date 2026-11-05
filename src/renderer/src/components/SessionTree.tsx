import { useMemo, useState } from 'react'
import type { Folder, Session, SessionStoreData } from '../../../shared/types'
import type { MenuState } from './ContextMenu'

interface Props {
  data: SessionStoreData
  openSessionIds: Set<string>
  editingFolderId: string | null
  onConnect: (s: Session) => void
  onEditSession: (s: Session) => void
  onNewSession: (folderId: string | null) => void
  onDuplicateSession: (s: Session) => void
  onDeleteSession: (s: Session) => void
  onNewFolder: (parentId: string | null) => void
  onStartRenameFolder: (id: string | null) => void
  onRenameFolder: (f: Folder, name: string) => void
  onDeleteFolder: (f: Folder) => void
  onToggleFolder: (f: Folder) => void
  onMove: (kind: 'session' | 'folder', id: string, folderId: string | null) => void
  openMenu: (m: MenuState) => void
}

const DND_TYPE = 'application/x-simssh-item'

function isDescendant(folders: Folder[], maybeChild: string | null, ancestor: string): boolean {
  let cur = maybeChild
  while (cur) {
    if (cur === ancestor) return true
    cur = folders.find((f) => f.id === cur)?.parentId ?? null
  }
  return false
}

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })

export function SessionTree(props: Props): React.JSX.Element {
  const { data, openSessionIds } = props
  const [query, setQuery] = useState('')
  const [dropTarget, setDropTarget] = useState<string | null | undefined>(undefined) // undefined = none, null = root
  const [selected, setSelected] = useState<string | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    return data.sessions
      .filter((s) => [s.name, s.host, s.username, s.notes ?? ''].some((v) => v.toLowerCase().includes(q)))
      .sort(byName)
  }, [query, data.sessions])

  const dragStart = (e: React.DragEvent, kind: 'session' | 'folder', id: string): void => {
    e.dataTransfer.setData(DND_TYPE, JSON.stringify({ kind, id }))
    e.dataTransfer.effectAllowed = 'move'
  }

  const dropProps = (folderId: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DND_TYPE)) return
      e.preventDefault()
      e.stopPropagation()
      setDropTarget(folderId)
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDropTarget(undefined)
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setDropTarget(undefined)
      const raw = e.dataTransfer.getData(DND_TYPE)
      if (!raw) return
      const { kind, id } = JSON.parse(raw) as { kind: 'session' | 'folder'; id: string }
      if (kind === 'folder' && (id === folderId || isDescendant(data.folders, folderId, id))) return
      props.onMove(kind, id, folderId)
    }
  })

  const sessionRow = (s: Session, depth: number): React.JSX.Element => (
    <div
      key={s.id}
      className={`tree-row session ${selected === s.id ? 'selected' : ''}`}
      style={{ paddingLeft: 10 + depth * 14 }}
      draggable
      tabIndex={0}
      title={`${s.username}@${s.host}${s.port !== 22 ? ':' + s.port : ''}${s.notes ? '\n' + s.notes : ''}`}
      onDragStart={(e) => dragStart(e, 'session', s.id)}
      onClick={() => setSelected(s.id)}
      onDoubleClick={() => props.onConnect(s)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') props.onConnect(s)
        if (e.key === 'F2') props.onEditSession(s)
        if (e.key === 'Delete') props.onDeleteSession(s)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        setSelected(s.id)
        props.openMenu({
          x: e.clientX,
          y: e.clientY,
          items: [
            { label: 'Connect', onClick: () => props.onConnect(s), shortcut: 'Enter' },
            { label: 'Edit…', onClick: () => props.onEditSession(s), shortcut: 'F2' },
            { label: 'Duplicate', onClick: () => props.onDuplicateSession(s) },
            'separator',
            { label: 'Delete', danger: true, onClick: () => props.onDeleteSession(s), shortcut: 'Del' }
          ]
        })
      }}
    >
      <span className="session-dot" style={{ background: s.color ?? 'transparent', borderColor: s.color ?? 'var(--line-strong)' }} />
      <span className="row-label">{s.name}</span>
      {openSessionIds.has(s.id) && <span className="open-mark" title="Open in a tab" />}
    </div>
  )

  const folderRow = (f: Folder, depth: number): React.JSX.Element => {
    const childFolders = data.folders.filter((x) => x.parentId === f.id).sort(byName)
    const childSessions = data.sessions.filter((x) => x.folderId === f.id).sort(byName)
    const editing = props.editingFolderId === f.id
    return (
      <div key={f.id} className={`tree-folder ${dropTarget === f.id ? 'drop' : ''}`} {...dropProps(f.id)}>
        <div
          className={`tree-row folder ${selected === f.id ? 'selected' : ''}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          draggable={!editing}
          tabIndex={0}
          onDragStart={(e) => dragStart(e, 'folder', f.id)}
          onClick={() => {
            setSelected(f.id)
            if (!editing) props.onToggleFolder(f)
          }}
          onKeyDown={(e) => {
            if (editing) return
            if (e.key === 'F2') props.onStartRenameFolder(f.id)
            if (e.key === 'Enter' || e.key === ' ') props.onToggleFolder(f)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            setSelected(f.id)
            props.openMenu({
              x: e.clientX,
              y: e.clientY,
              items: [
                { label: 'New session here…', onClick: () => props.onNewSession(f.id) },
                { label: 'New folder inside', onClick: () => props.onNewFolder(f.id) },
                { label: 'Rename', onClick: () => props.onStartRenameFolder(f.id), shortcut: 'F2' },
                'separator',
                { label: 'Delete folder', danger: true, onClick: () => props.onDeleteFolder(f) }
              ]
            })
          }}
        >
          <span className={`chevron ${f.collapsed ? '' : 'open'}`} aria-hidden />
          {editing ? (
            <input
              className="inline-edit"
              autoFocus
              defaultValue={f.name}
              onClick={(e) => e.stopPropagation()}
              onFocus={(e) => e.target.select()}
              onBlur={(e) => props.onRenameFolder(f, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') props.onStartRenameFolder(null)
              }}
            />
          ) : (
            <span className="row-label">{f.name}</span>
          )}
          <span className="count">{childSessions.length || ''}</span>
        </div>
        {!f.collapsed && (
          <div className="tree-children">
            {childFolders.map((c) => folderRow(c, depth + 1))}
            {childSessions.map((s) => sessionRow(s, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  const rootFolders = data.folders.filter((f) => !f.parentId || !data.folders.some((x) => x.id === f.parentId)).sort(byName)
  const rootSessions = data.sessions
    .filter((s) => !s.folderId || !data.folders.some((f) => f.id === s.folderId))
    .sort(byName)
  const empty = data.sessions.length === 0 && data.folders.length === 0

  return (
    <div className="session-tree">
      <div className="sidebar-tools">
        <input className="search" placeholder="Search sessions" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
        <button className="icon-btn" title="New folder" onClick={() => props.onNewFolder(null)}>
          <svg viewBox="0 0 16 16" aria-hidden><path d="M1.5 3.5h4l1.5 1.5h7.5v8h-13z M8 7.5v4 M6 9.5h4" /></svg>
        </button>
      </div>
      <div
        className={`tree-scroll ${dropTarget === null ? 'drop' : ''}`}
        {...dropProps(null)}
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return
          e.preventDefault()
          props.openMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
              { label: 'New session…', onClick: () => props.onNewSession(null) },
              { label: 'New folder', onClick: () => props.onNewFolder(null) }
            ]
          })
        }}
      >
        {empty && (
          <div className="empty">
            <p>No saved sessions yet.</p>
            <button className="btn btn-primary" onClick={() => props.onNewSession(null)}>
              New session
            </button>
            <p className="muted">Or type user@host in the box at the top and press Enter.</p>
          </div>
        )}
        {filtered ? (
          filtered.length ? (
            filtered.map((s) => sessionRow(s, 0))
          ) : (
            <p className="muted pad">No sessions match “{query}”.</p>
          )
        ) : (
          <>
            {rootFolders.map((f) => folderRow(f, 0))}
            {rootSessions.map((s) => sessionRow(s, 0))}
          </>
        )}
      </div>
    </div>
  )
}
