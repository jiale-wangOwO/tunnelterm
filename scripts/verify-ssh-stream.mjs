import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes, createHash} from 'node:crypto';

const alias = process.argv[2];
const rounds = Number(process.argv[3] || 3);
const port = process.argv[4] === undefined ? undefined : Number(process.argv[4]);
const binaryOnly = process.argv.includes('--binary-only');
const transferTimeout = Number(process.env.TUNNELTERM_TEST_TRANSFER_TIMEOUT_MS || 20000);
if (!alias || !Number.isInteger(rounds) || rounds < 1 || rounds > 20 ||
    (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) ||
    !Number.isInteger(transferTimeout) || transferTimeout < 2000 || transferTimeout > 120000) {
  throw new Error('Usage: node scripts/verify-ssh-stream.mjs SSH_ALIAS [ROUNDS=3] [ISOLATED_PORT]');
}
const ssh = process.platform === 'win32' ? 'C:/Windows/System32/OpenSSH/ssh.exe' : 'ssh';
const options = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2'];
if (port !== undefined) options.push('-o', `Port=${port}`);
const execute = promisify(execFile);
const query = command => {
  const pending = execute(ssh, ['-T', ...options, alias, command], {windowsHide: true, timeout: 12000, maxBuffer: 1024 * 1024});
  // These control commands have no input. Windows OpenSSH can stall after its
  // first stdout packet when an unused piped stdin is left open. Send normal
  // SSH-channel EOF; the held PTY and binary test keep their own input streams.
  pending.child.stdin.on('error', () => {});
  pending.child.stdin.end();
  return pending;
};
const digest = value => createHash('sha256').update(value).digest('hex');

async function round() {
  const began = Date.now();
  const held = spawn(ssh, ['-tt', ...options, alias,
    `tty; stty cols 120 rows 30; python3 -u -c 'import sys; print("SSH_STREAM_HOLD_READY", flush=True); sys.stdin.readline(); print("SSH_STREAM_HOLD_DONE", flush=True)'`],
  {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
  held.stdin.on('error', () => {});
  let output = '', stderr = '';
  held.stdout.on('data', data => {if (output.length < 100000) output += data.toString();});
  held.stderr.on('data', data => {if (stderr.length < 100000) stderr += data.toString();});
  const ended = new Promise((resolve, reject) => {held.once('error', reject); held.once('close', code => resolve(code));});
  // Readiness is polled separately, so don't leave an early spawn rejection
  // unhandled while that bounded readiness loop is still running.
  void ended.catch(() => {});
  const waitFor = async marker => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (output.includes(marker)) return;
      if (held.exitCode !== null) throw new Error(`Held SSH ended early (${held.exitCode}): ${stderr.slice(0, 300)}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Held SSH exceeded 12-second readiness budget');
  };
  try {
    await waitFor('SSH_STREAM_HOLD_READY');
    const readyMs = Date.now() - began;
    const tty = output.match(/\/dev\/pts\/\d+/)?.[0];
    assert.ok(tty, 'Expected an actual remote PTY');
    const parallelBegan = Date.now();
    const results = await Promise.all([
      query("printf 'SSH_IDENT_OK\\n'; hostname; uname -m; python3 --version; tmux -V"),
      query(`stty -F ${tty} cols 110 rows 28; stty -F ${tty} size`),
      query("printf 'SSH_CWD_OK\\n'; pwd"),
    ]);
    assert.match(results[0].stdout, /SSH_IDENT_OK/);
    assert.match(results[1].stdout, /28 110/);
    assert.match(results[2].stdout, /SSH_CWD_OK/);
    assert.equal(held.exitCode, null);
    const parallelMs = Date.now() - parallelBegan;
    held.stdin.write('finish\n');
    await waitFor('SSH_STREAM_HOLD_DONE');
    held.stdin.end();
    let timer;
    try {assert.equal(await Promise.race([ended, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('Held SSH shutdown exceeded 12 seconds')), 12000);})]), 0);}
    finally {clearTimeout(timer);}
    return {persistent_ready_ms: readyMs, parallel_aux_ms: parallelMs, independent_connections: 4, remote_pty: true, resize: true, total_ms: Date.now() - began};
  } finally {if (held.exitCode === null) held.kill();}
}

async function binary() {
  const began = Date.now();
  const bytes = randomBytes(1024 * 1024);
  const child = spawn(ssh, ['-T', ...options, alias, "python3 -c 'import sys; data=sys.stdin.buffer.read(); sys.stdout.buffer.write(data)'"], {windowsHide: true});
  child.stdin.on('error', () => {});
  const chunks = [];
  let receivedBytes = 0;
  child.stdout.on('data', data => {chunks.push(data); receivedBytes += data.length;});
  child.stderr.resume();
  const exit = new Promise((resolve, reject) => {child.once('error', reject); child.once('close', resolve);});
  const timer = setTimeout(() => child.kill(), transferTimeout);
  const progress = setInterval(() => console.log(JSON.stringify({binary_progress: true, received_bytes: receivedBytes,
    total_bytes: bytes.length, input_finished: child.stdin.writableFinished, elapsed_ms: Date.now() - began})), 5000);
  try {
    child.stdin.end(bytes);
    assert.equal(await exit, 0, `Binary transfer did not complete in its ${transferTimeout} ms test budget (${receivedBytes}/${bytes.length} bytes received)`);
    assert.equal(digest(Buffer.concat(chunks)), digest(bytes));
    return {bytes: bytes.length, sha256_match: true, stdin_eof: true, elapsed_ms: Date.now() - began, budget_ms: transferTimeout};
  } finally {clearTimeout(timer); clearInterval(progress); if (child.exitCode === null) child.kill();}
}

try {
  const results = [];
  if (!binaryOnly) for (let index = 0; index < rounds; index++) {results.push(await round()); console.log(JSON.stringify({round: index + 1, ...results.at(-1)}));}
  console.log(JSON.stringify({binary: await binary(), completed_rounds: results.length, standard_openssh: true}));
} catch (error) {
  console.error(JSON.stringify({standard_openssh: false, error: error.message,
    code: error.code, killed: error.killed, stderr: error.stderr?.slice(0, 1500), stdout: error.stdout?.slice(0, 200)}));
  process.exitCode = 1;
}
