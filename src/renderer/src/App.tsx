import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppInfo, AuthMethod, ConnState, Folder, PromptRequest, Session, SessionStoreData } from '../../shared/types'
import { TerminalView } from './components/TerminalView'
import { SessionTree } from './components/SessionTree'
import { SessionEditor } from './components/SessionEditor'
import { SftpPanel, type TransferItem } from './components/SftpPanel'
import { PromptDialog } from './components/PromptDialog'
import { ContextMenu, type MenuState } from './components/ContextMenu'
import { ChangePasswordDialog, DeleteAccountDialog } from './components/AccountDialogs'
import { getTerminal, writeToTerminal } from './lib/terminals'
import { LAST_USER_KEY, parseQuickConnect, readLocal, uid, writeLocal } from './lib/util'

interface Target {
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  keyPath?: string
}

interface Tab {
  id: string // also the connection id
  title: string
  sessionId?: string
  color?: string
  status: ConnState
  message?: string
  target: Target
  sftpStartDir?: string
}

const EMPTY: SessionStoreData = { version: 1, folders: [], sessions: [] }
const DIM = '\x1b[38;2;135;148;166m'
const RESET = '\x1b[0m'

function loadNumber(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(key))
    return Number.isFinite(v) && v > 0 ? v : fallback
  } catch {
    return fallback
  }
}

interface AppProps {
  username: string
  onSignedOut: () => void
}

