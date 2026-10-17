// Real SSH integration with a mapping-only fault confined to this listener.
import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash, randomBytes} from 'node:crypto';
import {sendRequest} from '../src/client-core.mjs';
import {startStreamForward} from '../src/ssh-stream.mjs';

const [target, alias, portText = '22225', mode, countText = '6'] = process.argv.slice(2);
const port = Number(portText);
const existing = mode === '--existing';
const queryCount = Number(countText);
if (!target || !alias || !Number.isInteger(port) || port < 1024 || port > 65535 ||
    (mode !== undefined && !existing) || !Number.isInteger(queryCount) || queryCount < 6 || queryCount > 30) {
  throw new Error('Usage: node scripts/verify-ssh-query-recovery.mjs ISOLATED_WORKSPACE [SSH_ALIAS] [PORT=22225] [--existing [QUERY_COUNT=6]]');
}
const ssh = process.platform === 'win32' ? 'C:/Windows/System32/OpenSSH/ssh.exe' : 'ssh';
const options = ['-o', `Port=${port}`, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2'];
const digest = value => createHash('sha256').update(value).digest('hex');
const execute = promisify(execFile);
const encode = program => `python3 -c 'exec(__import__("base64").b64decode("${Buffer.from(program).toString('base64')}"))'`;
const logBytes = Buffer.from(`${JSON.stringify({source: 'isolated-test', text: '隔离日志 中文/UTF-8/EOF'})}\n`);
let mappingHung = false, forward, recoveryCandidates = 0;
const held = [];
const query = async (command, input = Buffer.alloc(0), timeout = 12000) => {
  const pending = execute(ssh, ['-T', ...options, alias, command], {windowsHide: true, timeout, maxBuffer: 3 * 1024 * 1024, encoding: 'buffer'});
  pending.child.stdin.on('error', () => {});
  pending.child.stdin.end(input);
  return (await pending).stdout;
};
try {
  if (!existing) forward = await startStreamForward({target, port, request: (instance, body, timeout) => {
    if (mappingHung && body.op === 'tcp.stream.endpoint') {
      throw new Error('VS Code port mapping did not finish before its deadline; isolated injected native-mapping stall');
    }
    return sendRequest(instance, body, timeout);
  }, trace: entry => {if (entry.stage === 'mapping_recovery_candidate') recoveryCandidates++;}, log: message => console.error(message)});
  console.log(JSON.stringify({stage: existing ? 'using_existing_isolated_listener' : 'isolated_listener_ready', port}));
  for (let index = 0; index < 2; index++) {
    const program = index === 0 ? `import os,sys,tempfile,base64
with tempfile.TemporaryDirectory(prefix="tunnelterm-query-") as directory:
    filename=os.path.join(directory,"fixture.jsonl")
    with open(filename,"wb") as log: log.write(base64.b64decode("${logBytes.toString('base64')}"))
    print("QUERY_FIXTURE",filename,flush=True)
    print("QUERY_HOLD_READY",os.getpid(),flush=True)
    sys.stdin.readline()
    print("QUERY_HOLD_DONE",flush=True)
` : 'import os,sys\nprint("QUERY_HOLD_READY",os.getpid(),flush=True)\nsys.stdin.readline()\nprint("QUERY_HOLD_DONE",flush=True)';
    const child = spawn(ssh, ['-tt', ...options, alias, encode(program)], {windowsHide: true});
    child.stdin.on('error', () => {});
    const record = {child, output: ''};
    held.push(record);
    child.stdout.on('data', data => {if (record.output.length < 100000) record.output += data.toString();});
    child.stderr.resume();
    record.exit = new Promise((resolve, reject) => {child.once('error', reject); child.once('close', resolve);});
    void record.exit.catch(() => {});
    const deadline = Date.now() + 12000;
    while (!record.output.includes('QUERY_HOLD_READY') && Date.now() < deadline) {
      assert.equal(child.exitCode, null, 'held SSH ended before readiness');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.match(record.output, /QUERY_HOLD_READY \d+/);
  }
  const fixture = held[0].output.match(/QUERY_FIXTURE (\/tmp\/tunnelterm-query-[A-Za-z0-9_-]+\/fixture\.jsonl)/)?.[1];
  assert.ok(fixture, 'owned temporary log file path must be verified');
  const logInput = Buffer.from(JSON.stringify({path: fixture}));
  console.log(JSON.stringify({stage: 'two_held_standard_ssh_connections', alive: held.every(record => record.child.exitCode === null)}));
  const metadata = await query("printf 'QUERY_META_OK\\n'; hostname; pwd");
  assert.match(metadata.toString(), /QUERY_META_OK/);
  mappingHung = true;
  const echo = encode('import sys\ndata=sys.stdin.buffer.read()\nsys.stdout.buffer.write(data)');
  const logQuery = encode('import json,sys\npath=json.loads(sys.stdin.buffer.read())["path"]\nwith open(path,"rb") as log: sys.stdout.buffer.write(log.read())');
  const fileMetadata = JSON.parse((await query(encode('import json,sys,os\npath=json.loads(sys.stdin.buffer.read())["path"]\nprint(json.dumps(dict(size=os.stat(path).st_size,uid=os.getuid())))'), logInput)).toString());
  assert.equal(fileMetadata.size, logBytes.length);
  console.log(JSON.stringify({stage: 'owned_log_metadata', size: fileMetadata.size, stdin_eof: true, held_connections: 2}));
  for (let index = 0; index < queryCount; index++) {
    const began = Date.now();
    assert.equal(digest(await query(logQuery, logInput)), digest(logBytes));
    assert.ok(held.every(record => record.child.exitCode === null), 'held connections must survive extra queries');
    console.log(JSON.stringify({query: index + 1, stdin_eof: true, utf8_log_bytes_match: true, held_connections: 2, elapsed_ms: Date.now() - began}));
  }
  const bytes = randomBytes(1024 * 1024);
  assert.equal(digest(await query(echo, bytes, 20000)), digest(bytes));
  if (!existing) assert.ok(recoveryCandidates >= queryCount + 2);
  console.log(JSON.stringify({binary_bytes: bytes.length, sha256_match: true,
    mapping_fault: existing ? 'not injected; existing isolated listener' : 'injected only on isolated listener',
    recovery_candidates: existing ? undefined : recoveryCandidates}));
  for (const record of held) {record.child.stdin.write('finish\n'); record.child.stdin.end();}
  for (const record of held) {
    let timer;
    try {
      assert.equal(await Promise.race([record.exit, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('Owned held SSH did not finish')), 12000);})]), 0);
    } finally {clearTimeout(timer);}
    assert.match(record.output, /QUERY_HOLD_DONE/);
  }
  console.log(JSON.stringify({standard_ssh_query_recovery: true, existing_work_terminals_touched: false}));
} finally {
  for (const record of held) if (record.child.exitCode === null) record.child.kill();
  await forward?.close();
}
