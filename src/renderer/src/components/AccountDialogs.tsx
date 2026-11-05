import { useEffect, useRef, useState } from 'react'
import { cleanError } from '../lib/util'

const MIN_PASSWORD = 12

interface Props {
  onClose: () => void
}

export function ChangePasswordDialog({ onClose, onDone }: Props & { onDone: () => void }): React.JSX.Element {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const firstRef = useRef<HTMLInputElement>(null)
  useEffect(() => firstRef.current?.focus(), [])

  const submit = async (): Promise<void> => {
    setError('')
    if (!current) return setError('Enter your current password.')
    if (next.length < MIN_PASSWORD) return setError(`Use at least ${MIN_PASSWORD} characters for the new password.`)
    if (next !== confirm) return setError("The new passwords don't match.")
    setBusy(true)
    try {
      await window.api.auth.changePassword(current, next)
      onDone()
    } catch (e) {
      setError(cleanError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form
        className="modal modal-narrow"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}
      >
        <h2>Change password</h2>
        <label className="field">
          <span>Current password</span>
          <input ref={firstRef} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label className="field">
          <span>New password</span>
          <input type="password" autoComplete="new-password" maxLength={256} value={next} onChange={(e) => setNext(e.target.value)} />
          <small>At least {MIN_PASSWORD} characters.</small>
        </label>
        <label className="field">
          <span>Confirm new password</span>
          <input type="password" autoComplete="new-password" maxLength={256} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Changing…' : 'Change password'}
          </button>
        </div>
      </form>
    </div>
  )
}

export function DeleteAccountDialog({ username, onClose, onDone }: Props & { username: string; onDone: () => void }): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const firstRef = useRef<HTMLInputElement>(null)
  useEffect(() => firstRef.current?.focus(), [])

  const submit = async (): Promise<void> => {
    setError('')
    if (!password) return setError('Enter your password to confirm.')
    setBusy(true)
    try {
      await window.api.auth.deleteAccount(password)
      onDone()
    } catch (e) {
      setError(cleanError(e))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form
        className="modal modal-narrow"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}
      >
        <h2>Delete the account “{username}”?</h2>
        <p className="modal-message">
          All sessions, folders, saved passwords and trusted host keys in this account will be deleted from this PC. Open
          connections will close. This can't be undone.
        </p>
        <label className="field">
          <span>Password</span>
          <input ref={firstRef} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-danger" disabled={busy}>
            {busy ? 'Deleting…' : 'Delete account'}
          </button>
        </div>
      </form>
    </div>
  )
}
