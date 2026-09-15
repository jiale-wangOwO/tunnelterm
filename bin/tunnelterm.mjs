#!/usr/bin/env node

import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {
  atomicWrite,
  encodeRemoteUri,
  listInstances,
  selectInstance,
  sendRequest,
  stateRoot,
  takeFlag,
  takeOption,
} from '../src/client-core.mjs';

const VERSION = '0.1.1';
const HELP = `TunnelTerm ${VERSION}

Use an authenticated VS Code Remote Tunnel like a local terminal.

Usage:
  tunnelterm list [--all]
  tunnelterm status [-t TARGET]
  tunnelterm shell [TARGET] [--cwd REMOTE_PATH] [--shell SHELL]
  tunnelterm exec [-t TARGET] [--cwd REMOTE_PATH] [--timeout SECONDS] [--] COMMAND
  tunnelterm get  [-t TARGET] REMOTE_PATH LOCAL_PATH
  tunnelterm put  [-t TARGET] LOCAL_PATH REMOTE_PATH
  tunnelterm open TUNNEL REMOTE_PATH [--code PATH] [--dev]
  tunnelterm doctor [--code PATH]

TARGET is a tunnel name, an instance id, or a unique workspace-path substring
from 'tunnelterm list'. If exactly one bridge is active, -t is optional. In an
interactive shell, press Ctrl+] to disconnect locally; Ctrl+C is sent to the
remote PTY.
`;

