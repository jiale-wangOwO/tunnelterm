# Changelog

## Unreleased

### Health, recovery and publication hygiene

- Distinguish local UI heartbeat from real remote-provider readiness with bounded,
  single-flight probes, typed safe endpoint diagnostics and stale-result fencing.
- Add profile-based `service recover` and lease-protected `service restart`, with
  an explicit Windows `--direct` fallback, honest pending/not-ready outcomes,
  configuration preservation and Chinese recovery instructions.
- Separate explicit login refusal from network, cancellation and ordinary CLI
  failures. Keep diagnostics allowlisted through child IPC and public status;
  never log account output, endpoint URLs or private capabilities.
- Persist each workspace's broker port; support an explicitly verified first
  bootstrap port and fail closed on conflicts instead of accumulating mappings.
- Add 15-second WebSocket control ping and safe close diagnostics without sending
  terminal keystrokes or replaying SSH input.
- Package both local and remote extensions in CI, include MCP protocol smoke
  coverage, check every JavaScript/available PowerShell source, and remove
  machine-specific setup from public examples and diagnostic launchers.

### Managed SSH transport

- Re-probe recovering current routes before requiring cold CLI startup; keep
  successful SSH health independent of bounded optional route-hint metadata and
  fence late health/persistence against newer epochs.
- Retry only eligible read-only account preflights once within the original
  deadline; never retry explicit authentication/configuration failures or replay
  metadata, carrier setup or SSH input.
- Preserve allowlisted setup stages through worker IPC/status, distinguish
  provider/companion/native-mapping failures, and report pending recovery without
  recommending repeated restarts.
- Add a fixed-entry managed SSH service with persistent profiles, authenticated
  private lifecycle control, real new-connection banner health, bounded/coalesced
  recovery, and exponential retry backoff.
- Pin active streams to backend epochs; warm replacement workers separately,
  load transport updates in owned child processes, and drain old epochs without
  changing the consumer's SSH interface or killing working displays.
- Stop treating a local bridge heartbeat loss as permission to close healthy
  data streams. Keep account consent and actual broken-session reconnect outside
  the transport's automatic recovery authority.
- Revalidate a warm or authenticated same-generation route on each new stream
  instead of reopening native mappings per auxiliary SSH query. Evict a failed
  pre-OPEN route and try fresh discovery once without replaying SSH input or
  disconnecting independent held streams.
- Prefer exact workspace matches over nested directory prefix matches.
- Verify repeated ordinary SSH exec/stdin-EOF queries and binary data while two
  owned PTYs remain connected, with mapping faults confined to an isolated port.
- Send a protocol WebSocket Close on local cancellation before bounded carrier
  termination, preserving ordered stdin EOF and binary reverse output. Verify
  hard-disconnect cleanup independently of established shared listeners.
- Settle relays only after bounded Close cleanup, and drain owned relays before
  whole-forward carrier shutdown to prevent a premature carrier-stop race.
- Bound native endpoint mapping and reject in-flight calls on disposal while
  retaining the ready broker and active streams.
- Share one pending native mapping per generation; keep retries from accumulating
  additional provider calls after a timeout.
- Bound gateway teardown independently of opaque metadata lookup promises and
  apply a total metadata lookup budget.
- Support an empty, user-trusted cache workspace in a separate service window
  for recovery without reloading working project windows.

### Streaming SSH and Codex integration

- Add a remote workspace companion and a native streaming SSH forward with
  per-connection full duplex, backpressure, half-close, and failure isolation.
- Report loaded UI source hash and runtime generation; fail clearly when an
  old extension is loaded or the remote companion is unavailable.
- Resolve fresh endpoints by stable workspace identity after bridge restarts.
- Add local TCP regression and bounded four-connection ordinary OpenSSH checks.
- Keep established SSH streams alive when a single endpoint URI mapping fails;
  retry failed broker startup independently of per-connection mapping requests.

- Add a stdio MCP server for Codex with connection discovery, structured remote
  execution, file operations, and persistent PTY session tools.
- Bound command output, retain overflow across PTY polls, and close MCP-owned
  sessions when the MCP process disconnects.
- Document Codex registration, target selection, and remote-workspace workflows.

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
