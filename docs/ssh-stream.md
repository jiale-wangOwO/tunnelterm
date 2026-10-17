# Streaming SSH through a VS Code Tunnel

The legacy TCP experiment uses file packets for each SSH byte exchange. It
cannot guarantee normal SSH connection budgets under overlapping sessions.
The streaming path uses the editor's port forwarding and a small remote
companion. Each local SSH socket has an independent authenticated WebSocket
to remote `127.0.0.1:22`. The bridge queue is used only to resolve the endpoint.
When VS Code returns a private `https://...devtunnels.ms` endpoint, the official
Microsoft `devtunnel` CLI provides an authenticated loopback mapping first.
TunnelTerm connects its WebSocket to that mapping, rather than treating the
browser login redirect as a stream. The CLI owns its account authentication;
TunnelTerm does not read VS Code tokens or browser cookies.
The client refuses legacy loaded extensions rather than silently falling back
to the slow path. `proxy --legacy-files` keeps the earlier experiment available.

## Prepare both extensions

Run `npm ci` in the repository, then `npm ci --prefix remote-stream`.
From the repository:

```powershell
npm run package:vsix
npm run package:stream
```

This creates the local UI package `tunnelterm-vscode-0.1.3.vsix` and the remote
companion `remote-stream/tunnelterm-stream-0.1.3.vsix`. These are local development
artifacts; building them does not publish a Release.

Install the UI package **locally**, and the companion **in the chosen Remote
Tunnel workspace**, through Extensions: Install from VSIX. Confirm that
TunnelTerm SSH Stream is enabled in the remote host, not just installed locally.
Installing an update is insufficient until the selected extension host loads it.
Reload only the selected VS Code window after saving work and accounting for
its active tasks. This interrupts existing bridges/sessions in that window.

`tunnelterm status -t <workspace-path>` reports the loaded UI extension's
`extensionVersion`, `sourceSha256`, `runtimeGeneration`, and `capabilities`.
`capabilities.ssh_stream` must equal 1. Starting a forward checks that the
remote companion is available as well, before opening a listening socket.

## Start a loopback endpoint

For a persistent service, use a dedicated empty cache workspace instead of a
busy project window. `node scripts/create-service-workspace.mjs <existing-target>`
creates `~/.cache/tunnelterm/ssh-service` through the existing exec interface and
prints its remote folder URI. Open that URI in a separate VS Code window with
`code --new-window --folder-uri URI`. Any Workspace Trust prompt is for the user
to confirm; the tool never changes trusted folders or confirms dialogs.
Keep that service window connected (it may be minimized).

The `0.1.3` companion bounds endpoint mapping and retains only one pending native
mapping per generation. If VS Code's port provider hangs after reconnection,
retries fail promptly rather than creating more indefinite native waits. A ready
local heartbeat does not by itself prove the remote mapping is healthy. An
independent service window can recover its own provider without reloading a
working project window. Gateway cleanup does not await an opaque stuck lookup,
and metadata lookup has one total budget across candidates.

Private Dev Tunnels endpoints need the official CLI installed and logged in
with the same account as the existing VS Code Tunnel. On Windows, download the
Microsoft-signed executable with the supplied installer (defaulting to
`%USERPROFILE%/.tunnelterm/bin/devtunnel.exe`), or set `TUNNELTERM_DEVTUNNEL`
to your installed CLI path. The shared user directory avoids packaged-app
AppData virtualization differences with an independent service. Complete login yourself:

```powershell
.\tools\install-devtunnel.ps1
& "$env:USERPROFILE\.tunnelterm\bin\devtunnel.exe" user login -g
```

Use `user login` without `-g` for a Microsoft account. Login and consent are
not automated by TunnelTerm. The tunnel stays private. The official CLI may
create loopback mappings for the ports published by that selected tunnel;
TunnelTerm consumes only its broker's mapped port. One official connection
is shared across independent SSH sockets and refreshed ports.
The HTTPS host's DNS alias may differ from its CLI Tunnel ID. TunnelTerm uses
official read-only metadata filtered by the selected VS Code tunnel label, then
checks the exact broker port URI to select the actual resource. No transient ID
needs to be maintained by the user.

