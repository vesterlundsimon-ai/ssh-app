# Security

## Reporting a problem

Open a private security advisory on GitHub (Security → Report a vulnerability) rather than a public issue.

## Threat model

Shellport handles SSH credentials and connects to servers that may be compromised or hostile. The design assumes:

- **Remote servers are untrusted.** Terminal output, file names, error text and login prompts all come from the server and must never be able to run code locally, write outside the folder the user chose, or pose as the app.
- **The network is untrusted.** Host keys are verified; weak algorithms are off by default.
- **The UI is less trusted than the main process.** It renders server data, so the main process validates every request from it and never sends secrets back.
- **Other Windows users and copied data folders** must not be able to read saved passwords.

## Controls

### Electron

| Control | Where |
|---|---|
| `contextIsolation`, `sandbox`, no `nodeIntegration`, no `webview`, DevTools disabled in release builds | `src/main/index.ts` |
| UI served from a private `app://` scheme (not `file://`) with a strict Content-Security-Policy header (`default-src 'none'`, no inline scripts, `object-src 'none'`, `frame-ancestors 'none'`) | `src/main/index.ts` |
| All network requests from the UI blocked; navigation, redirects, new windows and webviews denied | `src/main/index.ts` |
| Only `http(s)` links leave the app, to the default browser. Hidden OSC 8 terminal hyperlinks show the real target and ask first | `src/main/index.ts`, `TerminalView.tsx` |
| Browser permissions denied except clipboard read/write | `src/main/index.ts` |
| Fuses: `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect` disabled; app only loads from `app.asar`; ASAR integrity checked on Windows; no extra `file://` privileges | `electron-builder.yml` |

### IPC

- Every message is checked to come from the app's own window and page (`checkSender`).
- Every argument is validated: host names (no option-like values), user names, ports, IDs, paths, sizes and enums (`src/main/validate.ts`).
- For saved sessions, connection details are read from disk in the main process, not taken from the UI.
- Passwords and passphrases travel only from UI to main process, never back.
- The UI can only download into the Downloads folder or a folder the user picked in a dialog during this session, can only reveal files it downloaded, and can't upload the app's own data folder.

### SSH

- Host key checking (trust on first use) with a SHA-256 fingerprint prompt. A **changed** key, or a key of a **different type** for a known host, shows a man-in-the-middle warning and disconnects by default. Known key types are requested first, so an attacker can't downgrade to a different key type.
- Modern algorithms only by default, in line with current OpenSSH: Curve25519/ECDH/DH-SHA2 key exchange; Ed25519, ECDSA and RSA-SHA2 host keys; AES-GCM/CTR (and ChaCha20-Poly1305 where the runtime supports it); SHA-2 MACs. SHA-1, CBC, `ssh-rsa` (SHA-1) and DSA need the per-session **Allow legacy algorithms** option.
- Strict key exchange is negotiated, mitigating the Terrapin attack (CVE-2023-48795).
- No agent forwarding and no X11 forwarding.
- Keyboard-interactive prompts are labelled as coming from the server.
- Server error text is stripped of control characters before it's printed in the terminal.

### SFTP

- Server-supplied file names are untrusted: on download, names are made safe for Windows (no `\`, `/`, `:`, reserved names like `CON`, trailing dots), and every destination is checked to stay inside the chosen folder.
- Downloads never overwrite existing files.
- Symlinked folders aren't followed when copying folders; depth and file-count limits stop runaway transfers.
- Pasting several lines into the terminal asks for confirmation first, since each line may run (on every host, with multi-exec).

### Storage

- Passwords and key passphrases are encrypted with Electron `safeStorage` (Windows DPAPI): only the Windows user who saved them can decrypt them.
- Session files are written atomically; `sessions.json` is validated again before it's used to connect.

### Build and supply chain

- GitHub Actions use read-only permissions by default; only the release job can write.
- Third-party actions are pinned to full commit SHAs; checkout doesn't keep credentials.
- CI verifies npm registry signatures, fails on known vulnerabilities in shipped dependencies, and runs unit tests plus SSH/SFTP tests against a real OpenSSH server.
- Dependabot opens weekly update PRs for npm packages and actions.
- Each installer ships with a `SHA256SUMS.txt`.

## Known limitations

- **Installer isn't code-signed**, so Windows can't verify who published it. Check the SHA-256 against `SHA256SUMS.txt` from the same GitHub build.
- **No post-quantum key exchange.** OpenSSH 9.x prefers `sntrup761x25519` / `mlkem768x25519`; the `ssh2` library doesn't implement them yet. Connections use Curve25519 instead.
- **Build-tool advisories.** `npm audit` reports moderate ReDoS issues in `minimatch`, used only by electron-builder at build time on our own config. Nothing from it ships in the app.
- **Saved secrets are only as safe as the Windows account.** Malware running as you can decrypt DPAPI data, as with any password manager.
- **Uploads can read any file you can.** Files dropped onto the window or picked in a dialog are trusted as your choice.
