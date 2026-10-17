#!/usr/bin/env python3
"""Remote POSIX helper for TunnelTerm.

The VS Code extension deploys this file through vscode.workspace.fs and starts
it through a VS Code task. It never listens on a network socket. Interactive
I/O is exchanged as small, atomically renamed files so the local UI extension
can relay it through the authenticated VS Code remote file-system provider.
"""

from __future__ import annotations

import argparse
import errno
import fcntl
import json
import os
import pty
import select
import shlex
import signal
import socket
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path


CHUNK_BYTES = 64 * 1024
MAX_UNACKED_CHUNKS = 1024


def atomic_bytes(path: Path, data: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("wb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)


def atomic_json(path: Path, value: object) -> None:
    atomic_bytes(path, (json.dumps(value, ensure_ascii=False) + "\n").encode())


def read_json(path: Path, default: object = None) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


def shell_argv(configured: str, login: bool) -> list[str]:
    configured = configured.strip()
    argv = shlex.split(configured) if configured else [os.environ.get("SHELL") or "/bin/sh"]
    if login and len(argv) == 1:
        argv.append("-l")
    return argv


def set_window_size(fd: int, cols: int, rows: int) -> None:
    cols = max(1, min(1000, int(cols)))
    rows = max(1, min(1000, int(rows)))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def kill_process_group(process: subprocess.Popen[bytes], sig: int) -> None:
    try:
        os.killpg(process.pid, sig)
    except ProcessLookupError:
        pass


def run_exec(job: Path) -> int:
    request = read_json(job / "request.json")
    if not isinstance(request, dict):
        raise RuntimeError("Missing or invalid request.json")

    command = request.get("command")
    cwd = request.get("cwd")
    timeout = max(1, min(86400, int(request.get("timeout_seconds", 120))))
    if not isinstance(command, str) or not isinstance(cwd, str):
        raise RuntimeError("Invalid exec request")

    job.mkdir(parents=True, exist_ok=True, mode=0o700)
    started = time.time()
    timed_out = False
    argv = shell_argv(str(request.get("shell", "")), login=False) + ["-lc", command]

    with (job / "stdout.bin").open("wb") as stdout, (job / "stderr.bin").open("wb") as stderr:
        process = subprocess.Popen(
            argv,
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            stdout=stdout,
            stderr=stderr,
            start_new_session=True,
        )
        try:
            return_code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            kill_process_group(process, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                kill_process_group(process, signal.SIGKILL)
                process.wait()
            return_code = 124

    atomic_json(
        job / "result.json",
        {
            "exit_code": int(return_code),
            "timed_out": timed_out,
            "duration_ms": round((time.time() - started) * 1000),
        },
    )
    return int(return_code)


def run_session(session: Path, cwd: str, configured_shell: str, cols: int, rows: int) -> int:
    inbox = session / "in"
    outbox = session / "out"
    inbox.mkdir(parents=True, exist_ok=True, mode=0o700)
    outbox.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        session.chmod(0o700)
        inbox.chmod(0o700)
        outbox.chmod(0o700)
    except OSError:
        pass

    master, slave = pty.openpty()
    set_window_size(slave, cols, rows)
    environment = os.environ.copy()
    environment.setdefault("TERM", "xterm-256color")
    environment.setdefault("COLORTERM", "truecolor")
    environment["TUNNELTERM"] = "1"
    process = subprocess.Popen(
        shell_argv(configured_shell, login=True),
        cwd=cwd,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=environment,
        start_new_session=True,
        close_fds=True,
    )
    os.close(slave)
    flags = fcntl.fcntl(master, fcntl.F_GETFL)
    fcntl.fcntl(master, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    started = time.time()
    output_sequence = 0
    last_ack = -1
    last_input_sequence = -1
    resize_stamp = 0
    closing = False
    atomic_json(
        session / "state.json",
        {
            "state": "running",
            "pid": process.pid,
            "cwd": cwd,
            "started": started,
        },
    )

    def request_close(_signum: int | None = None, _frame: object = None) -> None:
        nonlocal closing
        if not closing:
            closing = True
            kill_process_group(process, signal.SIGHUP)

    signal.signal(signal.SIGTERM, request_close)
    signal.signal(signal.SIGINT, request_close)

    try:
        while True:
            if (session / "close").exists():
                request_close()

            resize = session / "resize.json"
            try:
                stamp = resize.stat().st_mtime_ns
                if stamp != resize_stamp:
                    value = read_json(resize, {})
                    if isinstance(value, dict):
                        set_window_size(master, int(value.get("cols", 80)), int(value.get("rows", 24)))
                        os.killpg(process.pid, signal.SIGWINCH)
                    resize_stamp = stamp
            except FileNotFoundError:
                pass

            for item in sorted(inbox.glob("*.bin")):
                try:
                    sequence = int(item.stem)
                    if sequence <= last_input_sequence:
                        continue
                    data = item.read_bytes()
                    view = memoryview(data)
                    while view and process.poll() is None:
                        try:
                            written = os.write(master, view)
                            view = view[written:]
                        except BlockingIOError:
                            select.select([], [master], [], 0.05)
                    last_input_sequence = sequence
                    atomic_json(session / "input_ack.json", {"sequence": sequence})
                except FileNotFoundError:
                    continue

            ack_value = read_json(session / "ack.json", {})
            if isinstance(ack_value, dict):
                try:
                    last_ack = max(last_ack, int(ack_value.get("sequence", -1)))
                except (TypeError, ValueError):
                    pass

            can_read = output_sequence - last_ack <= MAX_UNACKED_CHUNKS
            ready, _, _ = select.select([master] if can_read else [], [], [], 0.02)
            if ready:
                try:
                    data = os.read(master, CHUNK_BYTES)
                    if data:
                        atomic_bytes(outbox / f"{output_sequence:016d}.bin", data)
                        output_sequence += 1
                except OSError as exc:
                    if exc.errno not in (errno.EIO, errno.EBADF):
                        raise

            return_code = process.poll()
            if return_code is not None:
                # A PTY can still contain a final prompt/error after the child exits.
                while True:
                    try:
                        data = os.read(master, CHUNK_BYTES)
                    except (BlockingIOError, OSError):
                        break
                    if not data:
                        break
                    atomic_bytes(outbox / f"{output_sequence:016d}.bin", data)
                    output_sequence += 1
                atomic_json(
                    session / "state.json",
                    {
                        "state": "exited",
                        "pid": process.pid,
                        "cwd": cwd,
                        "started": started,
                        "ended": time.time(),
                        "exit_code": int(return_code),
                        "last_output_sequence": output_sequence - 1,
                    },
                )
                return int(return_code)
    finally:
        try:
            os.close(master)
        except OSError:
            pass
        if process.poll() is None:
            kill_process_group(process, signal.SIGTERM)
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                kill_process_group(process, signal.SIGKILL)


def run_tcp(session: Path, host: str, port: int) -> int:
    """Relay a single, loopback-only TCP connection through file packets."""
    if host not in {"127.0.0.1", "::1"} or port != 22:
        raise RuntimeError("TunnelTerm TCP relay only permits loopback SSH on port 22")

    inbox = session / "in"
    outbox = session / "out"
    inbox.mkdir(parents=True, exist_ok=True, mode=0o700)
    outbox.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        session.chmod(0o700)
        inbox.chmod(0o700)
        outbox.chmod(0o700)
    except OSError:
        pass

    connection = socket.create_connection((host, port), timeout=10)
    connection.setblocking(False)
    output_sequence = 0
    last_ack = -1
    last_input_sequence = -1
    pending_sequence: int | None = None
    pending = memoryview(b"")
    closing = False
    atomic_json(session / "state.json", {"state": "running", "host": host, "port": port, "started": time.time()})

    def close_connection(_signum: int | None = None, _frame: object = None) -> None:
        nonlocal closing
        if not closing:
            closing = True
            try:
                connection.shutdown(socket.SHUT_WR)
            except OSError:
                pass

    signal.signal(signal.SIGTERM, close_connection)
    signal.signal(signal.SIGINT, close_connection)
    try:
        while True:
            if (session / "close").exists():
                close_connection()

            if pending_sequence is None:
                for item in sorted(inbox.glob("*.bin")):
                    try:
                        sequence = int(item.stem)
                        if sequence > last_input_sequence:
                            pending_sequence = sequence
                            pending = memoryview(item.read_bytes())
                            break
                    except (FileNotFoundError, ValueError):
                        continue

            ack_value = read_json(session / "ack.json", {})
            if isinstance(ack_value, dict):
                try:
                    last_ack = max(last_ack, int(ack_value.get("sequence", -1)))
                except (TypeError, ValueError):
                    pass

            readable = output_sequence - last_ack <= MAX_UNACKED_CHUNKS
            read_ready, write_ready, _ = select.select(
                [connection] if readable else [],
                [connection] if pending else [],
                [],
                0.02,
            )
            if write_ready:
                try:
                    sent = connection.send(pending)
                    pending = pending[sent:]
                    if not pending:
                        last_input_sequence = pending_sequence if pending_sequence is not None else last_input_sequence
                        atomic_json(session / "input_ack.json", {"sequence": last_input_sequence})
                        pending_sequence = None
                except BlockingIOError:
                    pass

            if read_ready:
                data = connection.recv(CHUNK_BYTES)
                if data:
                    atomic_bytes(outbox / f"{output_sequence:016d}.bin", data)
                    output_sequence += 1
                else:
                    atomic_json(session / "state.json", {"state": "exited", "ended": time.time(), "last_output_sequence": output_sequence - 1})
                    return 0
    except OSError as exc:
        atomic_json(session / "state.json", {"state": "exited", "ended": time.time(), "error": str(exc), "last_output_sequence": output_sequence - 1})
        return 1
    finally:
        connection.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="TunnelTerm remote helper")
    subparsers = parser.add_subparsers(dest="mode", required=True)
    exec_parser = subparsers.add_parser("exec")
    exec_parser.add_argument("job", type=Path)
    session_parser = subparsers.add_parser("session")
    session_parser.add_argument("session", type=Path)
    session_parser.add_argument("--cwd", required=True)
    session_parser.add_argument("--shell", default="")
    session_parser.add_argument("--cols", type=int, default=80)
    session_parser.add_argument("--rows", type=int, default=24)
    tcp_parser = subparsers.add_parser("tcp")
    tcp_parser.add_argument("session", type=Path)
    tcp_parser.add_argument("--host", required=True)
    tcp_parser.add_argument("--port", type=int, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.mode == "exec":
        return run_exec(args.job)
    if args.mode == "session":
        return run_session(args.session, args.cwd, args.shell, args.cols, args.rows)
    return run_tcp(args.session, args.host, args.port)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # The task log is the last-resort diagnostic channel.
        print(f"tunnelterm-agent: {exc}", file=sys.stderr)
        raise
