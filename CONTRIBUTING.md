# Contributing

Run the automated checks before submitting a change:

```powershell
npm install
npm run check
npm test
```

For an end-to-end development run:

```powershell
npm link
tunnelterm open YOUR_TUNNEL /absolute/remote/path --dev
tunnelterm list
tunnelterm shell
```

Verify these behaviors manually:

- A colored prompt renders correctly.
- `cd`, `export`, and shell history persist.
- Ctrl+C interrupts `sleep 30` without disconnecting the shell.
- A full-screen terminal program starts and exits cleanly.
- Resizing the local terminal updates `stty size` remotely.
- `exec` returns stdout, stderr, and a nonzero exit code correctly.
- `get` and `put` preserve binary SHA-256 hashes.
- Paths outside `tunnelterm.allowedRoots` are rejected for cwd/get/put.
- An untrusted workspace does not register a ready bridge.
- Closing the VS Code window makes its instance stale.

Do not include tunnel names, usernames, private remote paths, tokens, or other
credentials in tests, logs, screenshots, issues, or commits.
