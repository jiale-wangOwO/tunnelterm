'use strict';

// TunnelTerm's local UI extension. VS Code owns tunnel authentication and the
// remote file-system/task transport; this extension never reads auth tokens.
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {createRemoteHealthProbe, streamEndpointError, publicStreamEndpointFailure} = require('./bridge-health.cjs');
const BUILD_SHA256 = crypto.createHash('sha256').update(require('node:fs').readFileSync(__filename)).digest('hex');
const RUNTIME_GENERATION = crypto.randomUUID();

const PROTOCOL_VERSION = 1;
const SOURCE = 'TunnelTerm';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function localStateRoot() {
  if (process.env.TUNNELTERM_HOME) return path.resolve(process.env.TUNNELTERM_HOME);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'TunnelTerm');
  }
  return path.join(os.homedir(), '.local', 'state', 'tunnelterm');
}

async function atomicLocal(file, value, mode = 0o600, renameRetries = 0) {
  await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = `${file}.tmp-${crypto.randomUUID()}`;
  const data = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value, null, 2));
  await fs.writeFile(temporary, data, {mode});
  try {
    for (let attempt = 0; ; attempt++) {
      try {await fs.rename(temporary, file); break;}
      catch (error) {
        if (attempt >= renameRetries || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        await delay(50);
      }
    }
  } finally {
    // This extension created the unique temporary file; never remove the old
    // published status merely to work around a Windows reader's sharing lock.
    await fs.unlink(temporary).catch(() => {});
  }
}

function normalizeRemotePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    throw new Error(`Expected an absolute POSIX path, received: ${String(value)}`);
  }
  return path.posix.normalize(value);
}

