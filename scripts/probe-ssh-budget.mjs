import {spawn} from 'node:child_process';
const alias = process.argv[2];
if (!alias) throw new Error('Usage: node scripts/probe-ssh-budget.mjs SSH_ALIAS [--close-stdin]');
const closedInput = process.argv.includes('--close-stdin');
const hold = process.argv.includes('--hold');
const external = process.argv.includes('--external');
const controls = process.argv.includes('--controls');
const quiet = process.argv.includes('--quiet');
const executable = process.platform === 'win32' ? 'C:/Windows/System32/OpenSSH/ssh.exe' : 'ssh';
let held;
let tty;
if (hold) {
  held = spawn(executable, ['-tt', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', alias,
    `${controls ? 'tty; stty cols 120 rows 30; ' : ''}python3 -u -c 'import sys; print("PROBE_HOLD_READY", flush=True); sys.stdin.readline()'`], {windowsHide: true});
  held.stdin.on('error', () => {}); held.stderr.resume();
  let text = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {held.kill(); reject(new Error('Held probe readiness timed out'));}, 12000);
    held.stdout.on('data', data => {text += data.toString(); if(text.includes('PROBE_HOLD_READY')){clearTimeout(timer);resolve();}});
    held.on('error', error => {clearTimeout(timer);reject(error);});
  });
  tty = text.match(/\/dev\/pts\/\d+/)?.[0];
}
const patterns = [
  ['tcp', /Connection established/], ['banner', /Remote protocol version/],
  ['keys', /SSH2_MSG_NEWKEYS received/], ['authenticated', /Authenticated to/],
  ['command', /Sending command/], ['exit_status', /rtype exit-status/], ['ssh_exit', /Exit status/],
];
await Promise.all([1, 2, 3].map(index => new Promise(resolve => {
  const began = Date.now();
  let command = `printf 'SSH_PROBE_${index}\\n'` + (external ? '; /usr/bin/hostname; /usr/bin/uname -m; /usr/bin/python3 --version' : '');
  if(controls){
    if(!tty)throw new Error('Controls require --hold and an owned PTY');
    command += index===1 ? '; hostname; uname -m; python3 --version; tmux -V' : index===2 ? `; stty -F ${tty} cols 110 rows 28; stty -F ${tty} size` : '; pwd';
  }
  const child = spawn(executable, ['-T', ...(quiet ? [] : ['-v']), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', alias, command], {windowsHide: true});
  const phases = {};
  let marker = '', pending = '';
  child.stdout.on('data', data => {marker += data.toString();});
  child.stderr.on('data', data => {
    pending += data.toString();
    const lines = pending.split(/\r?\n/); pending = lines.pop();
    for (const line of lines) for (const [name, regex] of patterns) if (regex.test(line) && phases[name] === undefined) phases[name] = Date.now() - began;
  });
  child.stdin.on('error', () => {});
  if (closedInput) child.stdin.end();
  const timer = setTimeout(() => child.kill(), 12000);
  child.on('error', error => {clearTimeout(timer); console.log(JSON.stringify({index, error: error.code})); resolve();});
  child.on('close', (code, signal) => {clearTimeout(timer); console.log(JSON.stringify({index, closedInput, phases, code, signal, marker_received: marker.includes(`SSH_PROBE_${index}`), stdout_chars:marker.length, total_ms: Date.now() - began})); resolve();});
})));
if (held) {held.stdin.write('finish\n'); held.stdin.end(); setTimeout(() => {if(held.exitCode===null)held.kill();},2000).unref();}
