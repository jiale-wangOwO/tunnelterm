// Isolated listener and owned remote sleeper; never restarts a shared forward.
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {startStreamForward, relayStream} from '../src/ssh-stream.mjs';

const ssh = process.platform === 'win32' ? 'C:/Windows/System32/OpenSSH/ssh.exe' : 'ssh';
const alias = process.argv[2];
const target = process.argv[3];
if (!alias || !target) throw new Error('Usage: node scripts/probe-ssh-disconnect.mjs SSH_ALIAS SERVICE_WORKSPACE');
const nonce = `tunnelterm-disconnect-${randomUUID()}`;
const began = Date.now();
const event = (name, more = {}) => console.log(JSON.stringify({event: name, ms: Date.now() - began, ...more}));
const query = async command => {
  const pending = promisify(execFile)(ssh, ['-n', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', alias, command],
    {windowsHide: true, timeout: 12000, maxBuffer: 65536});
  pending.child.stdin.on('error', () => {});
  pending.child.stdin.end();
  return (await pending).stdout.trim();
};
let forward, child, identity;
try {
  forward = await startStreamForward({target, port: 0, log: message => event('relay_error', {message}), trace: value => event('setup', value),
    relay: (endpoint, input, output, options) => {
      for (const name of ['end', 'close', 'error']) input.on(name, () => event(`local_${name}`, {destroyed: input.destroyed, readableEnded: input.readableEnded, writableEnded: input.writableEnded}));
      return relayStream(endpoint, input, output, options);
    }});
  event('isolated_listener', {port: forward.port});
  const program = 'import os,time; print("PROBE_READY",os.getpid(),open("/proc/self/stat").read().split()[21],flush=True); time.sleep(600)';
  child = spawn(ssh, ['-tt', '-o', `Port=${forward.port}`, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', alias, `python3 -u -c '${program}' ${nonce}`], {windowsHide: true});
  child.stdin.on('error', () => {});
  let output = '';
  child.stdout.on('data', data => {output += data.toString();});
  child.stderr.resume();
  const exited = new Promise((resolve, reject) => {child.once('close', resolve); child.once('error', reject);});
  void exited.catch(() => {});
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline && !/PROBE_READY (\d+) (\d+)/.test(output)) {
    if (child.exitCode !== null) throw new Error('Isolated SSH ended before remote readiness');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const match = output.match(/PROBE_READY (\d+) (\d+)/);
  if (!match) throw new Error('No remote readiness within 12 seconds');
  identity = {pid: Number(match[1]), start: match[2]};
  event('owned_remote_ready', identity);
  child.kill();
  await exited;
  event('owned_ssh_closed');
  let cleaned = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await query(`ps -p ${identity.pid} -o pid=,stat=,etimes= || true`);
    event('owned_remote_state', {state: state || 'gone'});
    if (!state || /\bZ/.test(state)) {cleaned = true; break;}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!cleaned) throw new Error('Owned remote sleeper survived the bounded disconnect probe');
} finally {
  if (child && child.exitCode === null) child.kill();
  if (identity) {
    // Exact PID, start tick and argv nonce guard. Only our temporary sleeper.
    const cleanup = `import os,signal; p=${identity.pid}; s="/proc/%s/"%p; alive=os.path.exists(s+"stat"); owned=alive and open(s+"stat").read().split()[21]=="${identity.start}" and b"${nonce}" in open(s+"cmdline","rb").read(); os.kill(p,signal.SIGTERM) if owned else None; print("owned_cleanup",owned)`;
    try {event('cleanup', {result: await query(`python3 -c '${cleanup}'`)});} catch (error) {event('cleanup_failed', {message: error.message});}
  }
  await forward?.close();
}
