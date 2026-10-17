# Managed SSH service

This is the long-running entry point for the development checkout. `forward`
remains a lower-level diagnostic/compatibility command, not the recommended
service lifecycle. Both use ordinary SSH and normal host-key verification.

## Contract

- One loopback listener and persisted profile, independent of backend ports.
- Health means a **new** connection reaches an SSH-2.0 banner through the
  capability-authenticated broker. It does not claim user-key authentication;
  real ordinary OpenSSH regression separately checks that.
- Every admitted connection pins one backend epoch. An epoch never changes
  under a running SSH stream, and its input is never replayed into another
  SSH connection. Retired workers close only after their last lease ends.
- Startup may be offline while the fixed listener and lifecycle control remain
  available. Recovery is coalesced, startup/probes have bounded budgets, and
  failures back off from 1 second to at most 30 seconds.
- A recovering current epoch is probed again before depending on a new CLI
  worker. A fresh authenticated banner can restore it; an old held display alone
  cannot. Optional route-hint IPC failure never invalidates a successful banner,
  and late metadata from an older epoch cannot overwrite the current one.
- Only the default read-only CLI account check gets one 250 ms delayed retry
  for eligible transient failures. Both attempts share the first caller's
  deadline, with at most 5 seconds per call. Explicit authentication, executable,
  permission, configuration and cancellation failures are not retried. Metadata,
  carrier setup and established SSH input are never replayed by this policy.
- Healthy planned refresh continues serving new connections from the current
  epoch while an owned child loads current on-disk transport code. It switches
  only after the shadow worker passes health; old displays stay pinned.
- A stale local UI heartbeat or changed control-plane generation does not
  destroy an independently healthy data stream. The actual socket lifecycle,
  explicit stop, or real upstream loss ends that stream.

## Setup and commands

Prepare both TunnelTerm extensions as described in [streaming setup](ssh-stream.md).
Prefer one dedicated empty service workspace to a busy project window. Initial
workspace trust and account login belong to the user; never automate consent.

```powershell
tunnelterm service start --profile my-server -t /home/user/.cache/tunnelterm/ssh-service --port 22222
tunnelterm service status --profile my-server
tunnelterm service recover --profile my-server
tunnelterm service restart --profile my-server
tunnelterm service restart --profile my-server --direct
tunnelterm service check --profile my-server
tunnelterm service refresh --profile my-server
tunnelterm service drain --profile my-server
tunnelterm service stop --profile my-server
```

`start` is idempotent for the same live profile/target/port. It refuses conflicting
configuration rather than killing another listener. A fixed private IPC endpoint
claims the profile before configuration changes. `status` exposes safe state,
not a token or endpoint URI. `check` coalesces callers; `refresh` warms a shadow
without interrupting a healthy current route. `stop` refuses active connections.
`drain` stops admission and waits for existing displays; it never kills a remote
pane or model. Stop completes only after owned worker/relay cleanup.

`recover` is the first choice after a local network interruption. It checks the
existing profile without terminating its established SSH streams, or starts a
configured, enabled profile when it is stopped. `restart` replaces the profile's
daemon only when no SSH connection leases are active; it refuses to force-close
them. Both reuse the saved target, port and watcher settings. An intentionally
disabled profile requires an explicit `start`, not an implicit recovery.
The default command wait is bounded; `--wait-ms` may be set between 1 and 60000.
On Windows, `start`/`restart --direct` use the current caller's user-session
environment for the hidden daemon instead of asking the scheduled task to launch
it. This is an explicit maintenance fallback when the task environment fails but
the official CLI works in the current session. It preserves the saved watcher
configuration and only asks that verified watcher to adopt an already-ready
daemon. It does not copy credentials, elevate privileges, or force-close leases.
Inspect `outcome` and `next_action`: `not_ready` means readiness was not confirmed
within that command's budget, not that a still-running recovery was cancelled.
If `recovery_pending=true` and `next_action=wait_for_recovery_then_status`, inspect
`service status` again rather than restarting the owner. `ready` confirms banner reachability, not SSH user authentication or
long-term reliability. Never delete a maintenance lock or kill a PID just because
a command timed out; first inspect whether its owning operation is still running.

