# Security policy

TunnelTerm intentionally provides command execution with the permissions of the
remote VS Code user. Only use it with tunnels and workspaces you are authorized
to access.

## Security boundaries

- VS Code Remote Tunnels and the optional official Microsoft `devtunnel` CLI
  own account authentication. TunnelTerm never reads or exports their account
  tokens, browser cookies, or SSH private keys. Trust/login/OTP/consent require
  the user; the service does not automate them.
- The bridge activates only in a trusted remote workspace.
- Working directories and file transfers are restricted to `allowedRoots`.
- Local queue messages require a random token stored in the current user's
  local state directory.
- The base terminal/file bridge uses no listening TCP port. Optional streaming
  SSH uses a local loopback entry and a capability-authenticated remote
  loopback WebSocket broker, forwarded privately by VS Code/Dev Tunnels. The
  broker can reach only the remote host's existing `127.0.0.1:22`; it does not
  install sshd, create a remote account, or publish anonymous SSH access.
- SSH user authentication and host-key verification remain end-to-end. Do not
  disable them to work around a tunnel failure.
- Managed lifecycle control requires a per-profile random capability over a
  private named pipe/Unix socket. Safe restart refuses active leases. Neither
  restart nor recovery is permission to kill an unrelated PID or remote pane.
- Runtime/route records contain tool-issued private capabilities. Do not
  publish these records or raw logs. Fixed diagnostic fields do not include
  account credentials or endpoint URLs.
- Remote helper files are placed in a token-scoped directory under `/tmp` and
  created with user-only permissions where supported.

The local machine, VS Code process, extension host, and remote user account are
all inside the trusted computing base. A process running as the same local user
can access the bridge, just as it can control that user's terminal sessions.
Configured roots constrain cwd/file APIs, not the authority of an arbitrary
shell command executed as the remote user. MCP local upload/download tools also
access local files explicitly selected by the calling client. This is not a
sandbox for untrusted agents or commands.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/jiale-wangOwO/tunnelterm/security/advisories/new).
Do not post credentials, tunnel identifiers, or live remote paths in public
issues. Include affected versions, impact, and a minimal reproduction when
possible. You should receive an initial response within seven days.
