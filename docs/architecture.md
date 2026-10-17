# Architecture

## Components

1. `bin/tunnelterm.mjs` is the local command-line client. Interactive mode puts
   the local terminal into raw mode and relays bytes without interpreting ANSI
   control sequences.
2. `src/extension.cjs` is a local VS Code UI extension. It discovers the Remote
   Tunnel workspace, enforces configured path roots, and relays operations with
   public VS Code APIs.
3. `remote/tunnelterm_agent.py` runs as the remote VS Code user. In interactive
   mode it owns the pseudo-terminal and child shell. In exec mode it runs one
   captured command with a timeout.
4. `bin/tunnelterm-mcp.mjs` exposes the bridge through local stdio MCP tools.
   Its PTYs are owned by that MCP process and closed on disconnect; it does not
   attach to or resume an unrelated remote agent.
5. `remote-stream/` is an optional workspace extension. It keeps a stable
   workspace-scoped broker port, fresh per-runtime authentication and ordered
   binary/FIN/OPEN WebSocket streams to the remote host's existing SSH server.
6. `src/managed-service.mjs` owns the fixed loopback SSH entry and connection
   leases across backend epochs. A replacement is adopted only after a real
   banner probe; existing streams are pinned until they finish. Profile control,
   persistence, official-CLI mapping and child ownership are separate modules.

## Local discovery and request protocol

Each connected VS Code window creates:

```text
<state>/instances/<instance-id>/
  status.json
  token
  queue/
    <uuid>.request.json
    <uuid>.processing.json
    <uuid>.response.json
```

`status.json` is refreshed every five seconds. Clients treat an endpoint as
active only when it is ready and its heartbeat is less than twenty seconds old.
`bridge_alive` describes the local UI extension; `remote_ready`/`ready` additionally
require a bounded, single-flight stat of the selected remote workspace. A
timed-out native operation is not piled up again on every heartbeat. SSH can
try a same-generation verified route under narrowly guarded transient failures;
ordinary remote commands and files still require provider readiness.
Every request contains protocol version 1, a UUID, and the instance token.
Temporary files are atomically renamed before consumers see them.

The operations are `status`, `exec`, `read`, `write`, `session.start`,
`session.input`, `session.resize`, `session.poll`, and `session.close`.
The optional SSH path resolves `tcp.stream.endpoint` through the queue, then
carries SSH bytes over WebSockets rather than file polling. The official
Microsoft CLI handles private forwarding without exporting account credentials.

## Remote session protocol

The remote runtime lives under a randomized path:

```text
/tmp/tunnelterm-<instance>-<token-prefix>/
  tunnelterm_agent.py
  agent.sha256
  jobs/<uuid>/
  sessions/<uuid>/
    in/<sequence>.bin
    out/<sequence>.bin
    resize.json
    ack.json
    state.json
    close
```

The extension writes ordered input packets. The Python helper writes ordered
PTY output packets. The extension deletes delivered output and advances
`ack.json`; the helper pauses PTY reads after 1024 unacknowledged 64 KiB chunks.
This lets the remote PTY apply natural backpressure.

## Trust model

VS Code authenticates the tunnel and chooses the remote identity. TunnelTerm
does not implement, bypass, or inspect that authentication. The local OS user,
VS Code UI extension host, remote VS Code server, and remote account are trusted.
Workspace Trust gates activation because a bridge endpoint intentionally allows
remote command execution.