export default function App({ username, onSignedOut }: AppProps): React.JSX.Element {
  const [data, setData] = useState<SessionStoreData>(EMPTY)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [multiExec, setMultiExec] = useState(false)
  const [included, setIncluded] = useState<Set<string>>(new Set())
  const [prompts, setPrompts] = useState<PromptRequest[]>([])
  const [editor, setEditor] = useState<{ session: Session; isNew: boolean } | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [view, setView] = useState<'sessions' | 'files'>('sessions')
  const [sidebarWidth, setSidebarWidth] = useState(() => loadNumber('sidebarWidth', 300))
  const [transfers, setTransfers] = useState<TransferItem[]>([])
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null)
  const [quick, setQuick] = useState('')
  const [quickError, setQuickError] = useState('')
  const [notice, setNotice] = useState('')
  const [accountDialog, setAccountDialog] = useState<'password' | 'delete' | null>(null)

  // Refs so long-lived listeners always see current state.
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const activeRef = useRef(activeId)
  activeRef.current = activeId
  const multiRef = useRef({ on: multiExec, included })
  multiRef.current = { on: multiExec, included }

  const reloadStore = useCallback(async () => setData(await window.api.store.get()), [])

  const showNotice = useCallback((msg: string) => {
    setNotice(msg)
    window.setTimeout(() => setNotice((n) => (n === msg ? '' : n)), 4000)
  }, [])

  // ---- wiring to the main process ----------------------------------------------
  useEffect(() => {
    void reloadStore()
    void window.api.appInfo().then(setInfo)
    const offs = [
      window.api.store.onChanged(() => void reloadStore()),
      window.api.ssh.onData((id, d) => writeToTerminal(id, d)),
      window.api.ssh.onStatus(({ connId, state, message }) => {
        setTabs((ts) => ts.map((t) => (t.id === connId ? { ...t, status: state, message } : t)))
        if (state === 'closed' || state === 'error') {
          const color = state === 'error' ? '\x1b[38;2;226;104;122m' : DIM
          writeToTerminal(connId, `\r\n${color}${message ?? 'Disconnected.'}${RESET}\r\n${DIM}Press Enter to reconnect.${RESET}\r\n`)
        }
      }),
      window.api.prompt.onRequest((req) => setPrompts((p) => [...p, req])),
      window.api.sftp.onTransfer((p) =>
        setTransfers((list) => {
          const i = list.findIndex((t) => t.transferId === p.transferId)
          if (i < 0) return [...list, p]
          const next = [...list]
          next[i] = { ...next[i], ...p }
          return next
        })
      ),
      window.api.sftp.onDownloaded((transferId, localPath) =>
        setTransfers((list) => list.map((t) => (t.transferId === transferId ? { ...t, localPath } : t)))
      )
    ]
    return () => offs.forEach((off) => off())
  }, [reloadStore])

  // ---- tabs & connections --------------------------------------------------------
  const connect = useCallback((tab: Tab, cols: number, rows: number) => {
    setTabs((ts) => ts.map((t) => (t.id === tab.id ? { ...t, status: 'connecting', message: undefined } : t)))
    const { host, port, username, authMethod, keyPath } = tab.target
    writeToTerminal(tab.id, `${DIM}Connecting to ${username}@${host}${port !== 22 ? ':' + port : ''}…${RESET}\r\n`)
    window.api.ssh
      .connect({ connId: tab.id, sessionId: tab.sessionId, host, port, username, authMethod, keyPath, cols, rows })
      .catch((e: Error) => {
        const msg = e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
        setTabs((ts) => ts.map((t) => (t.id === tab.id ? { ...t, status: 'error', message: msg } : t)))
        writeToTerminal(tab.id, `\x1b[38;2;226;104;122m${msg}${RESET}\r\n`)
      })
  }, [])

  const reconnect = useCallback(
    (id: string) => {
      const tab = tabsRef.current.find((t) => t.id === id)
      const term = getTerminal(id)
      if (!tab || !term) return
      term.write('\r\n')
      connect(tab, term.cols, term.rows)
    },
    [connect]
  )

  const openTab = useCallback((tab: Omit<Tab, 'id' | 'status'>) => {
    const t: Tab = { ...tab, id: uid(), status: 'connecting' }
    setTabs((ts) => [...ts, t])
    setActiveId(t.id)
    return t
  }, [])

  const openSession = useCallback(
    (s: Session) =>
      openTab({
        title: s.name,
        sessionId: s.id,
        color: s.color,
        sftpStartDir: s.sftpStartDir,
        target: { host: s.host, port: s.port, username: s.username, authMethod: s.authMethod, keyPath: s.keyPath }
      }),
    [openTab]
  )

  const closeTab = useCallback((id: string) => {
    window.api.ssh.close(id)
    setIncluded((s) => {
      const n = new Set(s)
      n.delete(id)
      return n
    })
    const ts = tabsRef.current
    const i = ts.findIndex((t) => t.id === id)
    const next = ts.filter((t) => t.id !== id)
    tabsRef.current = next
    setTabs((cur) => cur.filter((t) => t.id !== id))
    if (activeRef.current === id) setActiveId(next[Math.min(i, next.length - 1)]?.id ?? null)
  }, [])

  const handleInput = useCallback(
    (id: string, d: string) => {
      const tab = tabsRef.current.find((t) => t.id === id)
      if (!tab) return
      if (tab.status === 'closed' || tab.status === 'error') {
        if (d === '\r') reconnect(id)
        return
      }
      const m = multiRef.current
      if (m.on && m.included.has(id)) {
        for (const t of tabsRef.current) if (m.included.has(t.id) && t.status === 'connected') window.api.ssh.write(t.id, d)
      } else {
        window.api.ssh.write(id, d)
      }
    },
    [reconnect]
  )

  const toggleMultiExec = (): void => {
    if (multiExec) {
      setMultiExec(false)
      return
    }
    setIncluded(new Set(tabs.filter((t) => t.status === 'connected').map((t) => t.id)))
    setMultiExec(true)
  }

  const toggleIncluded = (id: string): void =>
    setIncluded((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey) return
      if (e.code === 'Tab') {
        e.preventDefault()
        const ts = tabsRef.current
        if (!ts.length) return
        setActiveId((cur) => {
          const i = ts.findIndex((t) => t.id === cur)
          return ts[(i + (e.shiftKey ? -1 : 1) + ts.length) % ts.length].id
        })
      } else if (e.shiftKey && e.code === 'KeyW') {
        e.preventDefault()
        if (activeRef.current) closeTab(activeRef.current)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeTab])

  // ---- quick connect -------------------------------------------------------------
  const quickConnect = (): void => {
    const parsed = parseQuickConnect(quick)
    if (!parsed) return setQuickError('Use user@host or user@host:port')
    if (!parsed.username) return setQuickError('Add a user name: user@host')
    setQuickError('')
    setQuick('')
    openTab({
      title: `${parsed.username}@${parsed.host}`,
      target: { ...parsed, authMethod: 'password' }
    })
  }

  // ---- sessions & folders --------------------------------------------------------
  const newSession = (folderId: string | null, from?: Partial<Session>): void =>
    setEditor({
      isNew: true,
      session: { id: uid(), name: '', folderId, host: '', port: 22, username: '', authMethod: 'password', ...from }
    })

  const saveSession = async (s: Session, secret: string | undefined, andConnect: boolean): Promise<void> => {
    try {
      await window.api.store.saveSession({ session: s, secret })
      setEditor(null)
      await reloadStore()
      if (andConnect) openSession(s)
      // Keep open tabs' titles and colours in sync.
      setTabs((ts) => ts.map((t) => (t.sessionId === s.id ? { ...t, title: s.name, color: s.color } : t)))
    } catch (e) {
      showNotice((e as Error).message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''))
    }
  }

  const deleteSession = async (s: Session): Promise<void> => {
    if (!window.confirm(`Delete the session “${s.name}”?`)) return
    await window.api.store.deleteSession(s.id)
    await reloadStore()
  }

  const duplicateSession = async (s: Session): Promise<void> => {
    const copy: Session = { ...s, id: uid(), name: `${s.name} (copy)`, hasSecret: false }
    await window.api.store.saveSession({ session: copy })
    await reloadStore()
    setEditor({ session: copy, isNew: false })
  }

  const newFolder = async (parentId: string | null): Promise<void> => {
    const f: Folder = { id: uid(), name: 'New folder', parentId }
    if (parentId) {
      const parent = data.folders.find((x) => x.id === parentId)
      if (parent?.collapsed) await window.api.store.saveFolder({ ...parent, collapsed: false })
    }
    await window.api.store.saveFolder(f)
    await reloadStore()
    setEditingFolderId(f.id)
  }

  const renameFolder = async (f: Folder, name: string): Promise<void> => {
    setEditingFolderId(null)
    name = name.trim()
    if (!name || name === f.name) return
    await window.api.store.saveFolder({ ...f, name })
    await reloadStore()
  }

  const deleteFolder = async (f: Folder): Promise<void> => {
    const n = data.sessions.filter((s) => s.folderId === f.id).length
    if (!window.confirm(`Delete the folder “${f.name}”?${n ? ` Its ${n} session${n === 1 ? '' : 's'} will move up a level.` : ''}`)) return
    await window.api.store.deleteFolder(f.id)
    await reloadStore()
  }

  const toggleFolder = async (f: Folder): Promise<void> => {
    setData((d) => ({ ...d, folders: d.folders.map((x) => (x.id === f.id ? { ...x, collapsed: !x.collapsed } : x)) }))
    await window.api.store.saveFolder({ ...f, collapsed: !f.collapsed })
  }

  const move = async (kind: 'session' | 'folder', id: string, folderId: string | null): Promise<void> => {
    const next: SessionStoreData =
      kind === 'session'
        ? { ...data, sessions: data.sessions.map((s) => (s.id === id ? { ...s, folderId } : s)) }
        : { ...data, folders: data.folders.map((f) => (f.id === id ? { ...f, parentId: folderId } : f)) }
    setData(next)
    await window.api.store.replaceAll(next)
    await reloadStore()
  }

  // ---- account -------------------------------------------------------------------
  const signOut = async (): Promise<void> => {
    const open = tabsRef.current.filter((t) => t.status === 'connected' || t.status === 'connecting').length
    if (open && !window.confirm(`Sign out? ${open} open connection${open === 1 ? '' : 's'} will close.`)) return
    await window.api.auth.signOut()
    onSignedOut()
  }

  const accountMenu = (e: React.MouseEvent<HTMLButtonElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    setMenu({
      x: r.right - 200,
      y: r.bottom + 4,
      items: [
        { label: 'Change password…', onClick: () => setAccountDialog('password') },
        { label: 'Sign out', onClick: () => void signOut() },
        'separator',
        { label: 'Delete account…', danger: true, onClick: () => setAccountDialog('delete') }
      ]
    })
  }

  // ---- tab context menu ----------------------------------------------------------
  const tabMenu = (e: React.MouseEvent, t: Tab): void => {
    e.preventDefault()
    const session = t.sessionId ? data.sessions.find((s) => s.id === t.sessionId) : undefined
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Reconnect', onClick: () => reconnect(t.id) },
        {
          label: 'Duplicate tab',
          onClick: () => openTab({ title: t.title, sessionId: t.sessionId, color: t.color, sftpStartDir: t.sftpStartDir, target: t.target })
        },
        session
          ? { label: 'Edit session…', onClick: () => setEditor({ session, isNew: false }) }
          : {
              label: 'Save as session…',
              onClick: () => newSession(null, { ...t.target, name: t.title })
            },
        ...(multiExec
          ? [{ label: included.has(t.id) ? 'Remove from multi-exec' : 'Add to multi-exec', onClick: () => toggleIncluded(t.id) }]
          : []),
        'separator',
        { label: 'Close other tabs', disabled: tabs.length < 2, onClick: () => tabs.filter((x) => x.id !== t.id).forEach((x) => closeTab(x.id)) },
        { label: 'Close', onClick: () => closeTab(t.id), shortcut: 'Ctrl+Shift+W' }
      ]
    })
  }

  // ---- sidebar resize ------------------------------------------------------------
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = sidebarWidth
    let w = startW
    const onMove = (ev: MouseEvent): void => {
      w = Math.max(220, Math.min(640, startW + ev.clientX - startX))
      setSidebarWidth(w)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('resizing')
      try {
        localStorage.setItem('sidebarWidth', String(w))
      } catch {
        /* ignore */
      }
    }
    document.body.classList.add('resizing')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // ---- render --------------------------------------------------------------------
  const active = tabs.find((t) => t.id === activeId) ?? null
  const openSessionIds = useMemo(() => new Set(tabs.map((t) => t.sessionId).filter(Boolean) as string[]), [tabs])
  const multiCount = tabs.filter((t) => included.has(t.id) && t.status === 'connected').length
  const activeIsBroadcasting = multiExec && !!active && included.has(active.id)
  const prompt = prompts[0]

  return (
    <div className={`app ${multiExec ? 'multi' : ''}`}>
      <header className="toolbar">
        <div className="brand" aria-hidden>
          <svg viewBox="0 0 20 20">
            <path d="M3 5.5 8 10l-5 4.5" />
            <path d="M10 15h7" />
          </svg>
        </div>
        <form
          className="quick"
          onSubmit={(e) => {
            e.preventDefault()
            quickConnect()
          }}
        >
          <input
            value={quick}
            placeholder="Quick connect: user@host:port"
            spellCheck={false}
            onChange={(e) => {
              setQuick(e.target.value)
              setQuickError('')
            }}
            aria-invalid={!!quickError}
          />
          {quickError && <span className="quick-error">{quickError}</span>}
        </form>
        <button className="btn" onClick={() => newSession(null)}>
          New session
        </button>
        <button
          className={`btn multi-btn ${multiExec ? 'on' : ''}`}
          onClick={toggleMultiExec}
          title="Type once, send to several tabs"
          aria-pressed={multiExec}
        >
          {multiExec ? `Multi-exec on (${multiCount})` : 'Multi-exec'}
        </button>
        <span className="spacer" />
        <button className="account-btn" onClick={accountMenu} aria-haspopup="menu" title="Account">
          <span className="avatar" aria-hidden>
            {username.slice(0, 1).toUpperCase()}
          </span>
          <span className="account-name">{username}</span>
        </button>
      </header>

      <div className="body">
        <aside className="sidebar" style={{ width: sidebarWidth }}>
          <div className="sidebar-tabs" role="tablist">
            <button role="tab" aria-selected={view === 'sessions'} className={view === 'sessions' ? 'on' : ''} onClick={() => setView('sessions')}>
              Sessions
            </button>
            <button role="tab" aria-selected={view === 'files'} className={view === 'files' ? 'on' : ''} onClick={() => setView('files')}>
              Files
              {transfers.some((t) => !t.done) && <span className="busy-dot" />}
            </button>
          </div>
          {view === 'sessions' ? (
            <SessionTree
              data={data}
              openSessionIds={openSessionIds}
              editingFolderId={editingFolderId}
              onConnect={openSession}
              onEditSession={(s) => setEditor({ session: s, isNew: false })}
              onNewSession={newSession}
              onDuplicateSession={(s) => void duplicateSession(s)}
              onDeleteSession={(s) => void deleteSession(s)}
              onNewFolder={(p) => void newFolder(p)}
              onStartRenameFolder={setEditingFolderId}
              onRenameFolder={(f, n) => void renameFolder(f, n)}
              onDeleteFolder={(f) => void deleteFolder(f)}
              onToggleFolder={(f) => void toggleFolder(f)}
              onMove={(k, id, fid) => void move(k, id, fid)}
              openMenu={setMenu}
            />
          ) : (
            <SftpPanel
              connId={active?.id ?? null}
              connected={active?.status === 'connected'}
              tabTitle={active?.title}
              startDir={active?.sftpStartDir}
              transfers={transfers}
              onClearTransfers={() => setTransfers((t) => t.filter((x) => !x.done))}
              openMenu={setMenu}
            />
          )}
        </aside>
        <div className="resizer" onMouseDown={startResize} />

        <main className="workspace">
          <div className="tabbar" role="tablist">
            {tabs.map((t) => (
              <div
                key={t.id}
                role="tab"
                aria-selected={t.id === activeId}
                className={`tab ${t.id === activeId ? 'active' : ''} ${t.status} ${multiExec && included.has(t.id) ? 'included' : ''}`}
                style={t.color ? ({ '--tab-color': t.color } as React.CSSProperties) : undefined}
                onClick={() => setActiveId(t.id)}
                onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
                onContextMenu={(e) => tabMenu(e, t)}
                title={`${t.target.username}@${t.target.host}${t.target.port !== 22 ? ':' + t.target.port : ''}`}
              >
                {multiExec && (
                  <input
                    type="checkbox"
                    className="tab-check"
                    title="Include in multi-exec"
                    checked={included.has(t.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleIncluded(t.id)}
                  />
                )}
                <span className={`status-dot ${t.status}`} />
                <span className="tab-title">{t.title}</span>
                <button
                  className="tab-close"
                  aria-label={`Close ${t.title}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(t.id)
                  }}
                >
                  <svg viewBox="0 0 10 10" aria-hidden><path d="M2 2l6 6M8 2 2 8" /></svg>
                </button>
              </div>
            ))}
          </div>

          {activeIsBroadcasting && (
            <div className="multi-banner" role="status">
              Typing goes to {multiCount} tab{multiCount === 1 ? '' : 's'}. Untick a tab to leave it out.
            </div>
          )}

          <div className="terminals">
            {tabs.map((t) => (
              <div key={t.id} className={`term-pane ${t.id === activeId ? 'shown' : ''}`}>
                <TerminalView
                  id={t.id}
                  active={t.id === activeId}
                  onReady={(cols, rows) => connect(t, cols, rows)}
                  onInput={(d) => handleInput(t.id, d)}
                  onResize={(cols, rows) => window.api.ssh.resize(t.id, cols, rows)}
                />
              </div>
            ))}
            {tabs.length === 0 && (
              <div className="welcome">
                <h1>Connect to a server</h1>
                <p>Double-click a saved session, or type user@host in quick connect.</p>
                <div className="welcome-actions">
                  <button className="btn btn-primary" onClick={() => newSession(null)}>
                    New session
                  </button>
                </div>
                <dl className="shortcuts">
                  <dt>Ctrl+Tab</dt>
                  <dd>Next tab</dd>
                  <dt>Ctrl+Shift+W</dt>
                  <dd>Close tab</dd>
                  <dt>Select text</dt>
                  <dd>Copies it</dd>
                  <dt>Right-click</dt>
                  <dd>Pastes</dd>
                </dl>
              </div>
            )}
          </div>

          <footer className="statusbar">
            {active ? (
              <>
                <span className={`status-dot ${active.status}`} />
                <span>
                  {active.status === 'connected'
                    ? 'Connected'
                    : active.status === 'connecting'
                      ? 'Connecting…'
                      : (active.message ?? 'Disconnected')}
                </span>
                <span className="muted">
                  {active.target.username}@{active.target.host}:{active.target.port}
                </span>
              </>
            ) : (
              <span className="muted">No open tabs</span>
            )}
            <span className="spacer" />
            {notice && <span className="notice">{notice}</span>}
            {info && <span className="muted">SimSSH {info.version}</span>}
          </footer>
        </main>
      </div>

      {editor && (
        <SessionEditor
          session={editor.session}
          isNew={editor.isNew}
          folders={data.folders}
          encryptionAvailable={info?.encryptionAvailable ?? false}
          onSave={(s, secret, c) => void saveSession(s, secret, c)}
          onCancel={() => setEditor(null)}
        />
      )}

      {prompt && (
        <PromptDialog
          request={prompt}
          onAnswer={(answers, remember) => {
            window.api.prompt.respond({ promptId: prompt.promptId, answers, remember })
            setPrompts((p) => p.slice(1))
          }}
        />
      )}

      {accountDialog === 'password' && (
        <ChangePasswordDialog
          onClose={() => setAccountDialog(null)}
          onDone={() => {
            setAccountDialog(null)
            showNotice('Password changed.')
          }}
        />
      )}
      {accountDialog === 'delete' && (
        <DeleteAccountDialog
          username={username}
          onClose={() => setAccountDialog(null)}
          onDone={() => {
            if (readLocal(LAST_USER_KEY) === username) writeLocal(LAST_USER_KEY, '')
            onSignedOut()
          }}
        />
      )}

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}
