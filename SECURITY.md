# Security

## Reporting a problem

Open a private security advisory on GitHub (Security → Report a vulnerability) rather than a public issue.

## Threat model

SimSSH handles SSH credentials and connects to servers that may be compromised or hostile. The design assumes:

- **Remote servers are untrusted.** Terminal output, file names, error text and login prompts all come from the server and must never be able to run code locally, write outside the folder the user chose, or pose as the app.
- **The network is untrusted.** Host keys are verified; weak algorithms are off by default.
- **The UI is less trusted than the main process.** It renders server data, so the main process validates every request from it and never sends secrets back.
- **Other people using the same PC, and copied data folders,** must not be able to read anyone's sessions, saved passwords or host keys without that account's password.

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

### Accounts and storage

- Each account is one vault file (`accounts/<id>.vault.json`) holding its sessions, folders, saved passwords and trusted host keys. Only user names and ids are stored unencrypted (`accounts/index.json`).
- **Key derivation:** scrypt with N=2^17, r=8, p=1 and a random 16-byte salt per account (OWASP's recommended scrypt setting). Each guess costs about half a second and 128 MB, which makes offline guessing of a stolen vault expensive. Older settings are upgraded automatically at sign-in.
- **Encryption:** AES-256-GCM with a fresh random 96-bit IV on every write. The header (format, account id, KDF settings) is authenticated too, so any change to the file, or swapping one account's file for another's, makes it refuse to open.
- **Passwords:** at least 12 characters, no composition rules (in line with NIST SP 800-63B). The password itself is never stored; a wrong password simply fails to decrypt.
- **Sign-in:** the same error for unknown user names and wrong passwords, with equal work in both cases. After 3 failures for a user name, attempts are delayed (1 s, 2 s, 4 s… up to 60 s).
- **While signed in**, the key is held only in the main process. Every IPC call except sign-in is refused while signed out. Signing out closes all connections, forgets per-session folder permissions and overwrites the key in memory.
- **Change password** re-encrypts with a new salt and key and needs the current password. **Delete account** needs the password.
- **Rename to SimSSH (0.4):** accounts are moved from `%APPDATA%\Shellport\` to `%APPDATA%\SimSSH\` on first start, copied under temporary names and renamed into place before the originals are removed; existing data in the new folder is never overwritten. The vault format id stays `shellport-vault`, because it's part of every vault's authenticated header.
- **Upgrading from 0.1/0.2:** the first account created takes over the old `sessions.json`, DPAPI-encrypted `secrets.json` and `known_hosts.json`. The old files are deleted only after the new vault has been written and decrypted successfully.
- Files are written atomically (temp file + rename) and serialised, so a crash can't leave a half-written vault.

### Daily security check

- Runs every day on GitHub Actions (`security.yml`, logic in `scripts/security-update.mjs`).
- Only applies **compatible** fixes: `npm audit fix` without `--force`, and Electron updates within the current major version. Anything needing a major upgrade, or with no fix published, is reported as an issue instead of changed.
- A fix is only released after package signatures are verified and the typecheck, unit tests and SSH/SFTP tests pass on the fixed code, and the installer builds.
- Trade-off: fix releases go out without a person reviewing them, and the in-app updater offers them to everyone. That's why the job is limited to compatible updates of existing packages and never adds new ones.

### Updates

- Updates come only from this repository's GitHub Releases over HTTPS (`electron-updater`, GitHub provider). Nothing downloads until you click **Update**; pre-releases and older versions are never offered.
- The downloaded installer must match the SHA-512 in the release's `latest.yml`, or it isn't installed.
- The updater uses its own network session, separate from the UI's (which can't reach the network at all).
- Limitation: because the installer isn't code-signed, the update is only as trustworthy as the GitHub account that publishes releases. Signing would let the updater also verify the publisher.

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
- **No password recovery.** A forgotten account password means that account's data is gone. This is the trade-off for not being able to read it without the password.
- **Accounts are local.** They aren't synced or backed up anywhere; back up `%APPDATA%\SimSSH\accounts\` yourself if you need to.
- **No automatic lock yet.** The app stays signed in until you sign out or close it.
- **Malware running as you while you're signed in** can read the app's memory, as with any password manager. Encryption protects the data at rest, not a compromised PC.
- **Uploads can read any file you can.** Files dropped onto the window or picked in a dialog are trusted as your choice.
