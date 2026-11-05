import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AuthStatus } from '../../shared/types'
import App from './App'
import { SignIn } from './components/SignIn'
import './styles.css'

/** Shows the sign-in screen until someone signs in, then the app for that account. */
function Root(): React.JSX.Element | null {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [notice, setNotice] = useState('')

  const refresh = useCallback(async () => setStatus(await window.api.auth.status()), [])
  useEffect(() => void refresh(), [refresh])
  const signedOut = useCallback(
    (n?: string) => {
      setNotice(n ?? '')
      void refresh()
    },
    [refresh]
  )

  if (!status) return null
  if (!status.signedIn || !status.username) {
    return (
      <SignIn
        status={status}
        notice={notice}
        onSignedIn={() => {
          setNotice('')
          void refresh()
        }}
      />
    )
  }
  // key: a different account gets a completely fresh app (no tabs or state carried over).
  return <App key={status.username} username={status.username} onSignedOut={signedOut} />
}

// No StrictMode: its double-mounting would open each SSH connection twice in development.
createRoot(document.getElementById('root')!).render(<Root />)