## 断网后恢复连接（中文操作指南）

先恢复本机网络，再在 PowerShell 中运行（`my-server` 换成已保存的 profile）：

```powershell
tunnelterm service status --profile my-server
tunnelterm service recover --profile my-server
```

- `outcome=ready` 且 `accepting_new=true`：转发通道已通过 SSH banner 检查。
  再用原 SSH 别名执行一次只读命令确认认证与执行，不要据此直接宣称模型任务完成。
- 仍为 `not_ready`：按 `next_action` 处理，不要反复新建 Codex 会话。
  如果**专用缓存服务窗口**显示 `Cannot reconnect`／`Disconnected`，只在该窗口
  点击 `Reload Window`，或用命令面板执行 `Developer: Reload Window`，随后重试 `recover`。
  不要重载业务项目窗口，也不要关闭远端工作 tmux。
- 后台自身需要更新或恢复且没有活动 SSH 连接时，运行
  `tunnelterm service restart --profile my-server`。若提示有活动连接而拒绝，先用
  `recover`；不要通过结束工作终端或强杀进程绕过保护。
- 若独立计划任务环境中的 CLI 检查失败，而当前用户的官方 CLI 检查成功，可显式使用
  `tunnelterm service restart --profile my-server --direct`。它在当前用户会话启动隐藏后台，
  保留原自启动配置，不复制凭据；仍遵守无活动连接才能重启的保护。
- 只有明确的 `Login required`／认证拒绝才进入官方登录流程。网络超时、检查取消、
  普通 CLI 错误不是登录失效的证据。由用户使用与 VS Code Tunnel 相同的账号完成
  `devtunnel user login`；GitHub 账号可选 `-g`，设备码流程可选 `-d`。
  详见 [Microsoft 官方 CLI 说明](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/cli-commands)。
  不复制其他应用的凭据缓存，不导出 token。
- 若专用窗口明确显示 `PortsPerTunnel`／HTTP 429 资源上限，重启后台并不能增加配额。
  必须先核实旧转发的工具归属、没有活动连接、远端端口不再监听，再清理那些失效条目；
  不清空整台机器的端口、不删除业务服务转发。新 companion 只保存工作区自己的监听
  端口并优先复用；认证 token／generation 仍在每次启动随机生成。已安装修订必须在
  专用窗口重载后才会生效，不能把安装成功当作运行中已加载。
  从旧版本首次迁移时，可在专用缓存工作区设置 `tunneltermStream.bootstrapPort` 为已核实
  属于该工作区的原 broker 端口，以复用现有私有映射而不再占新配额。默认 `0` 表示首次
  自动分配；已有保存端口优先，配置不能迁移或绕过坏状态，端口被占用时不会强占或
  随机重试。不要猜端口或把 SSH 的 `22` 当作 broker 端口。

若通过 Hub 或其他 SSH 终端客户端使用，通道恢复后应重新附着**原有会话**，而不是
新建替代工作。刷新画面不等于重建 SSH；结束工作终端也不是断线恢复操作。
各客户端对“关闭终端”的语义不同，可能结束远端 tmux 和其中的程序，操作前应先确认。
若回到 shell，先核实原会话，不要盲目 resume 或重发任务。TunnelTerm 不依赖某一种 Hub；
消费端只需要使用普通 SSH。

Use an ordinary SSH entry pointing to the configured listener. Keep the existing
HostKeyAlias, keys, username, and known_hosts when migrating an existing route.
Changing that entry's Port affects only future connections; live TCP connections
keep their original route. Coordinate a same-port replacement if a legacy daemon
still owns it. Do not force-stop legacy working displays to make space.

