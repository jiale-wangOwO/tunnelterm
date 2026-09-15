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

## 中文快速开始

### 前置条件

- 本机：VS Code Desktop、Remote - Tunnels 扩展、Node.js 20+
- 远端：Linux/macOS 等 POSIX 环境，并可执行 `python3`
- 已通过 VS Code 登录并能正常打开目标 Tunnel

### 从源码安装

```powershell
git clone https://github.com/jiale-wangOwO/tunnelterm.git
cd tunnelterm
npm install
npm link
npm run package:vsix
code --install-extension .\tunnelterm-vscode-0.1.0.vsix
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

```text
tunnelterm list
tunnelterm status [-t TARGET]
tunnelterm shell [TARGET] [--cwd REMOTE_PATH] [--shell SHELL]
tunnelterm exec [-t TARGET] [--cwd REMOTE_PATH] [--timeout SECONDS] [--] COMMAND
tunnelterm get  [-t TARGET] REMOTE_PATH LOCAL_PATH
tunnelterm put  [-t TARGET] LOCAL_PATH REMOTE_PATH
tunnelterm open TUNNEL REMOTE_PATH [--code PATH] [--dev]
tunnelterm doctor
```

Examples:

```powershell
tunnelterm exec -- nvidia-smi
tunnelterm exec --timeout 600 -- python3 benchmark.py
tunnelterm get /home/user/project/results.json .\results.json
tunnelterm put .\benchmark.py /home/user/project/benchmark.py
tunnelterm doctor
```

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
npm install
npm run check
npm test
npm run package:vsix
```

The project has no runtime npm dependencies. Before publishing, confirm the
final repository, publisher/package name and homepage, add project artwork,
and exercise the manual end-to-end checks in `CONTRIBUTING.md` on at least bash
and zsh.

## Security

Read `SECURITY.md`. TunnelTerm is a remote command execution tool;
install it only from sources you trust and use it only against systems you are
authorized to access.

## License

MIT; see `LICENSE`.
