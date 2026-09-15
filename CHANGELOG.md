# Changelog

## 0.1.0 - 2026-09-15

- Add a raw interactive POSIX PTY with persistent shell state.
- Forward keyboard input, ANSI output, terminal resize, and Ctrl+C.
- Discover multiple active VS Code Tunnel windows without hard-coded names.
- Add `list`, `status`, `shell`, `exec`, `get`, `put`, `open`, and `doctor` commands.
- Restrict paths to configured remote roots and require a trusted workspace.
- Authenticate local queue requests with a per-instance random token.