function formatAge(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '?';
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

async function instancesAndTarget(args, positionalTarget = false) {
  let target = takeOption(args, '--target', '-t');
  if (!target && positionalTarget && args.length && !args[0].startsWith('-')) target = args.shift();
  return selectInstance(await listInstances(), target);
}

async function listCommand(args) {
  const includeStale = takeFlag(args, '--all', '-a');
  if (args.length) throw new Error(`Unexpected list arguments: ${args.join(' ')}`);
  const discovered = await listInstances();
  const instances = includeStale ? discovered : discovered.filter(item => item.active);
  if (!instances.length) {
    console.log(discovered.length
      ? "No active TunnelTerm bridges. Run 'tunnelterm list --all' to see stale entries."
      : 'No TunnelTerm bridge instances have been registered.');
    return;
  }
  const rows = instances.map(item => ({
    STATE: item.active ? 'ready' : 'stale',
    INSTANCE: item.instance,
    TUNNEL: item.tunnel || '-',
    CWD: item.defaultCwd || '-',
    AGE: formatAge(item.ageMilliseconds),
  }));
  console.table(rows);
}

async function statusCommand(args) {
  const instance = await instancesAndTarget(args);
  const status = await sendRequest(instance, {op: 'status'});
  delete status.ok;
  console.log(JSON.stringify(status, null, 2));
}

async function shellCommand(args) {
  const cwd = takeOption(args, '--cwd', '-C');
  const shell = takeOption(args, '--shell', '-s');
  const instance = await instancesAndTarget(args, true);
  if (args.length) throw new Error(`Unexpected shell arguments: ${args.join(' ')}`);

  const dimensions = () => ({
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  });
  const started = await sendRequest(instance, {op: 'session.start', cwd, shell, ...dimensions()}, 20_000);
  const sessionId = started.session_id;
  let disconnected = false;
  let remoteDone = false;
  let inputChain = Promise.resolve();
  const wasRaw = Boolean(process.stdin.isRaw);

  const restore = () => {
    process.stdout.off('resize', resizeHandler);
    process.stdin.off('data', inputHandler);
    if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
    process.stdin.pause();
  };

  const close = async () => {
    if (disconnected) return;
    disconnected = true;
    restore();
    if (!remoteDone) {
      await sendRequest(instance, {op: 'session.close', session_id: sessionId}, 5000).catch(() => {});
    }
  };

  const inputHandler = data => {
    const escapeIndex = data.indexOf(0x1d); // Ctrl+]
    const forwarded = escapeIndex >= 0 ? data.subarray(0, escapeIndex) : data;
    if (forwarded.length) {
      inputChain = inputChain
        .then(() => sendRequest(instance, {
          op: 'session.input',
          session_id: sessionId,
          data_base64: forwarded.toString('base64'),
        }, 10_000))
        .catch(error => {
          process.stderr.write(`\r\nTunnelTerm input error: ${error.message}\r\n`);
          void close();
        });
    }
    if (escapeIndex >= 0) void close();
  };

  const resizeHandler = () => {
    void sendRequest(instance, {op: 'session.resize', session_id: sessionId, ...dimensions()}, 5000).catch(() => {});
  };

  process.stderr.write(`Connected to ${instance.tunnel} (${instance.instance}). Escape character is '^]'.\r\n`);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', inputHandler);
  process.stdout.on('resize', resizeHandler);

  const signalHandler = () => void close();
  process.once('SIGHUP', signalHandler);
  process.once('SIGTERM', signalHandler);

  let exitCode = 0;
  try {
    while (!disconnected) {
      const result = await sendRequest(instance, {op: 'session.poll', session_id: sessionId}, 10_000);
      if (result.data_base64) process.stdout.write(Buffer.from(result.data_base64, 'base64'));
      if (result.done) {
        remoteDone = true;
        exitCode = Number(result.state?.exit_code) || 0;
        break;
      }
      if (!result.bytes) await new Promise(resolve => setTimeout(resolve, 25));
    }
  } finally {
    restore();
    process.off('SIGHUP', signalHandler);
    process.off('SIGTERM', signalHandler);
    if (!remoteDone && !disconnected) await close();
    if (disconnected) process.stderr.write('\r\nDisconnected.\r\n');
  }
  process.exitCode = exitCode;
}

async function execCommand(args) {
  const separator = args.indexOf('--');
  let options;
  let commandArguments;
  if (separator >= 0) {
    options = args.slice(0, separator);
    commandArguments = args.slice(separator + 1);
  } else {
    // PowerShell may consume a bare -- when it invokes npm's generated .ps1
    // shim. Parse known leading options, then treat the rest as the command.
    let index = 0;
    while (index < args.length && ['--target', '-t', '--cwd', '-C', '--timeout', '-T'].includes(args[index])) {
      if (index + 1 >= args.length) throw new Error(`${args[index]} requires a value`);
      index += 2;
    }
    options = args.slice(0, index);
    commandArguments = args.slice(index);
  }
  const cwd = takeOption(options, '--cwd', '-C');
  const timeoutValue = takeOption(options, '--timeout', '-T');
  const target = takeOption(options, '--target', '-t');
  if (options.length) throw new Error(`Unexpected exec options: ${options.join(' ')}`);
  if (!commandArguments.length) throw new Error('exec requires a remote command');
  const instance = selectInstance(await listInstances(), target);
  const timeoutSeconds = Math.max(1, Math.min(86400, Number(timeoutValue) || 120));
  const result = await sendRequest(instance, {
    op: 'exec',
    command: commandArguments.join(' '),
    cwd,
    timeout_seconds: timeoutSeconds,
  }, (timeoutSeconds + 20) * 1000);
  if (result.stdout_base64) process.stdout.write(Buffer.from(result.stdout_base64, 'base64'));
  if (result.stderr_base64) process.stderr.write(Buffer.from(result.stderr_base64, 'base64'));
  if (result.stdout_truncated) process.stderr.write(`TunnelTerm: stdout exceeded the capture limit; remote job: ${result.remote_job}\n`);
  if (result.stderr_truncated) process.stderr.write(`TunnelTerm: stderr exceeded the capture limit; remote job: ${result.remote_job}\n`);
  const remoteExitCode = Number(result.exit_code) || 0;
  process.exitCode = remoteExitCode < 0 ? 128 + Math.abs(remoteExitCode) : remoteExitCode;
}

async function getCommand(args) {
  const instance = await instancesAndTarget(args);
  if (args.length !== 2) throw new Error('get requires REMOTE_PATH and LOCAL_PATH');
  const [remotePath, localPath] = args;
  const result = await sendRequest(instance, {op: 'read', path: remotePath}, 120_000);
  const data = Buffer.from(result.data_base64, 'base64');
  await fs.mkdir(path.dirname(path.resolve(localPath)), {recursive: true});
  await fs.writeFile(localPath, data);
  console.error(`Downloaded ${data.length} bytes to ${path.resolve(localPath)}`);
}

async function putCommand(args) {
  const instance = await instancesAndTarget(args);
  if (args.length !== 2) throw new Error('put requires LOCAL_PATH and REMOTE_PATH');
  const [localPath, remotePath] = args;
  const data = await fs.readFile(localPath);
  const result = await sendRequest(instance, {op: 'write', path: remotePath, data_base64: data.toString('base64')}, 120_000);
  console.error(`Uploaded ${result.bytes} bytes to ${remotePath}`);
}

function resolveCodeExecutable(requested) {
  if (process.platform !== 'win32') return requested;
  const candidates = [];
  if (/\.cmd$/i.test(requested)) candidates.push(requested);
  if (requested === 'code') {
    const located = spawnSync('where.exe', ['code.cmd'], {encoding: 'utf8'});
    if (located.status === 0) candidates.push(...located.stdout.split(/\r?\n/).filter(Boolean));
  }
  const preferred = [
    ...candidates.filter(value => /microsoft vs code/i.test(value)),
    ...candidates.filter(value => !/microsoft vs code/i.test(value)),
  ];
  for (const commandFile of preferred) {
    const executable = path.resolve(path.dirname(commandFile), '..', 'Code.exe');
    if (existsSync(executable)) return executable;
  }
  return requested;
}

async function removeExpiredOpenRequests(directory) {
  let names;
  try {
    names = await fs.readdir(directory);
  } catch {
    return;
  }
  const cutoff = Date.now() - 120_000;
  for (const name of names.filter(value => value.endsWith('.json'))) {
    const file = path.join(directory, name);
    try {
      if ((await fs.stat(file)).mtimeMs < cutoff) await fs.unlink(file);
    } catch {}
  }
}

async function openCommand(args) {
  const requestedCodePath = takeOption(args, '--code', '-c') || 'code';
  const codePath = resolveCodeExecutable(requestedCodePath);
  const development = takeFlag(args, '--dev');
  if (args.length !== 2) throw new Error('open requires TUNNEL and REMOTE_PATH');
  const [tunnel, remotePath] = args;
  const uri = encodeRemoteUri(tunnel, remotePath);
  const openRequests = path.join(stateRoot(), 'open-requests');
  await removeExpiredOpenRequests(openRequests);
  const openRequest = path.join(openRequests, `${randomUUID()}.json`);
  await atomicWrite(openRequest, {uri, created: new Date().toISOString()});
  const commandArgs = ['--new-window'];
  if (development) {
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    commandArgs.push('--extensionDevelopmentPath', projectRoot);
  }
  commandArgs.push('--folder-uri', uri);
  // Windows can execute Code.exe directly (including paths with spaces). The
  // bare `code` command commonly resolves to code.cmd and therefore needs the
  // command processor.
  const needsWindowsShell = process.platform === 'win32' && !/\.exe$/i.test(codePath);
  // Code.exe may become the long-lived GUI process when no instance is running.
  // Wait for bridge readiness below, not for that GUI process to exit.
  const launchState = {failure: undefined};
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(codePath, commandArgs, {
        stdio: 'ignore', shell: needsWindowsShell, detached: true, windowsHide: true,
      });
      let started = false;
      child.once('error', error => {
        launchState.failure = error;
        if (!started) reject(error);
      });
      child.once('exit', (code, signal) => {
        if (code !== 0) {
          launchState.failure = new Error(signal
            ? `VS Code terminated by signal ${signal}`
            : `VS Code exited with status ${code}`);
        }
      });
      child.once('spawn', () => {
        started = true;
        child.unref();
        resolve();
      });
    });
  } catch (error) {
    await fs.unlink(openRequest).catch(() => {});
    throw error;
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (launchState.failure) {
      await fs.unlink(openRequest).catch(() => {});
      throw launchState.failure;
    }
    const matching = (await listInstances()).some(instance =>
      instance.active && instance.tunnel === tunnel && instance.defaultCwd === remotePath);
    if (matching) {
      await fs.unlink(openRequest).catch(() => {});
      console.error(`TunnelTerm bridge is ready for ${tunnel}.`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  console.error('VS Code opened. Complete any sign-in or Workspace Trust prompt, then run tunnelterm list.');
}

async function doctorCommand(args) {
  const requestedCodePath = takeOption(args, '--code', '-c') || 'code';
  if (args.length) throw new Error(`Unexpected doctor arguments: ${args.join(' ')}`);
  console.log(`TunnelTerm ${VERSION}`);
  console.log(`Node ${process.version} (${process.platform} ${process.arch})`);
  const codeExecutable = resolveCodeExecutable(requestedCodePath);
  const codeCmd = path.join(path.dirname(codeExecutable), 'bin', 'code.cmd');
  // The Windows GUI executable does not implement the CLI --version route.
  // Its bundled code.cmd sets ELECTRON_RUN_AS_NODE and invokes the CLI entry.
  const code = process.platform === 'win32' && /\.exe$/i.test(codeExecutable) && existsSync(codeCmd)
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${codeCmd}" --version"`], {
      encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true, timeout: 10_000,
    })
    : spawnSync(codeExecutable, ['--version'], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
      shell: process.platform === 'win32' && !/\.exe$/i.test(codeExecutable),
    });
  if (code.status === 0) {
    const reportedVersion = code.stdout.trim().split(/\r?\n/)[0];
    console.log(reportedVersion
      ? `VS Code CLI ${reportedVersion} (${codeExecutable})`
      : `VS Code executable found (${codeExecutable})`);
  }
  else if (code.error?.code === 'ETIMEDOUT') {
    console.log(`VS Code CLI: version probe timed out after 10 seconds (${codeExecutable})`);
  }
  else console.log('VS Code CLI: not found (use tunnelterm doctor --code PATH)');
  const instances = await listInstances();
  console.log(`Bridge instances: ${instances.length}, active: ${instances.filter(item => item.active).length}`);
  for (const item of instances.filter(value => value.active)) {
    console.log(`  ${item.instance}  ${item.tunnel}  ${item.defaultCwd}`);
  }
  if (!instances.some(item => item.active)) {
    console.log('Next: open a trusted Remote Tunnel workspace with the TunnelTerm extension enabled.');
    process.exitCode = 1;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }
  if (command === '--version' || command === '-v') {
    console.log(VERSION);
    return;
  }
  switch (command) {
    case 'list': await listCommand(args); break;
    case 'status': await statusCommand(args); break;
    case 'shell': await shellCommand(args); break;
    case 'exec': await execCommand(args); break;
    case 'get': await getCommand(args); break;
    case 'put': await putCommand(args); break;
    case 'open': await openCommand(args); break;
    case 'doctor': await doctorCommand(args); break;
    default: throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  }
}

main().catch(error => {
  console.error(`TunnelTerm: ${error.message}`);
  process.exitCode = 1;
});
