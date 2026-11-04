import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { registerTerminal, unregisterTerminal } from '../lib/terminals'

/** Only real web links may be opened from the terminal. */
function openLink(uri: string): void {
  try {
    const u = new URL(uri)
    if (u.protocol === 'http:' || u.protocol === 'https:') window.open(u.href)
  } catch {
    /* not a URL */
  }
}

/**
 * Pasting several lines runs each one as a command (and with multi-exec, on every host).
 * Ask first, like Windows Terminal does. Bracketed paste is still used when the shell supports it.
 */
function confirmPaste(text: string): boolean {
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n|\r/)
  if (lines.length < 2) return true
  const preview = lines.slice(0, 6).join('\n') + (lines.length > 6 ? `\n… (${lines.length - 6} more)` : '')
  return window.confirm(`Paste ${lines.length} lines? Each line may run as a command.\n\n${preview}`)
}

function pasteInto(term: Terminal): void {
  void navigator.clipboard.readText().then((t) => {
    if (t && confirmPaste(t)) term.paste(t)
  })
}

interface Props {
  id: string
  active: boolean
  /** Called once with the initial size, after the terminal has been laid out. */
  onReady: (cols: number, rows: number) => void
  onInput: (data: string) => void
  onResize: (cols: number, rows: number) => void
}

const THEME = {
  background: '#10161d',
  foreground: '#d7dee8',
  cursor: '#6cc3d5',
  cursorAccent: '#10161d',
  selectionBackground: '#2f4a5c',
  black: '#1b232e',
  red: '#e2687a',
  green: '#7fd08a',
  yellow: '#e6c35c',
  blue: '#6a9fe0',
  magenta: '#b48ce8',
  cyan: '#6cc3d5',
  white: '#c9d2dd',
  brightBlack: '#5b6878',
  brightRed: '#f08a99',
  brightGreen: '#9de3a6',
  brightYellow: '#f1d684',
  brightBlue: '#8fb9ee',
  brightMagenta: '#cbaaf2',
  brightCyan: '#93d7e5',
  brightWhite: '#f2f5f9'
}

export function TerminalView({ id, active, onReady, onInput, onResize }: Props): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  // Keep the latest callbacks without re-creating the terminal.
  const cb = useRef({ onReady, onInput, onResize })
  cb.current = { onReady, onInput, onResize }

  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace',
      fontSize: 14,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      rightClickSelectsWord: false,
      theme: THEME,
      // Hidden hyperlinks (OSC 8) can show one text and point elsewhere: show the real
      // target and ask before opening, and only allow http(s).
      linkHandler: {
        allowNonHttpProtocols: false,
        activate: (_e, uri) => {
          if (window.confirm(`Open this link in your browser?\n\n${uri}`)) openLink(uri)
        }
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_e, uri) => openLink(uri)))
    term.open(hostRef.current!)
    termRef.current = term
    fitRef.current = fit
    registerTerminal(id, term)

    term.onData((d) => cb.current.onInput(d))
    term.onResize(({ cols, rows }) => cb.current.onResize(cols, rows))

    // Copy on select, like MobaXterm / PuTTY.
    term.onSelectionChange(() => {
      const sel = term.getSelection()
      if (sel) void navigator.clipboard.writeText(sel)
    })

    // Ctrl+Shift+C / Ctrl+Shift+V; let Ctrl+Tab etc. bubble to the app.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
        const sel = term.getSelection()
        if (sel) void navigator.clipboard.writeText(sel)
        return false
      }
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
        pasteInto(term)
        return false
      }
      if (e.ctrlKey && (e.code === 'Tab' || (e.shiftKey && e.code === 'KeyW'))) return false
      return true
    })

    // Right-click pastes.
    const el = hostRef.current!
    const onContext = (e: MouseEvent): void => {
      e.preventDefault()
      pasteInto(term)
    }
    el.addEventListener('contextmenu', onContext)

    let readySent = false
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === 0 || el.clientHeight === 0) return
      try {
        fit.fit()
      } catch {
        return
      }
      if (!readySent) {
        readySent = true
        cb.current.onReady(term.cols, term.rows)
      }
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      el.removeEventListener('contextmenu', onContext)
      unregisterTerminal(id)
      term.dispose()
    }
  }, [id])

  useEffect(() => {
    if (!active) return
    const t = setTimeout(() => {
      try {
        fitRef.current?.fit()
      } catch {
        /* not visible yet */
      }
      termRef.current?.focus()
    }, 0)
    return () => clearTimeout(t)
  }, [active])

  return <div className="terminal-host" ref={hostRef} />
}
