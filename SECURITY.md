# Security policy

TunnelTerm intentionally provides command execution with the permissions of the
remote VS Code user. Only use it with tunnels and workspaces you are authorized
to access.

## Security boundaries

- Authentication remains owned by VS Code Remote Tunnels. TunnelTerm never
  reads or exports VS Code account tokens.
- The bridge activates only in a trusted remote workspace.
- Working directories and file transfers are restricted to `allowedRoots`.
- Local queue messages require a random token stored in the current user's
  local state directory.
- No TCP port, remote login service, or additional remote account is created.
- Remote helper files are placed in a token-scoped directory under `/tmp` and
  created with user-only permissions where supported.

The local machine, VS Code process, extension host, and remote user account are
all inside the trusted computing base. A process running as the same local user
can access the bridge, just as it can control that user's terminal sessions.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/jiale-wangOwO/tunnelterm/security/advisories/new).
Do not post credentials, tunnel identifiers, or live remote paths in public
issues. Include affected versions, impact, and a minimal reproduction when
possible. You should receive an initial response within seven days.
