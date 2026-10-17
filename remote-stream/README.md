# TunnelTerm SSH Stream

Install this companion **in the remote VS Code Tunnel workspace**. It runs in
the workspace extension host, starts an authenticated loopback WebSocket
broker, and resolves a reachable endpoint using `vscode.env.asExternalUri`.
The broker only connects to the remote machine's `127.0.0.1:22`.

The local TunnelTerm UI extension and CLI discover the endpoint through the
authenticated local bridge. Subsequent SSH bytes use a persistent stream,
with independent flow control and EOF per connection. Normal SSH public-key
authentication and host-key verification still take place inside this stream.

Both the local UI extension and this remote companion must be loaded. See
the main project's `docs/ssh-stream.md` for installation and verification.
