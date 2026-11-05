import { useEffect, useRef, useState } from 'react'
import type { AuthStatus } from '../../../shared/types'
import { cleanError, LAST_USER_KEY, readLocal, writeLocal } from '../lib/util'

interface Props {
  status: AuthStatus
  onSignedIn: () => void
}

const MIN_PASSWORD = 12

export function SignIn({ status, onSignedIn }: Props): React.JSX.Element {
  const [mode, setMode] = useState<'signIn' | 'create'>(status.hasAccounts ? 'signIn' : 'create')
  const [username, setUsername] = useState(() => (status.hasAccounts ? readLocal(LAST_USER_KEY) : ''))
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const userRef = useRef<HTMLInputElement>(null)
  const passRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (mode === 'signIn' && username) passRef.current?.focus()
    else userRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  const switchMode = (m: 'signIn' | 'create'): void => {
    setMode(m)
    // A new account needs a new name; signing in starts from the last one used.
    setUsername(m === 'create' ? '' : readLocal(LAST_USER_KEY))
    setError('')
    setPassword('')
    setConfirm('')
  }

  const submit = async (): Promise<void> => {
    setError('')
    if (!username.trim()) return setError('Enter a user name.')
    if (mode === 'create') {
      if (password.length < MIN_PASSWORD) return setError(`Use at least ${MIN_PASSWORD} characters. A few random words work well.`)
      if (password !== confirm) return setError("The passwords don't match.")
    } else if (!password) {
      return setError('Enter your password.')
    }
    setBusy(true)
    try {
      if (mode === 'create') await window.api.auth.create(username, password)
      else await window.api.auth.signIn(username, password)
      writeLocal(LAST_USER_KEY, username.trim())
      setPassword('')
      setConfirm('')
      onSignedIn()
    } catch (e) {
      setError(cleanError(e))
      setPassword('')
      passRef.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  const creating = mode === 'create'

  return (
    <div className="signin">
      <form
        className="signin-card"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="signin-brand" aria-hidden>
          <svg viewBox="0 0 20 20">
            <path d="M3 5.5 8 10l-5 4.5" />
            <path d="M10 15h7" />
          </svg>
        </div>
        <h1>{creating ? (status.hasAccounts ? 'Create an account' : 'Create your account') : 'Sign in to SimSSH'}</h1>
        {creating && (
          <p className="signin-lead">
            Your sessions, saved passwords and trusted host keys are encrypted with this password.
            {status.legacySessions > 0 &&
              ` The ${status.legacySessions} session${status.legacySessions === 1 ? '' : 's'} already on this PC will move into this account.`}
          </p>
        )}

        <label className="field">
          <span>User name</span>
          <input
            ref={userRef}
            value={username}
            autoComplete="username"
            spellCheck={false}
            maxLength={32}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            ref={passRef}
            type="password"
            value={password}
            autoComplete={creating ? 'new-password' : 'current-password'}
            maxLength={256}
            onChange={(e) => setPassword(e.target.value)}
          />
          {creating && <small>At least {MIN_PASSWORD} characters. A few random words are easy to remember and hard to guess.</small>}
        </label>
        {creating && (
          <label className="field">
            <span>Confirm password</span>
            <input type="password" value={confirm} autoComplete="new-password" maxLength={256} onChange={(e) => setConfirm(e.target.value)} />
          </label>
        )}

        {creating && (
          <p className="signin-warning">
            There's no way to reset a forgotten password. Without it, the sessions and passwords in this account can't be
            decrypted, by you or anyone else.
          </p>
        )}

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn btn-primary signin-submit" disabled={busy}>
          {busy ? (creating ? 'Creating account…' : 'Signing in…') : creating ? 'Create account' : 'Sign in'}
        </button>

        {status.hasAccounts && (
          <p className="signin-switch">
            {creating ? (
              <>
                Already have an account?{' '}
                <button type="button" className="link" onClick={() => switchMode('signIn')}>
                  Sign in
                </button>
              </>
            ) : (
              <>
                New on this PC?{' '}
                <button type="button" className="link" onClick={() => switchMode('create')}>
                  Create an account
                </button>
              </>
            )}
          </p>
        )}
      </form>
    </div>
  )
}