On Windows, profiles and logs live in `%USERPROFILE%/.tunnelterm/services` so
an ordinary login process and a packaged desktop host see the same files.
`TUNNELTERM_SERVICE_HOME` overrides that directory. The VS Code bridge discovery
directory remains independent. On other platforms the default is the
TunnelTerm state directory's `services/` folder.
Configuration stores the desired workspace and port. Private runtime records
contain a random local-control capability; private route records contain only
the tool's broker capability and generation-scoped candidate, never Microsoft,
GitHub, browser, SSH private-key, or Codex account credentials. These files use
private file modes on POSIX and the user's existing AppData permissions on Windows.
They must not be published or included in diagnostics. The control endpoint is
a profile-specific Windows named pipe / private Unix socket and requires the
control capability; it cannot execute arbitrary commands or change targets.

`worker-diagnostics.log` records fixed setup stages, per-worker connection
numbers, elapsed milliseconds, relay byte counts, FIN/OPEN flags, pending send
callback/output-drain waits and receive-idle time at relay exit. It never
records endpoint URIs, capabilities, SSH payload, raw CLI errors or account data.
This distinguishes a failed new-stream handshake from a stream which opened
and later stalled; a healthy banner probe alone does not establish bulk-transfer
or concurrent-query reliability. A diagnostic sink failure cannot change relay
cleanup. Workers loaded before this diagnostic was added retain their original
code until their leases end; a shadow refresh only updates future connections.
Banner health probes intentionally cancel their unauthenticated sockets after
the banner, so their relay exits can have `failed: true`. Correlate lifecycle
flags/counts with the supervisor's `route_ready` event instead of treating every
cancelled relay as a production SSH failure.
The same sanitized startup `detail`, `cause_kind`, numeric `exit_code` and fixed
`cli_hints` now survive worker IPC into `last_failure`. `CLI_CHECK_*` and
`CLI_METADATA_*` are different stages; an exit code of 1 without other evidence
is not an authentication-expiry diagnosis. Typed endpoint diagnostics distinguish
an unavailable provider, missing companion command and pending native mapping.
Their `next_action` is allowlisted; it is advice, never permission to reload or
restart a remote service. The UI/remote extensions must actually load the updated
source for the typed endpoint diagnostics to become available.

A route record can bootstrap a restarted daemon only for its exact workspace
and currently loaded bridge generation, and is still network-authenticated.
`--from-profile OTHER` bootstraps a same-workspace profile from a private verified
route record during controlled migration. This avoids reopening an already
stalled native mapper; it never bypasses capability or SSH authentication.

Filesystem health and SSH route health are separate. A selected UI bridge may
remain fresh and trusted while its VS Code filesystem probe reports
`PROVIDER_TIMEOUT` or `PROVIDER_UNAVAILABLE`. In those two cases only, SSH may
try an already-authenticated route from the exact same workspace and bridge
generation. This requires a fresh non-future heartbeat, explicit workspace
trust, a live bridge, SSH capability, and an unambiguous window. A cold prepared
endpoint is not verified evidence. Permission/path errors, revoked trust,
stopped or stale bridges, a new generation, and unknown health failures cannot
use this fallback. General MCP command/file operations retain their original
`active`/`ready` gate.

Every new SSH stream still authenticates to the private broker, and the managed
service must observe a fresh SSH banner before accepting new connections. A
display already pinned to an old epoch can remain online even when new-query
admission fails; neither its screen nor filesystem health substitutes for that
new-connection test. An explicitly rejected saved endpoint is reported across
worker IPC and discarded only if the supervisor still owns that exact hint;
unknown state or a temporary CLI/network failure does not justify deleting it.
No endpoint capability is exposed in status or logs.

