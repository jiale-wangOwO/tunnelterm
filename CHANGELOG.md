# Changelog

## 0.1.1 - 2026-09-15

- Prevent `doctor` from hanging on Windows by probing the bundled VS Code CLI
  wrapper with a 10-second timeout.
- Add `doctor --code PATH` for selecting a specific VS Code installation.
- Launch VS Code asynchronously in `open` so bridge discovery does not wait for
  the lifetime of the GUI process.
- Report asynchronous VS Code launch failures without waiting for the full
  bridge-readiness timeout.

## 0.1.0 - 2026-09-15

- Add a raw interactive POSIX PTY with persistent shell state.
- Forward keyboard input, ANSI output, terminal resize, and Ctrl+C.
- Discover multiple active VS Code Tunnel windows without hard-coded names.
- Add `list`, `status`, `shell`, `exec`, `get`, `put`, `open`, and `doctor` commands.
- Restrict paths to configured remote roots and require a trusted workspace.
- Authenticate local queue requests with a per-instance random token.
