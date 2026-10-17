# Contributing

Run the automated checks before submitting a change:

```powershell
npm ci
npm ci --prefix remote-stream
npm run check
npm test
npm run test:mcp
npm run package:vsix
npm run package:stream
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

Tests use temporary local fixtures and mock providers; the default suite must
not depend on a personal tunnel, scheduled task or cloud login. CI covers
Windows/macOS/Linux on Node.js 20 and 22 and separately builds both VSIX files.
Real SSH checks in `docs/managed-service.md` are opt-in: use owned test PTYs,
preserve existing work and report their results separately from local tests.
