# 断网后恢复 TunnelTerm

断网可能同时断开四层：VS Code 的远端连接、TunnelTerm 后台路由、普通 SSH 显示连接，以及 Hub 的附着。恢复其中一层不代表其他层已恢复。远端 tmux/Codex 通常仍在；不要为了恢复显示而重启模型、执行 resume 或重建工作 pane。

首次配置过 profile 后，日常只需要记住 profile 名，不用再输入远端目录、端口或进程 PID：

```powershell
tunnelterm service status --profile my-server
tunnelterm service recover --profile my-server
```

开发目录中也可以用 Windows 包装脚本：

```powershell
.\scripts\service.ps1 status my-server
.\scripts\service.ps1 recover my-server
.\scripts\service.ps1 restart my-server
```

`recover` 检查一条新连接能否到达 sshd 的 banner，并在需要时恢复后台；现有显示连接不会被它强行关闭。服务已停止时，它用保存的 profile 启动服务。返回 `outcome: ready` 才表示入口可接入；仍需普通 SSH 做用户认证与命令执行验收。

如果返回 `not_ready`，同时 `recovery_pending=true`、`next_action=wait_for_recovery_then_status`，说明这次命令的等待期限到了，后台仍在恢复。先再次运行 `tunnelterm service status --profile my-server`，不要连续 restart。稍后必须以新的 `phase=ready`、`accepting_new=true` 和实际 SSH 成功确认恢复，不能把旧的 `not_ready` 当成永久失败，也不能只看 PID 存活。

`restart` 是维护入口：沿用保存的目标、端口、专用缓存窗口位置和 watcher 设置，正常停止后加载当前代码再启动。默认拒绝任何活动连接，没有 force 参数。CLI 预检后如果又来了连接，daemon 的 stop 会再次检查并拒绝。它不向远端 pane 发命令，不结束远端 tmux/Codex。被显式禁用的 profile 不会被 restart 偷偷启用；需要启用时明确执行 `service start --profile NAME`。

同一 profile 的维护命令有锁。不要删除仍在执行的命令的锁；如果命令异常退出，先核对锁文件内的 PID 和实际进程，确认没有维护正在运行，再人工处理该 profile 的 `.maintenance.lock`。工具不会猜测杀 PID，也不会自动删除不确定的旧锁。

## 推荐故障顺序

1. 网络恢复后先运行 `recover`，查看 `phase`、`outcome`、`last_failure.code` 与 `next_action`。退出码非零就是没有确认恢复，不能只看到进程存活就宣布成功。
2. 若专用 VS Code 缓存窗口显示 **Cannot reconnect / Disconnected**，只在这个工具配置的空缓存窗口执行 Reload Window，再运行 recover。不要重载有业务工作的窗口。服务命令不会偷偷重载任何窗口。
3. `NETWORK_UNAVAILABLE`、`CANCELLED`、`CLI_FAILED` 不表示登录过期。先检查网络/官方 CLI，再 recover。仅明确 `AUTH_REQUIRED`（例如官方 CLI 返回 Login required）才由本人完成官方登录；不要复制其他应用的凭据缓存。
4. 如果要加载主管代码更新，确认已经没有 SSH 显示连接后运行 `restart`。若被拒绝，先正常断开显示或等待连接结束，不能强杀远端工作进程。
5. 验证普通 SSH：

   ```powershell
   ssh -n -T -o BatchMode=yes -o ControlMaster=no my-server-via-tunnelterm "printf 'SSH_OK\n'"
   ```

6. SSH 验收后再让 Hub 重附着原 terminal/session，并只读核对原 tmux pane 和进程身份。不要重发业务任务，不要自动 resume。

默认恢复/启动等待预算为 45 秒，可用 `--wait-ms` 设置 1–60000 毫秒的有界等待。超时不意味着工具会杀后台：返回 not_ready 后可再查 status。30 秒 warm 总预算、CLI 子进程取消、失效路由 hint 驱逐属于后台恢复机制；它们不能修复已经永久失联的 VS Code 中继连接，也不能绕过本人需要处理的 trust/login/OTP。

## CLI 失败与显示连接保活

`CLI_FAILED` 不是“GitHub 授权过期”的同义词。Windows 的安全诊断日志默认位于 `%USERPROFILE%\.tunnelterm\services\worker-diagnostics.log`：`CLI_CHECK_*` 表示官方 `devtunnel user show` 检查失败，`CLI_METADATA_*` 表示官方 tunnel 元数据查询失败。日志只保留固定错误分类、退出码及 `cli_hints` 类别，不记录原始输出、账户凭据或私有 endpoint。先核对当前进程的 `parent_pid`，不要把之前运行的错误当作当前故障。