```powershell
node .\bin\tunnelterm.mjs forward --target /home/user/project --port 22222
```

For a hidden Windows process with logs and identity metadata:

```powershell
.\scripts\start-ssh-forward.ps1 -Target /home/user/project -Port 22222
```

This launcher is idempotent only for its own matching PID, creation time,
command line, target, and loopback listener. It refuses to replace a different
listener. It never kills unrelated processes. It writes runtime metadata and
logs under the TunnelTerm state directory.

Prefer a unique workspace path to a transient instance id. The forward derives
and keeps the workspace identity, and discovers its current bridge on every
new connection. Reloading a bridge closes existing streams; a new connection
acquires a fresh endpoint once the workspace becomes ready again. The listener
remains available after client resets and individual channel failures.
An endpoint URI mapping error fails only that endpoint request. It preserves
the ready broker and existing SSH streams; a subsequent request can resolve
the URI again. Only broker startup failure resets the startup state, and
extension disposal closes its owned broker.

Use an ordinary OpenSSH host entry:

```sshconfig
Host my-server-via-tunnelterm
    HostName 127.0.0.1
    Port 22222
    User your-remote-user
    HostKeyAlias my-server-via-tunnelterm
    ControlMaster no
    ControlPersist no
```

Use normal SSH public keys and known_hosts verification. Keep the existing
known_hosts alias when replacing a previously configured TunnelTerm forward.
The stream broker has its own random per-runtime token, does not read account
credentials, and binds only to remote loopback. The local listener binds only
to `127.0.0.1`.

The official client is warmed before the SSH listener is advertised. This
startup step has a 30-second bound and is separate from SSH connection time.
Per-connection endpoint lookup is bounded to 5 seconds, mapped-port lookup to
1.5 seconds, and stream establishment to 2.5 seconds; the accepted socket is
closed after a 7.5-second overall setup budget. These are failure
bounds, not evidence that a particular real tunnel meets the budget. Measure
that tunnel with the ordinary SSH regression below before integrating it.

## Verify

```powershell
node --test .\test\ssh-stream.test.mjs
node .\scripts\verify-ssh-stream.mjs my-server-via-tunnelterm 3
```

The real SSH regression retains a `-tt` foreground PTY while three independent
`-T` connections perform identification, PTY size control, and directory queries.
It repeats the exercise with `ConnectTimeout=8` and 12-second control budgets,
then verifies binary round-trip SHA-256 and stdin EOF within 20 seconds. It
does not start models or worker agents, alter SSH authentication, or disable
host-key checks.
For no-input control commands launched by Node on Windows, close the child's
unused stdin (or use OpenSSH `-n`). Actual testing found that leaving that pipe
open could stall a non-verbose OpenSSH call after its first output packet. This
is distinct from the persistent display PTY and binary transfer, which retain
their input streams until their work is finished. The regression sends normal
SSH-channel EOF for no-input commands and does not increase its time budgets.

Hard local disconnect sends a WebSocket Close before a bounded one-second
termination fallback. Abruptly destroying only the carrier's loopback TCP can
leave the broker's remote socket alive through a layered private tunnel. The
Close handshake resumes paused receive flow and ignores buffered application
data after cancellation. Ordinary stdin EOF still sends ordered stream FIN;
it does not cancel the reverse direction or truncate binary EOF trailers.
Relay completion includes that bounded Close cleanup. Whole-forward shutdown
waits for its already-started relays before stopping its own official carrier;
the stdio proxy's `finally` also runs only after relay cleanup. This does not
await pending endpoint discovery, and it does not stop another forward's
carrier. A peer that stops reading Close cannot hold teardown indefinitely.