function isInside(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function friendlyTunnelName(authority) {
  return decodeURIComponent(authority).replace(/^tunnel\+/, '');
}

function remoteUri(folder, remotePath) {
  return vscode.Uri.from({
    scheme: folder.uri.scheme,
    authority: folder.uri.authority,
    path: remotePath,
  });
}

async function remoteAtomic(folder, remotePath, data) {
  const temporary = `${remotePath}.tmp-${crypto.randomUUID()}`;
  await vscode.workspace.fs.writeFile(remoteUri(folder, temporary), data);
  await vscode.workspace.fs.rename(remoteUri(folder, temporary), remoteUri(folder, remotePath), {overwrite: true});
}

async function readRemoteJson(folder, remotePath, fallback = undefined) {
  try {
    const data = await vscode.workspace.fs.readFile(remoteUri(folder, remotePath));
    return JSON.parse(Buffer.from(data).toString('utf8'));
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw error;
  }
}

async function remoteExists(folder, remotePath) {
  try {
    await vscode.workspace.fs.stat(remoteUri(folder, remotePath));
    return true;
  } catch {
    return false;
  }
}

function taskFor(folder, id, label, executable, args, cwd) {
  const task = new vscode.Task(
    {type: 'tunnelterm', id},
    folder,
    label,
    SOURCE,
    new vscode.ProcessExecution(executable, args, {cwd}),
    [],
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Never,
    focus: false,
    echo: false,
    showReuseMessage: false,
    panel: vscode.TaskPanelKind.Dedicated,
    close: true,
  };
  return task;
}

function findTunnelFolder() {
  return vscode.workspace.workspaceFolders?.find(folder =>
    folder.uri.scheme === 'vscode-remote' && decodeURIComponent(folder.uri.authority).startsWith('tunnel+'));
}

async function claimPendingOpenRequest() {
  const directory = path.join(localStateRoot(), 'open-requests');
  let names;
  try {
    names = (await fs.readdir(directory)).filter(name => /^[0-9a-f-]+\.json$/.test(name));
  } catch {
    return null;
  }
  const candidates = [];
  for (const name of names) {
    const file = path.join(directory, name);
    try {
      candidates.push({file, modified: (await fs.stat(file)).mtimeMs});
    } catch {}
  }
  candidates.sort((left, right) => right.modified - left.modified);
  for (const candidate of candidates) {
    const claimed = `${candidate.file}.processing-${process.pid}`;
    try {
      await fs.rename(candidate.file, claimed);
      const request = JSON.parse(await fs.readFile(claimed, 'utf8'));
      await fs.unlink(claimed).catch(() => {});
      if (Date.now() - Date.parse(request.created) > 120_000) continue;
      if (typeof request.uri !== 'string' || !request.uri.startsWith('vscode-remote://tunnel+')) continue;
      return request;
    } catch {}
  }
  return null;
}

function configuredRoots(folder) {
  const configuration = vscode.workspace.getConfiguration('tunnelterm', folder.uri);
  const configured = configuration.get('allowedRoots', []);
  const raw = configured.length
    ? configured
    : vscode.workspace.workspaceFolders
        .filter(item => item.uri.scheme === folder.uri.scheme && item.uri.authority === folder.uri.authority)
        .map(item => item.uri.path);
  const roots = [...new Set(raw.map(normalizeRemotePath))];
  if (!roots.length) throw new Error('No allowed remote roots are available');
  return roots;
}

function safeRemotePath(value, roots) {
  const normalized = normalizeRemotePath(value);
  if (!roots.some(root => isInside(normalized, root))) {
    throw new Error(`Path is outside tunnelterm.allowedRoots: ${normalized}`);
  }
  return normalized;
}

async function activate(context) {
  const folder = findTunnelFolder();
  const showStatus = vscode.commands.registerCommand('tunnelterm.showStatus', async () => {
    if (!folder) {
      await vscode.window.showWarningMessage('TunnelTerm: open a VS Code Remote Tunnel folder first.');
      return;
    }
    await vscode.window.showInformationMessage(
      `TunnelTerm is active for ${friendlyTunnelName(folder.uri.authority)} (${folder.uri.path}).`,
    );
  });
  context.subscriptions.push(showStatus);

  // A local UI extension is also activated in ordinary local windows. Only a
  // real Remote Tunnel folder becomes a bridge endpoint.
  if (!folder) {
    const pending = await claimPendingOpenRequest();
    if (pending) {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(pending.uri, true), {forceReuseWindow: true});
    }
    return;
  }

  const roots = configuredRoots(folder);
  const configuration = vscode.workspace.getConfiguration('tunnelterm', folder.uri);
  const configuredCwd = configuration.get('defaultCwd', '').trim();
  const defaultCwd = safeRemotePath(configuredCwd || folder.uri.path, roots);
  const shell = configuration.get('shell', '').trim();
  const maxTransferBytes = Math.max(
    1024 * 1024,
    Math.min(512 * 1024 * 1024, Number(configuration.get('maxTransferBytes', 64 * 1024 * 1024))),
  );
  const pollMilliseconds = Math.max(10, Math.min(1000, Number(configuration.get('requestPollMs', 30))));
  const instanceKey = crypto
    .createHash('sha256')
    .update(`${folder.uri.authority}\0${folder.uri.path}\0${process.pid}`)
    .digest('hex')
    .slice(0, 16);
  const instanceDirectory = path.join(localStateRoot(), 'instances', instanceKey);
  const queueDirectory = path.join(instanceDirectory, 'queue');
  const statusFile = path.join(instanceDirectory, 'status.json');
  const tokenFile = path.join(instanceDirectory, 'token');
  await fs.mkdir(queueDirectory, {recursive: true, mode: 0o700});

  let token;
  try {
    token = (await fs.readFile(tokenFile, 'utf8')).trim();
  } catch {
    const candidate = crypto.randomBytes(32).toString('hex');
    try {
      const handle = await fs.open(tokenFile, 'wx', 0o600);
      await handle.writeFile(`${candidate}\n`);
      await handle.close();
      token = candidate;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      token = (await fs.readFile(tokenFile, 'utf8')).trim();
    }
  }

  const remoteBase = `/tmp/tunnelterm-${instanceKey}-${token.slice(0, 12)}`;
  const helperPath = `${remoteBase}/tunnelterm_agent.py`;
  const activeSessions = new Map();
  const activeTcpRelays = new Map();
  const inFlightRequests = new Set();
  let streamEndpointLookup;
  let stopped = false;
  let processing = false;
  const remoteHealth = createRemoteHealthProbe({
    probe: () => vscode.workspace.fs.stat(folder.uri),
    isTrusted: () => vscode.workspace.isTrusted,
    isStopped: () => stopped,
  });
  let localQueueFailed = false;
  let publication;

  async function statusValue() {
    const health = remoteHealth.snapshot();
    if (localQueueFailed && health.bridge_alive && vscode.workspace.isTrusted) {
      Object.assign(health, {ready: false, health_code: 'BRIDGE_IO_FAILED', next_action: 'inspect_bridge'});
    }
    return {
      protocol: PROTOCOL_VERSION,
      extensionVersion: context.extension.packageJSON.version,
      sourceSha256: BUILD_SHA256,
      runtimeGeneration: RUNTIME_GENERATION,
      capabilities: {ssh_stream: 1, tcp_packets: 1},
      ...health,
      trusted: vscode.workspace.isTrusted,
      instance: instanceKey,
      tunnel: friendlyTunnelName(folder.uri.authority),
      authority: decodeURIComponent(folder.uri.authority),
      remoteName: vscode.env.remoteName,
      workspace: folder.uri.toString(),
      defaultCwd,
      allowedRoots: roots,
      shell: shell || null,
      pid: process.pid,
      platform: process.platform,
      updated: new Date().toISOString(),
    };
  }

  function publishStatus() {
    if (publication) {
      publication.again = true;
      return publication.promise;
    }
    const current = {again: true};
    publication = current;
    current.promise = Promise.resolve().then(async () => {
      do {
        current.again = false;
        await atomicLocal(statusFile, await statusValue(), 0o600, 3);
      } while (current.again);
    }).finally(() => {
      if (publication === current) publication = undefined;
      // A request can arrive between the final loop test and this microtask.
      if (current.again) void publishStatus().catch(() => {});
    });
    return current.promise;
  }

  let queueTimer, heartbeatTimer, heartbeatWork;
  context.subscriptions.push({
    dispose() {
      if (stopped) return;
      stopped = true;
      remoteHealth.stop();
      clearInterval(queueTimer);
      clearInterval(heartbeatTimer);
      for (const {execution} of activeSessions.values()) execution.terminate();
      for (const {execution} of activeTcpRelays.values()) execution.terminate();
      return publishStatus().catch(() => {});
    },
  });

  await publishStatus();
  if (stopped || !vscode.workspace.isTrusted) return;
  await remoteHealth.check();
  await publishStatus();
  if (stopped) return;

  async function ensureHelper() {
    const helper = await fs.readFile(path.join(context.extensionPath, 'remote', 'tunnelterm_agent.py'));
    const digest = crypto.createHash('sha256').update(helper).digest('hex');
    const marker = `${remoteBase}/agent.sha256`;
    let current = '';
    try {
      current = Buffer.from(await vscode.workspace.fs.readFile(remoteUri(folder, marker))).toString('utf8').trim();
    } catch {}
    if (current === digest && await remoteExists(folder, helperPath)) return;
    await vscode.workspace.fs.createDirectory(remoteUri(folder, remoteBase));
    await remoteAtomic(folder, helperPath, helper);
    await remoteAtomic(folder, marker, Buffer.from(`${digest}\n`));
  }

  async function readCaptured(remotePath) {
    const stat = await vscode.workspace.fs.stat(remoteUri(folder, remotePath));
    if (stat.size > maxTransferBytes) {
      return {data: '', bytes: stat.size, truncated: true};
    }
    const data = Buffer.from(await vscode.workspace.fs.readFile(remoteUri(folder, remotePath)));
    return {data: data.toString('base64'), bytes: data.length, truncated: false};
  }

  async function executeCommand(request) {
    if (typeof request.command !== 'string' || !request.command.length) {
      throw new Error('exec requires a non-empty command');
    }
    const cwd = safeRemotePath(request.cwd || defaultCwd, roots);
    const seconds = Math.max(1, Math.min(86400, Number(request.timeout_seconds) || 120));
    const jobId = crypto.randomUUID();
    const job = `${remoteBase}/jobs/${jobId}`;
    await ensureHelper();
    await vscode.workspace.fs.createDirectory(remoteUri(folder, job));
    await remoteAtomic(folder, `${job}/request.json`, Buffer.from(JSON.stringify({
      command: request.command,
      cwd,
      timeout_seconds: seconds,
      shell,
    })));
    const task = taskFor(folder, jobId, `TunnelTerm exec ${jobId}`, '/usr/bin/env', ['python3', helperPath, 'exec', job], cwd);
    const execution = await vscode.tasks.executeTask(task);
    const deadline = Date.now() + (seconds + 15) * 1000;
    let result;
    while (Date.now() < deadline) {
      result = await readRemoteJson(folder, `${job}/result.json`, null);
      if (result) break;
      await delay(100);
    }
    if (!result) {
      execution.terminate();
      throw new Error('Remote command did not produce a result before the bridge deadline');
    }
    const stdout = await readCaptured(`${job}/stdout.bin`);
    const stderr = await readCaptured(`${job}/stderr.bin`);
    return {
      exit_code: result.exit_code,
      timed_out: result.timed_out,
      duration_ms: result.duration_ms,
      stdout_base64: stdout.data,
      stderr_base64: stderr.data,
      stdout_bytes: stdout.bytes,
      stderr_bytes: stderr.bytes,
      stdout_truncated: stdout.truncated,
      stderr_truncated: stderr.truncated,
      remote_job: job,
    };
  }

  async function startSession(request) {
    const cwd = safeRemotePath(request.cwd || defaultCwd, roots);
    const cols = Math.max(1, Math.min(1000, Number(request.cols) || 80));
    const rows = Math.max(1, Math.min(1000, Number(request.rows) || 24));
    const id = crypto.randomUUID();
    const session = `${remoteBase}/sessions/${id}`;
    await ensureHelper();
    await vscode.workspace.fs.createDirectory(remoteUri(folder, `${session}/in`));
    await vscode.workspace.fs.createDirectory(remoteUri(folder, `${session}/out`));
    const selectedShell = typeof request.shell === 'string' && request.shell.trim() ? request.shell.trim() : shell;
    const task = taskFor(
      folder,
      id,
      `TunnelTerm shell ${id}`,
      '/usr/bin/env',
      ['python3', helperPath, 'session', session, '--cwd', cwd, '--shell', selectedShell, '--cols', String(cols), '--rows', String(rows)],
      cwd,
    );
    const execution = await vscode.tasks.executeTask(task);
    activeSessions.set(id, {execution, session, inputSequence: 0});

    const deadline = Date.now() + 10_000;
    let state = null;
    while (Date.now() < deadline) {
      state = await readRemoteJson(folder, `${session}/state.json`, null);
      if (state) break;
      await delay(100);
    }
    if (!state) {
      execution.terminate();
      activeSessions.delete(id);
      throw new Error('Remote PTY helper did not start. Check the hidden TunnelTerm task log and confirm python3 is installed.');
    }
    return {session_id: id, cwd, shell: selectedShell || null, state};
  }

  function requireSession(request) {
    const session = activeSessions.get(request.session_id);
    if (!session) throw new Error('Unknown or expired session');
    return session;
  }

  async function sessionInput(request) {
    const session = requireSession(request);
    if (typeof request.data_base64 !== 'string') throw new Error('Missing input data');
    const data = Buffer.from(request.data_base64, 'base64');
    if (data.length > 1024 * 1024) throw new Error('One input packet may not exceed 1 MiB');
    const sequence = session.inputSequence++;
    const inputPath = `${session.session}/in/${String(sequence).padStart(16, '0')}.bin`;
    await remoteAtomic(folder, inputPath, data);
    const deadline = Date.now() + 5000;
    let acknowledged = false;
    while (Date.now() < deadline) {
      const ack = await readRemoteJson(folder, `${session.session}/input_ack.json`, {});
      if (Number(ack.sequence) >= sequence) {
        acknowledged = true;
        break;
      }
      await delay(10);
    }
    if (!acknowledged) throw new Error('Remote PTY did not acknowledge input');
    await vscode.workspace.fs.delete(remoteUri(folder, inputPath), {useTrash: false}).catch(() => {});
    return {accepted: data.length};
  }

  async function sessionResize(request) {
    const session = requireSession(request);
    const cols = Math.max(1, Math.min(1000, Number(request.cols) || 80));
    const rows = Math.max(1, Math.min(1000, Number(request.rows) || 24));
    await remoteAtomic(folder, `${session.session}/resize.json`, Buffer.from(JSON.stringify({cols, rows, at: Date.now()})));
    return {cols, rows};
  }

  async function sessionPoll(request) {
    const session = requireSession(request);
    const entries = await vscode.workspace.fs.readDirectory(remoteUri(folder, `${session.session}/out`));
    const names = entries
      .filter(([name, type]) => type === vscode.FileType.File && /^\d{16}\.bin$/.test(name))
      .map(([name]) => name)
      .sort();
    const buffers = [];
    let total = 0;
    let lastSequence = -1;
    for (const name of names) {
      if (total >= 1024 * 1024) break;
      const itemPath = `${session.session}/out/${name}`;
      const data = Buffer.from(await vscode.workspace.fs.readFile(remoteUri(folder, itemPath)));
      buffers.push(data);
      total += data.length;
      await vscode.workspace.fs.delete(remoteUri(folder, itemPath), {useTrash: false});
      lastSequence = Number(name.slice(0, 16));
    }
    if (lastSequence >= 0) {
      await remoteAtomic(folder, `${session.session}/ack.json`, Buffer.from(JSON.stringify({sequence: lastSequence})));
    }
    const state = await readRemoteJson(folder, `${session.session}/state.json`, {state: 'starting'});
    const remaining = Math.max(0, names.length - buffers.length);
    const done = state.state === 'exited' && remaining === 0;
    if (done) activeSessions.delete(request.session_id);
    return {
      data_base64: Buffer.concat(buffers).toString('base64'),
      bytes: total,
      remaining_chunks: remaining,
      state,
      done,
    };
  }

  async function closeSession(request) {
    const session = requireSession(request);
    await remoteAtomic(folder, `${session.session}/close`, Buffer.from('close\n'));
    await delay(100);
    session.execution.terminate();
    activeSessions.delete(request.session_id);
    return {closed: true};
  }

  async function startTcpRelay(request) {
    if (request.host !== '127.0.0.1' || Number(request.port) !== 22) {
      throw new Error('TunnelTerm TCP relay only permits 127.0.0.1:22');
    }
    const id = crypto.randomUUID();
    const session = `${remoteBase}/tcp/${id}`;
    await ensureHelper();
    await vscode.workspace.fs.createDirectory(remoteUri(folder, `${session}/in`));
    await vscode.workspace.fs.createDirectory(remoteUri(folder, `${session}/out`));
    const task = taskFor(
      folder,
      id,
      `TunnelTerm SSH relay ${id}`,
      '/usr/bin/env',
      ['python3', helperPath, 'tcp', session, '--host', '127.0.0.1', '--port', '22'],
      defaultCwd,
    );
    const execution = await vscode.tasks.executeTask(task);
    activeTcpRelays.set(id, {execution, session, inputSequence: 0});
    const deadline = Date.now() + 15_000;
    let state = null;
    while (Date.now() < deadline) {
      state = await readRemoteJson(folder, `${session}/state.json`, null);
      if (state) break;
      await delay(100);
    }
    if (!state || state.state !== 'running') {
      execution.terminate();
      activeTcpRelays.delete(id);
      throw new Error(state?.error || 'Remote SSH relay did not start');
    }
    return {relay_id: id, state};
  }

  function requireTcpRelay(request) {
    const relay = activeTcpRelays.get(request.relay_id);
    if (!relay) throw new Error('Unknown or expired TCP relay');
    return relay;
  }

  async function tcpInput(request) {
    const relay = requireTcpRelay(request);
    if (typeof request.data_base64 !== 'string') throw new Error('Missing TCP input data');
    const data = Buffer.from(request.data_base64, 'base64');
    if (!data.length || data.length > 64 * 1024) throw new Error('One TCP input packet must be 1..65536 bytes');
    const sequence = relay.inputSequence++;
    const inputPath = `${relay.session}/in/${String(sequence).padStart(16, '0')}.bin`;
    await remoteAtomic(folder, inputPath, data);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const ack = await readRemoteJson(folder, `${relay.session}/input_ack.json`, {});
      if (Number(ack.sequence) >= sequence) {
        await vscode.workspace.fs.delete(remoteUri(folder, inputPath), {useTrash: false}).catch(() => {});
        return {accepted: data.length};
      }
      await delay(10);
    }
    throw new Error('Remote SSH relay did not acknowledge input');
  }

  async function tcpPoll(request) {
    const relay = requireTcpRelay(request);
    const entries = await vscode.workspace.fs.readDirectory(remoteUri(folder, `${relay.session}/out`));
    const names = entries
      .filter(([name, type]) => type === vscode.FileType.File && /^\d{16}\.bin$/.test(name))
      .map(([name]) => name)
      .sort();
    const buffers = [];
    let total = 0;
    let lastSequence = -1;
    for (const name of names) {
      if (total >= 1024 * 1024) break;
      const itemPath = `${relay.session}/out/${name}`;
      const data = Buffer.from(await vscode.workspace.fs.readFile(remoteUri(folder, itemPath)));
      buffers.push(data);
      total += data.length;
      await vscode.workspace.fs.delete(remoteUri(folder, itemPath), {useTrash: false});
      lastSequence = Number(name.slice(0, 16));
    }
    if (lastSequence >= 0) {
      await remoteAtomic(folder, `${relay.session}/ack.json`, Buffer.from(JSON.stringify({sequence: lastSequence})));
    }
    const state = await readRemoteJson(folder, `${relay.session}/state.json`, {state: 'starting'});
    const remaining = Math.max(0, names.length - buffers.length);
    const done = state.state === 'exited' && remaining === 0;
    if (done) activeTcpRelays.delete(request.relay_id);
    return {data_base64: Buffer.concat(buffers).toString('base64'), bytes: total, state, done};
  }

  async function closeTcpRelay(request) {
    const relay = requireTcpRelay(request);
    await remoteAtomic(folder, `${relay.session}/close`, Buffer.from('close\n'));
    await delay(100);
    relay.execution.terminate();
    activeTcpRelays.delete(request.relay_id);
    return {closed: true};
  }

  async function handle(request) {
    if (!request || request.protocol !== PROTOCOL_VERSION) {
      throw new Error(`Unsupported protocol version; expected ${PROTOCOL_VERSION}`);
    }
    if (stopped || !vscode.workspace.isTrusted) throw new Error('The local bridge requires a trusted, running workspace');
    switch (request.op) {
      case 'status':
        await remoteHealth.check();
        return statusValue();
      case 'exec':
        return executeCommand(request);
      case 'read': {
        const remotePath = safeRemotePath(request.path, roots);
        const stat = await vscode.workspace.fs.stat(remoteUri(folder, remotePath));
        if (stat.size > maxTransferBytes) throw new Error(`File exceeds ${maxTransferBytes} byte transfer limit`);
        const data = Buffer.from(await vscode.workspace.fs.readFile(remoteUri(folder, remotePath)));
        return {data_base64: data.toString('base64'), bytes: data.length};
      }
      case 'write': {
        const remotePath = safeRemotePath(request.path, roots);
        if (typeof request.data_base64 !== 'string') throw new Error('Missing file data');
        const data = Buffer.from(request.data_base64, 'base64');
        if (data.length > maxTransferBytes) throw new Error(`File exceeds ${maxTransferBytes} byte transfer limit`);
        await remoteAtomic(folder, remotePath, data);
        return {bytes: data.length};
      }
      case 'session.start': return startSession(request);
      case 'session.input': return sessionInput(request);
      case 'session.resize': return sessionResize(request);
      case 'session.poll': return sessionPoll(request);
      case 'session.close': return closeSession(request);
      case 'tcp.start': return startTcpRelay(request);
      case 'tcp.input': return tcpInput(request);
      case 'tcp.poll': return tcpPoll(request);
      case 'tcp.close': return closeTcpRelay(request);
      case 'tcp.stream.endpoint': {
        try {
          if (!streamEndpointLookup) {
            const current = {};
            const native = Promise.resolve().then(() => vscode.commands.executeCommand('tunnelterm.streamEndpoint', {mapping_timeout_ms: 3000}));
            let timer;
            current.bounded = Promise.race([native, new Promise((_, reject) => {
              timer = setTimeout(() => reject(Object.assign(new Error('Mapping deadline exceeded'), {code: 'MAPPING_TIMEOUT'})), 4000);
            })]).finally(() => clearTimeout(timer));
            void native.then(() => {if (streamEndpointLookup === current) streamEndpointLookup = undefined;},
              () => {if (streamEndpointLookup === current) streamEndpointLookup = undefined;});
            streamEndpointLookup = current;
          }
          return await streamEndpointLookup.bounded;
        } catch (error) {
          throw streamEndpointError(error);
        }
      }
      default: throw new Error(`Unsupported operation: ${String(request.op)}`);
    }
  }

  async function processClaimedRequest(processingFile, output) {
    let request;
    try {
      request = JSON.parse(await fs.readFile(processingFile, 'utf8'));
      // Re-read the credential to tolerate two VS Code windows racing to
      // initialize the same endpoint directory during process startup.
      const currentToken = (await fs.readFile(tokenFile, 'utf8')).trim();
      if (request.token !== currentToken) throw new Error('Invalid local bridge token');
      if (!/^[0-9a-f-]{36}$/.test(request.id)) throw new Error('Invalid request id');
      await atomicLocal(output, {ok: true, protocol: PROTOCOL_VERSION, ...(await handle(request))});
    } catch (error) {
      const diagnostic = request?.op === 'tcp.stream.endpoint' ? publicStreamEndpointFailure(error) : {};
      await atomicLocal(output, {ok: false, protocol: PROTOCOL_VERSION, error: String(error?.message || error), ...diagnostic});
    } finally {
      await fs.unlink(processingFile).catch(() => {});
    }
  }

  async function processQueue() {
    if (processing || stopped || !vscode.workspace.isTrusted) return;
    processing = true;
    try {
      const names = (await fs.readdir(queueDirectory))
        .filter(name => /^[0-9a-f-]+\.request\.json$/.test(name))
        .sort()
        .slice(0, Math.max(0, 64 - inFlightRequests.size));
      for (const name of names) {
        const input = path.join(queueDirectory, name);
        const processingFile = input.replace('.request.json', '.processing.json');
        const output = input.replace('.request.json', '.response.json');
        try {
          await fs.rename(input, processingFile);
        } catch {
          continue;
        }
        const requestPromise = processClaimedRequest(processingFile, output)
          .finally(() => inFlightRequests.delete(requestPromise));
        inFlightRequests.add(requestPromise);
      }
      localQueueFailed = false;
    } catch {
      localQueueFailed = true;
      await publishStatus().catch(() => {});
    } finally {
      processing = false;
    }
  }

  queueTimer = setInterval(() => void processQueue(), pollMilliseconds);
  heartbeatTimer = setInterval(() => {
    if (stopped || heartbeatWork) return;
    const current = remoteHealth.check().then(publishStatus);
    heartbeatWork = current;
    void current.catch(() => {}).finally(() => {if (heartbeatWork === current) heartbeatWork = undefined;});
    return current;
  }, 5000);
}

exports.activate = activate;
exports.deactivate = function deactivate() {};