新版 `service status` 的 `last_failure` 也会提供这些经过白名单过滤的阶段与原因，不必先翻日志。默认只读账户预检遇到合格的暂态错误可在原期限内重试一次；明确的登录拒绝、程序/权限/配置错误、取消不会因此重复尝试，元数据查询、SSH 输入和项目任务都不会被重发。

已有路由曾因健康检查失败进入 recovering 时，恢复器会重新检查该路由的真实 SSH banner，而不是只等待新建 CLI worker。辅助路由状态读取失败也不会把已经通过验证的 SSH 路由误判为不可用。这些机制不能把真正断掉的 SSH 字节流接续起来；显示已断时仍要核对并接回原 tmux。

若服务显示 `unreachable`，保存的运行记录可能还在，但控制端点不能验证。`recover` / `restart` 会拒绝替换无法验证的 owner；先核对准确 profile 的进程、端口和维护状态。确认旧 owner 已退出后，可以明确执行 `service start --profile my-server` 重新取得 profile 的独占控制端点。不要盲删 runtime/route、猜 PID 或强杀进程。

已建立的 SSH 显示连接每 15 秒发送 WebSocket ping 控制帧，保持传输层活动。它不是终端按键，不进入 SSH 业务字节，不触发 Codex，也不重放会话。客户端不会因为缺少一次 pong 就关闭背压中的连接；真正的网络断开仍需恢复路由并重连原终端。诊断的 `end_reason` / `ws_close_code` 用于区分本地关闭与 WebSocket 断开，不包含原始错误文本。

一次 banner 检查或 `SSH_OK` 只能证明那次连接成功。恢复验收还应包括原终端持续连接、并发查询，以及原 tmux/pane 身份核对；它们都通过后才算工作终端恢复。

已有 SSH 终端还能显示画面，不代表新的 SSH 查询也能建立。Hub 的完整会话读取需要独立连接，因此可能出现“终端已连接，但真实会话读取失败”。对于仍新鲜、明确受信任的同一工作区/同一桥接代次，SSH 可以在文件系统探测超时或提供者暂不可用时尝试本代已认证的私有路由；每条新流仍经过 broker 认证及真实 SSH 检查。冷启动、过期、撤销信任、权限错误、代次变化或端点拒绝不会借缓存绕过。普通 MCP 命令和文件访问仍要求 `active/ready`，不要把 SSH 恢复解读为所有远端通道已恢复。

## 本机窗口活着，不等于远端在线

桥接状态现在分层报告：`bridge_alive` 仅表示本机扩展仍运行；`remote_ready` / `ready` 要求当前选定的远端工作区通过只读文件系统探测。`provider_state`、`health_code` 和 `next_action` 是固定诊断值，不包含原始错误或凭据。远端不可用但本机仍活着的窗口仍可出现在 MCP 连接清单中，`active=false` 的对象不能用于执行远端命令。对这种对象查询 `connection_status` 只返回缓存健康信息。

`PROVIDER_UNAVAILABLE`（例如 `ENOPRO`）说明远端文件系统通道不可用，不说明 SSH Stream 扩展未安装。只有确认 endpoint 命令不存在时才提示检查 companion。探测有界且单飞；原生请求一直不返回时，不会每个心跳再堆积一个请求，也不会把迟到结果假报为已经恢复。

若远端的原生 VS Code Tunnel 主机端没有连到中继，仅在本机重复 recover 或 Reload 不能修好。Linux 的 `code-tunnel.service`（若以此名称安装）即便显示 `active (running)`，也只证明进程仍在。先在远端做只读检查，服务名需与自己的安装一致：

```bash
systemctl --user status code-tunnel.service --no-pager
```

重启前确认该服务的 `KillMode` 和当前工作状态。`KillMode=control-group` 会结束整个服务进程组，包括由它启动的 VS Code 终端、Codex 后台或编译任务。**只有用户明确允许这些进程结束时**，才能在远端执行：

```bash
systemctl --user restart code-tunnel.service
```

远端主机重新连到中继后，再重载本机专用空缓存窗口，核验远端工作区、SSH 和原终端。不新建替代工作、不重发任务；原 tmux 或模型已经结束时，明确报告并由用户选择后续恢复。上述远端命令不是本机 `tunnelterm service restart`，也不是重启整台机器。
