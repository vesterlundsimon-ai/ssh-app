# Shellport

A tabbed SSH and SFTP client for Windows, in the spirit of MobaXterm.

## What it does

- **Tabbed SSH terminal** with password, private key (OpenSSH/PEM, encrypted or not) and SSH agent (Windows OpenSSH agent or Pageant) login. Keyboard-interactive and 2FA prompts are supported.
- **Saved sessions** in nested folders, with search, colours, notes, drag-and-drop to reorganise, duplicate and quick connect (`user@host:port`).
- **Saved passwords and key passphrases** are encrypted with your Windows account (DPAPI via Electron `safeStorage`). They never reach the UI layer.
- **Host key checking**: first connection shows the fingerprint; a changed key shows a man-in-the-middle warning and refuses unless you replace it.
- **SFTP file browser** for the active tab: drag files or folders in from Explorer to upload, double-click to download, rename, new folder, recursive delete, sortable columns, transfer progress.
- **Multi-exec**: type once, run on every ticked tab. Broadcasting tabs and the banner turn orange so you always know.
- Copy on select, right-click paste, Ctrl+Shift+C/V, clickable links, Enter to reconnect a dropped tab.

Security design, controls and known limitations are in [SECURITY.md](SECURITY.md).

## Install

Download `Shellport-Setup-x.y.z.exe` from the [Releases page](../../releases) (or from the latest **Build** run under Actions → Artifacts) and run it.

The installer isn't code-signed, so Windows SmartScreen will say "Windows protected your PC". Click **More info → Run anyway**.

Your data lives in `%APPDATA%\Shellport\` (`sessions.json`, `secrets.json`, `known_hosts.json`). Saved secrets only decrypt for the Windows user who saved them, so copying the folder to a friend shares sessions but not passwords.

## Develop

Requires Node.js 22.

```sh
npm install
npm run dev          # run with hot reload
npm run typecheck
npm run dist:win     # build the installer into dist/ (on Windows)
```

### Tests

`npm run test:unit` checks the security helpers (file name sanitising, input validation, algorithm policy).

`scripts/backend-test.ts` runs the real SSH and SFTP code against an SSH server (auth flows, host key rejection, uploads, downloads, hostile file names, rename, recursive delete). CI starts a throwaway OpenSSH server and runs it on every push. To run it yourself:

```sh
TEST_HOST=... TEST_PORT=22 TEST_USER=... TEST_PASSWORD=... \
TEST_KEY=path/to/unencrypted_key TEST_ENC_KEY=path/to/encrypted_key TEST_KEY_PASS=... \
npm run test:backend
```

### Releasing

Push a tag like `v0.2.0` (after bumping `version` in `package.json`). The **Build** workflow builds the installer on Windows and attaches it to a GitHub release.

## Layout

```
src/main/        Electron main process: SSH (ssh2), SFTP, storage, host keys, IPC
src/preload/     The narrow API the UI is allowed to call
src/renderer/    React UI: session tree, tabs, xterm.js terminals, SFTP panel
src/shared/      Types shared by both sides
```

## Roadmap

- SSH tunnels (local, remote, SOCKS)
- Jump hosts / ProxyJump
- Import sessions from PuTTY and `~/.ssh/config`
- Local shell tabs (PowerShell, WSL) and serial ports
- Macros
- X11 forwarding (using VcXsrv or WSLg as the X server)
- Edit remote files in a local editor and upload on save