Warm startup allows a compatible saved route to warm within the existing budget
without needlessly reopening a stalled native mapper. If its mapping fails, it
requests one fresh endpoint, when the selected provider is active, within the same 30-second
total warm budget; a saved route is not authoritative merely because the local
UI generation is unchanged. New-connection gateway-mapping failures also evict
the failed candidate before one fresh lookup. These retries occur only before
OPEN/input consumption. An established SSH stream is never replayed.
If the failed hint consumes the budget or the single cold fallback also fails,
the worker marks that hint invalid and the supervisor discards the matching
route hint before its next recovery, recording its invalidation in private state
when that write succeeds. Authentication/executable failures do not
discard credentials or rewrite configuration. This prevents unchanged local UI
identity from trapping all future recovery attempts on one stale saved port.
The official CLI's required `list` and `show` discovery calls use that existing
warm window instead of an independent shorter 12-second combined cutoff. Warm
expiry closes the gateway and aborts its owned metadata subprocesses; this does
not increase the 30-second absolute warm deadline or bypass account/port checks.

## Limits, not hidden promises

The VS Code service window and remote companion must still exist. Expired login,
permanently broken native mapping with no usable candidate, an offline remote
host, or stopped sshd cannot be repaired by inventing credentials or replaying
SSH. The service reports `AUTH_REQUIRED`, `MAPPING_UNAVAILABLE`,
`BRIDGE_UNAVAILABLE`, or `ROUTE_UNAVAILABLE` and retries safely. It does not
restart arbitrary VS Code windows. A broken established SSH session cannot be
transparently resurrected; a terminal's tmux reconnect logic owns that behavior.

The daemon must also be running. On Windows, an opt-in installer registers a
limited current-user logon task and an independent hidden watcher. It uses no
administrator service or password. It adopts a live profile instead of duplicating
it, restarts an unexpectedly exited daemon with bounded backoff, and respects
intentional stop/drain. Scheduled control can be unavailable on a restricted
machine; the installer reports its current-user Startup shortcut fallback.

```powershell
.\scripts\install-service-autostart.ps1 -ProfileName my-server -StartNow
```

An optional `-ServiceFolderUri URI -CodePath CODE_CMD` permits opening only the
explicitly configured dedicated cache workspace when its local UI host is
missing. It never reloads an existing window or opens a business project. A trust
or login prompt still requires the user. The tool's signed Microsoft CLI should
be installed under `%USERPROFILE%/.tunnelterm/bin` and logged in through its
normal account flow in the same user-session context as the independent service.
Never copy credentials out of another application's private cache to make it work.

The real Windows validation covers daemon exit and restart plus transport readiness;
an actual OS reboot has not been performed. macOS/Linux service-manager installers
are not included; the portable foreground daemon and lifecycle API are available.

## Evidence-based validation

```powershell
npm run check
npm test
node scripts/verify-ssh-stream.mjs SSH_ALIAS 3 LISTENER_PORT
node scripts/verify-ssh-query-recovery.mjs WORKSPACE SSH_ALIAS LISTENER_PORT --existing 18
```

The stream verifier's default binary-transfer test budget is 20 seconds, not a
production transport limit. For one bounded slow-provider diagnostic, set
`TUNNELTERM_TEST_TRANSFER_TIMEOUT_MS=60000` and append `--binary-only` after the
alias, round count and listener port. It prints only byte-count progress and
checks the full 1 MiB SHA-256. A passing slower retry does not erase an earlier
deadline failure or establish a latency guarantee; record both results.

The latter owns two standard SSH PTYs and one temporary log fixture. It verifies
metadata, repeated UTF-8 reads using stdin EOF, and 1 MiB SHA-256 while both PTYs
remain alive. During it, `service refresh` can verify an epoch change without a
port change, additional-query failure, or old-PTY loss. Test idle recovery and
daemon restart separately. Local fault injection covers failed health, coalescing,
bounded cancellation/late-worker disposal, safe stop/drain, profile exclusivity,
and token redaction. These checks do not alone establish every OS or remote host.
