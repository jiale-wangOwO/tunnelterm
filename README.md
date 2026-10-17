# TunnelTerm

[![CI](https://github.com/jiale-wangOwO/tunnelterm/actions/workflows/ci.yml/badge.svg)](https://github.com/jiale-wangOwO/tunnelterm/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

TunnelTerm turns an authenticated **VS Code Remote Tunnel** connection into an
interactive shell in your existing PowerShell, Windows Terminal, macOS
Terminal, or Linux terminal.

```text
PowerShell / terminal
       │ local file queue (authenticated, no listening port)
       ▼
TunnelTerm VS Code UI extension
       │ VS Code Remote Tunnel APIs
       ▼
remote Python helper ── real POSIX PTY ── bash/zsh/sh
```

It feels similar to SSH for day-to-day shell work: the remote shell is
persistent, `cd` and exported variables survive between commands, ANSI colors
work, Ctrl+C reaches the remote process, and terminal resize events are
forwarded. It also has non-interactive command and file-copy commands.

TunnelTerm is an adapter around VS Code, not an independent implementation of
Microsoft's tunnel protocol. A VS Code Desktop window must remain connected to
the tunnel (it may be minimized). VS Code owns authentication; TunnelTerm does
not read or copy account credentials.

The `main` branch includes unreleased managed SSH and MCP functionality. GitHub
Release tags may lag behind this development snapshot; building from source or
downloading the two VSIX artifacts from a successful [CI run](https://github.com/jiale-wangOwO/tunnelterm/actions/workflows/ci.yml)
does not install them or publish a new Release.

## 中文快速开始

### 前置条件

- 本机：VS Code Desktop、Remote - Tunnels 扩展、Node.js 20+
- 远端：Linux/macOS 等 POSIX 环境，并可执行 `python3`
- 已通过 VS Code 登录并能正常打开目标 Tunnel

### 从源码安装

```powershell
git clone https://github.com/jiale-wangOwO/tunnelterm.git
cd tunnelterm
npm ci
npm link
npm run package:vsix
code --install-extension .\tunnelterm-vscode-0.1.3.vsix
```

连接一个 Tunnel 工作区（下面的名称和路径替换成你自己的）：

```powershell
tunnelterm open my-server /home/user/project
```

等待远程窗口连接完成并确认 Workspace Trust，然后回到 PowerShell：

```powershell
tunnelterm list [--all]
tunnelterm shell
```

如果同时开了多个 Tunnel 窗口，用 `-t` 选择：

```powershell
tunnelterm shell -t my-server
tunnelterm shell -t 6a42c4f30bf9d278
tunnelterm shell -t /home/user/project
```

`TARGET` 可以是 Tunnel 名、实例 ID，或能唯一匹配的远端工作区路径片段；路径
匹配在 VS Code 重启、实例 ID 变化后仍然有效。

交互中 `Ctrl+C` 会发给远端程序；`Ctrl+]` 只断开本地 TunnelTerm 会话。

开发时可以不安装 VSIX，直接启动 Extension Development Host：

```powershell
tunnelterm open my-server /home/user/project --dev
```

## Commands

### 长期运行：固定入口的 SSH 服务

当前开发版提供管理服务，不需要 Hub/Codex 适配 Tunnel 私有协议：客户端始终使用
普通 SSH。首次配置一个专用的、可信任的空缓存工作区，保持该服务窗口连接，然后：

```powershell
tunnelterm service start --profile my-server -t /home/user/.cache/tunnelterm/ssh-service --port 22222
tunnelterm service status --profile my-server
```

服务保存配置并后台运行；固定监听端口与后端路线分离。健康检查实际建立新连接
并读取 SSH banner，不以“进程还在”判定可用。路线失败会退避重试；恢复或主动刷新
为新连接准备新后端，已有连接继续使用旧后端，最后一个连接结束后才清理。

```powershell
tunnelterm service check --profile my-server
tunnelterm service recover --profile my-server
tunnelterm service restart --profile my-server
tunnelterm service refresh --profile my-server
tunnelterm service drain --profile my-server
tunnelterm service stop --profile my-server
```

`stop` 拒绝关闭仍有活跃 SSH 连接的服务；`drain` 停止接收新连接并等待已有连接结束。
账户登录失效、VS Code 服务窗口关闭、远端 sshd 不可用仍会明确显示不可用；工具
不会读取账户凭据、自动确认信任、重载工作窗口，或重放已发送的 SSH 数据。
完整生命周期、安全边界与验证方式见 [Managed SSH service](docs/managed-service.md)。

日常断网恢复优先使用 `tunnelterm service recover --profile my-server`。返回
`recovery_pending=true` 时先按 `next_action` 等待并查询 `service status`，不要循环重启。
新版会重新验证已经恢复的原路由，并区分 CLI 账户预检、元数据查询和 VS Code
provider/映射故障；详细步骤见[断网恢复指南](docs/recovery.zh-CN.md)。

### Codex / MCP

TunnelTerm 可直接作为本地 MCP 工具供 Codex 调用。先保持 VS Code Tunnel 窗口
连接并启用 TunnelTerm 扩展，再从本仓库目录注册：

```powershell
npm install
codex mcp add tunnelterm -- node "$((Resolve-Path .\bin\tunnelterm-mcp.mjs).Path)"
```

新开一个 Codex 会话，然后说：“用 TunnelTerm 列出远程连接，在我指定的工作区
执行检查。”工具支持结构化命令结果、读写和传输文件、持久 PTY 会话。
详细配置、工具列表和示例见 [Codex integration](docs/codex.md)。

```text
tunnelterm list
tunnelterm status [-t TARGET]
tunnelterm shell [TARGET] [--cwd REMOTE_PATH] [--shell SHELL]
tunnelterm exec [-t TARGET] [--cwd REMOTE_PATH] [--timeout SECONDS] [--] COMMAND
tunnelterm get  [-t TARGET] REMOTE_PATH LOCAL_PATH
tunnelterm put  [-t TARGET] LOCAL_PATH REMOTE_PATH
tunnelterm proxy [-t TARGET]
tunnelterm open TUNNEL REMOTE_PATH [--code PATH] [--dev]
tunnelterm doctor [--code PATH]
tunnelterm mcp
```

Examples:

```powershell
tunnelterm exec -- nvidia-smi
tunnelterm exec --timeout 600 -- python3 benchmark.py
tunnelterm get /home/user/project/results.json .\results.json
tunnelterm put .\benchmark.py /home/user/project/benchmark.py
tunnelterm doctor
```

### Ordinary SSH and terminal clients

The streaming SSH path now requires the remote **TunnelTerm SSH Stream**
companion. See [Streaming SSH setup](docs/ssh-stream.md) for both local VSIX
packages, workspace selection, the loopback launcher, and the multi-connection
OpenSSH regression. The earlier file relay remains an explicit experiment via
`proxy --legacy-files`.

After starting the managed service above, use an ordinary OpenSSH host entry.
The remote SSH account and host-key checks remain unchanged:

```sshconfig
Host my-server-via-tunnelterm
  HostName 127.0.0.1
  Port 22222
  User your-remote-user
  HostKeyAlias my-server-via-tunnelterm
  ControlMaster no
  ControlPersist no
```

Test with `ssh my-server-via-tunnelterm`, then give the same alias to an SSH
terminal client such as Herdr. Keep the existing `HostKeyAlias` when migrating
an established connection. Do not enable `ControlMaster`/`ControlPersist` for
this localhost relay.

`tunnelterm proxy` remains available as a `ProxyCommand` transport, and
`tunnelterm forward` is a foreground diagnostic listener. On Windows the
managed loopback entry avoids npm shim/path quoting problems. Both stream
paths use private port forwarding and reach only remote `127.0.0.1:22`;
neither publishes an anonymous SSH endpoint.

`exec` treats everything after its leading options as one remote shell command;
`--` is accepted but optional because PowerShell can consume it when invoking
an npm-generated `.ps1` shim. PowerShell performs its normal argument parsing
first, so quote shell operators or complex commands as needed.

## VS Code settings

Configure these settings in the connected Remote Tunnel window:

```json
{
  "tunnelterm.allowedRoots": [
    "/home/user/project",
    "/data/results"
  ],
  "tunnelterm.defaultCwd": "/home/user/project",
  "tunnelterm.shell": "/bin/bash",
  "tunnelterm.maxTransferBytes": 67108864
}
```

When `allowedRoots` is empty, TunnelTerm uses the currently opened remote
workspace folders. Working directories and the `get`/`put` file APIs must stay
inside these roots. Shell commands still run with the permissions of the remote
VS Code user and can intentionally access anything that user can access.

Set `TUNNELTERM_HOME` on the local machine to move TunnelTerm's local runtime
state. By default it uses `%LOCALAPPDATA%\TunnelTerm` on Windows and
`~/.local/state/tunnelterm` on POSIX systems.

## How it works

The extension is declared as a VS Code UI extension, so its Node process and
local queue stay on the client machine. It uses public `vscode.workspace.fs`
and `vscode.tasks.executeTask` APIs to deploy and run a small Python helper on
the connected remote. The helper allocates a real PTY and exchanges bounded
binary chunks through a token-scoped directory under `/tmp`.

There is no local or remote TCP listener. Each active VS Code window registers
an endpoint containing a random 256-bit token in the current user's local state
directory. Output backpressure stops PTY reads after 64 MiB of unacknowledged
chunks instead of allowing unbounded disk growth.

See `docs/architecture.md` for protocol and lifecycle details.

## Current scope and limitations

- The remote host must be POSIX and have Python 3. Windows remote hosts are not
  implemented yet.
- VS Code Desktop and its connected tunnel window must remain running. This is
  a deliberate consequence of using VS Code's authenticated public APIs.
- It is not a replacement for SSH port forwarding, agent forwarding, SFTP, or
  `ProxyJump`.
- `get`/`put` transfer one file in memory and default to a 64 MiB limit.
- VS Code tasks for TunnelTerm are hidden, but a failed helper's task log can be
  revealed from VS Code for diagnostics.
- The remote `/tmp/tunnelterm-*` runtime is not automatically removed after a
  hard client crash; it contains no VS Code credential and can be deleted when
  no session is active.

## Development

```powershell
npm ci
npm run check
npm test
npm run test:mcp
npm ci --prefix remote-stream
npm run package:vsix
npm run package:stream
```

The CLI's MCP/SSH modes use the dependencies declared in `package.json`; the
remote Python helper uses the standard library. The companion has its own
locked WebSocket dependency. CI runs local regressions on Windows/macOS/Linux
and builds both VSIX packages. Real tunnel/SSH acceptance checks are opt-in;
local tests and a successful build do not establish unattended uptime or every
remote host's performance. See `CONTRIBUTING.md` before publishing a Release.

## Security

Read `SECURITY.md`. TunnelTerm is a remote command execution tool;
install it only from sources you trust and use it only against systems you are
authorized to access.

## License

MIT; see `LICENSE`.
