import { useEffect, useRef, useState } from 'react'
import type { AuthMethod, Folder, Session } from '../../../shared/types'
import { SESSION_COLORS } from '../lib/util'

interface Props {
  session: Session
  isNew: boolean
  folders: Folder[]
  encryptionAvailable: boolean
  onSave: (session: Session, secret: string | undefined, connect: boolean) => void
  onCancel: () => void
}

function folderPath(folders: Folder[], id: string | null): string {
  const parts: string[] = []
  let cur = folders.find((f) => f.id === id)
  while (cur) {
    parts.unshift(cur.name)
    cur = folders.find((f) => f.id === cur!.parentId)
  }
  return parts.join(' / ')
}

export function SessionEditor({ session, isNew, folders, encryptionAvailable, onSave, onCancel }: Props): React.JSX.Element {
  const [s, setS] = useState<Session>(session)
  const [secret, setSecret] = useState('')
  const [forget, setForget] = useState(false)
  const [error, setError] = useState('')
  const hostRef = useRef<HTMLInputElement>(null)

  useEffect(() => hostRef.current?.focus(), [])

  const set = <K extends keyof Session>(k: K, v: Session[K]): void => setS((prev) => ({ ...prev, [k]: v }))

  const submit = (connect: boolean): void => {
    const host = s.host.trim()
    const username = s.username.trim()
    if (!host) return setError('Enter a host name or IP address.')
    if (!username) return setError('Enter a user name.')
    if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) return setError('Port must be between 1 and 65535.')
    if (s.authMethod === 'key' && !s.keyPath) return setError('Choose a private key file.')
    const name = s.name.trim() || `${username}@${host}`
    const secretToSend = forget ? '' : secret ? secret : undefined
    onSave({ ...s, host, username, name }, secretToSend, connect)
  }

  const secretLabel = s.authMethod === 'key' ? 'Key passphrase' : 'Password'
  const sortedFolders = [...folders].sort((a, b) => folderPath(folders, a.id).localeCompare(folderPath(folders, b.id)))

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form
        className="modal"
        onSubmit={(e) => {
          e.preventDefault()
          submit(false)
        }}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      >
        <h2>{isNew ? 'New session' : `Edit ${session.name}`}</h2>

        <div className="grid-2">
          <label className="field grow">
            <span>Host</span>
            <input ref={hostRef} value={s.host} placeholder="server.example.com" spellCheck={false} onChange={(e) => set('host', e.target.value)} />
          </label>
          <label className="field port">
            <span>Port</span>
            <input type="number" min={1} max={65535} value={s.port} onChange={(e) => set('port', Number(e.target.value))} />
          </label>
        </div>

        <label className="field">
          <span>User name</span>
          <input value={s.username} placeholder="root" spellCheck={false} onChange={(e) => set('username', e.target.value)} />
        </label>

        <fieldset className="field">
          <span>Log in with</span>
          <div className="segmented">
            {(
              [
                ['password', 'Password'],
                ['key', 'Private key'],
                ['agent', 'SSH agent']
              ] as [AuthMethod, string][]
            ).map(([v, label]) => (
              <button type="button" key={v} className={s.authMethod === v ? 'on' : ''} onClick={() => set('authMethod', v)}>
                {label}
              </button>
            ))}
          </div>
        </fieldset>

        {s.authMethod === 'key' && (
          <label className="field">
            <span>Private key file</span>
            <div className="input-row">
              <input value={s.keyPath ?? ''} placeholder="C:\Users\you\.ssh\id_ed25519" spellCheck={false} onChange={(e) => set('keyPath', e.target.value)} />
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  const p = await window.api.chooseKeyFile()
                  if (p) set('keyPath', p)
                }}
              >
                Browse
              </button>
            </div>
            <small>OpenSSH or PEM format. For a PuTTY .ppk key, use PuTTYgen → Conversions → Export OpenSSH key.</small>
          </label>
        )}

        {s.authMethod === 'agent' && (
          <p className="hint">Uses the Windows OpenSSH Authentication Agent if it's running, otherwise Pageant.</p>
        )}

        {s.authMethod !== 'agent' && (
          <label className="field">
            <span>{secretLabel}</span>
            {encryptionAvailable ? (
              <>
                <input
                  type="password"
                  value={secret}
                  disabled={forget}
                  autoComplete="new-password"
                  placeholder={session.hasSecret && !forget ? 'Saved. Type to replace it.' : 'Leave empty to be asked when connecting'}
                  onChange={(e) => setSecret(e.target.value)}
                />
                {session.hasSecret && (
                  <label className="check small">
                    <input type="checkbox" checked={forget} onChange={(e) => setForget(e.target.checked)} />
                    Forget the saved {secretLabel.toLowerCase()}
                  </label>
                )}
              </>
            ) : (
              <small>Secure storage isn't available, so you'll be asked each time you connect.</small>
            )}
          </label>
        )}

        <div className="grid-2">
          <label className="field grow">
            <span>Name</span>
            <input value={s.name} placeholder={s.username && s.host ? `${s.username}@${s.host}` : 'Shown in the sidebar'} onChange={(e) => set('name', e.target.value)} />
          </label>
          <label className="field grow">
            <span>Folder</span>
            <select value={s.folderId ?? ''} onChange={(e) => set('folderId', e.target.value || null)}>
              <option value="">(none)</option>
              {sortedFolders.map((f) => (
                <option key={f.id} value={f.id}>
                  {folderPath(folders, f.id)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <fieldset className="field">
          <span>Colour</span>
          <div className="swatches">
            <button type="button" className={`swatch none ${!s.color ? 'on' : ''}`} title="No colour" onClick={() => set('color', undefined)} />
            {SESSION_COLORS.map((c) => (
              <button type="button" key={c} className={`swatch ${s.color === c ? 'on' : ''}`} style={{ background: c }} title={c} onClick={() => set('color', c)} />
            ))}
          </div>
        </fieldset>

        <label className="field">
          <span>SFTP start folder</span>
          <input value={s.sftpStartDir ?? ''} placeholder="Home folder" spellCheck={false} onChange={(e) => set('sftpStartDir', e.target.value || undefined)} />
        </label>

        <label className="field">
          <span>Notes</span>
          <textarea rows={2} value={s.notes ?? ''} onChange={(e) => set('notes', e.target.value || undefined)} />
        </label>

        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn">
            Save
          </button>
          <button type="button" className="btn btn-primary" onClick={() => submit(true)}>
            Save and connect
          </button>
        </div>
      </form>
    </div>
  )
}
