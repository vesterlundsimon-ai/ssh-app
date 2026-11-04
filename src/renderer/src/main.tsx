import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// No StrictMode: its double-mounting would open each SSH connection twice in development.
createRoot(document.getElementById('root')!).render(<App />)