For a local-relay-only update, start the new code on a separate unused loopback
port, leaving the established listener and both VS Code windows untouched.
`node scripts/verify-ssh-stream.mjs SSH_ALIAS 1 ISOLATED_PORT` overrides only the
port, retaining the alias's ordinary authentication and host-key policy. This
does not move existing connections. Reconnect clients to the new port only
after coordinating the display interruption; existing tmux panes are not
destroyed by starting a separate listener.
`node scripts/probe-ssh-disconnect.mjs SSH_ALIAS SERVICE_WORKSPACE` creates its
own ephemeral listener and a nonce-tagged remote sleeper, kills only its own
local SSH process, checks remote cleanup, and uses PID/start-tick/argv guards
for any necessary test cleanup. It does not exercise a consumer's full tmux
reconnect/resize protocol; that still requires its separate integration test.

Local transport regression covers four simultaneous binary streams, slow-reader
backpressure, EOF trailers, reset isolation, authentication rejection, bounded
failure, and reconnection across bridge identity changes. Local tests alone do
not establish Windows → VS Code Tunnel → remote SSH performance.

## Mapping-provider outage recovery

A ready bridge and working existing PTYs do not prove that new SSH connections
can open. The forward resolves and warms one route at startup. Each accepted
connection selects the current bridge identity and revalidates its in-memory
route through a new broker capability-authenticated connection. This avoids
reopening the editor's native mapping on every auxiliary SSH query. An initial
warm route is not promoted as verified until it receives an actual broker OPEN.
A failed pre-OPEN handshake evicts the route and permits exactly one fresh
native lookup and retry, before any SSH input has been consumed. After OPEN a
stream never replays input into another SSH session. A new bridge generation
cannot reuse the route. No account credential, browser cookie, or VS Code
authentication token is read. Normal EOF and other established streams remain
unaffected.

[VS Code's API contract](https://code.visualstudio.com/api/references/vscode-api#env)
warns that external URIs may become invalid when a forwarding tunnel changes.
Therefore the routing candidate is never treated as a permanently valid URI:
every new connection must revalidate it, and failure forces fresh resolution.
A cold start
with no verified candidate still needs a functioning native mapper. If the
current service window's provider remains stuck, prepare a separate service
window without reloading any work window. A local code edit cannot retrofit
candidate state into an already-running forward.

```powershell
node scripts/create-service-workspace.mjs EXISTING_SERVICE_INSTANCE --isolated
# Open the printed empty cache folder URI in a separate VS Code window.
node scripts/verify-ssh-query-recovery.mjs ISOLATED_WORKSPACE SSH_ALIAS 22225
```

The latter owns only its isolated listener and two test SSH PTYs. It creates
one temporary JSONL log, reads its metadata and UTF-8 bytes through additional
standard SSH exec queries with stdin EOF, and verifies a 1 MiB binary round
trip. The mapping fault is explicitly
injected only into that listener's endpoint lookup after initial successful
connections; it does not disrupt the actual provider or user's terminals.
It closes its own listener and carrier afterward. Trust prompts require the
user; the helper never changes trust settings. Exact parent/child workspace
selection prevents a nested test folder from taking the parent's identity.
For an already-started isolated forward, append `--existing 18` to verify 18
real log reads with two held connections and no injected mapping failure. That
mode cleans up only its own SSH helpers/log fixture and leaves the listener
running; it never stops a formal forward.

Replacing a running formal listener can interrupt its established displays.
Do not stop it to deploy recovery without user confirmation or coordinated
drain. Existing displays can instead remain on the old listener while a
separately verified port serves new ordinary SSH connections; changing the
user's SSH routing requires explicit coordination as well. Neither option
requires tunnel-specific changes in an SSH consumer.

The deployment helper `node scripts/deploy-stream.mjs <workspace> --install`
uses the remote VS Code CLI to install the companion without project writes or
automatic window reload. `--inspect` checks remote registration and source
hashes. Installation is distinct from runtime loading.

Official references: [CLI authentication and connection](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/cli-commands)
and [Windows CLI download](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/get-started?tabs=windows).
