import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import test from 'node:test';
import {serviceControlSocket} from '../src/service-cli.mjs';

const cli = fileURLToPath(new URL('../bin/tunnelterm.mjs', import.meta.url));
const execute = promisify(execFile);
test('control sockets stay within the macOS byte limit and keep profile namespaces distinct', () => {
  const directory = `/tmp/${'nested/'.repeat(25)}工具`;
  const options = {platform: 'darwin', uid: 12345};
  const socket = serviceControlSocket(directory, 'fixture', options);
  assert.ok(Buffer.byteLength(socket) <= 103);
  assert.match(socket, /^\/tmp\/tunnelterm-12345\/control-[a-f0-9]{32}\.sock$/);
  assert.notEqual(socket, serviceControlSocket(`${directory}/other`, 'fixture', options));
  assert.notEqual(socket, serviceControlSocket(directory, 'other', options));
  assert.notEqual(socket, serviceControlSocket(directory.toUpperCase(), 'fixture', options));
  assert.ok(serviceControlSocket('/tmp/short', 'fixture', options).startsWith('/tmp/short/'));
  assert.throws(() => serviceControlSocket(directory, 'fixture', {...options, uid: -1}), /owner/);
});
test('real daemon control reports offline distinctly, owns one profile, and stops cleanly', {timeout: 15000}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tunnelterm-service-test-'));
  const serviceDirectory = path.join(root, process.platform === 'win32' ? 'services' : 'nested-'.repeat(20), 'services');
  const env = {...process.env, TUNNELTERM_HOME: root, TUNNELTERM_SERVICE_HOME: serviceDirectory};
  const allocate = net.createServer(); allocate.listen(0, '127.0.0.1'); await once(allocate, 'listening');
  const port = allocate.address().port; await new Promise(resolve => allocate.close(resolve));
  const child = spawn(process.execPath, [cli, 'service', 'run', '--profile', 'fixture', '--target', 'no-bridge', '--port', String(port)], {env, windowsHide: true});
  let stderr = ''; child.stderr.on('data', data => {stderr += data.toString();}); child.stdout.resume();
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => {if (child.exitCode === null) child.kill(); await exited; await fs.rm(root, {recursive: true, force: true});});
  const call = async args => {
    const result = await execute(process.execPath, [cli, 'service', ...args, '--profile', 'fixture'], {env, timeout: 5000, windowsHide: true});
    return JSON.parse(result.stdout);
  };
  const deadline = Date.now() + 5000;
  let status;
  while (Date.now() < deadline) {
    try {status = await call(['status']); if (status.phase === 'offline') break;} catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(status.phase, 'offline', stderr);
  assert.equal(status.accepting_new, false);
  assert.equal(status.last_failure.code, 'BRIDGE_UNAVAILABLE');
  assert.ok(!JSON.stringify(status).includes('control_token'));
  const id = status.service_id;
  const againResult = await execute(process.execPath, [cli, 'service', 'start', '--target', 'no-bridge', '--port', String(port), '--profile', 'fixture'], {env, timeout: 5000, windowsHide: true}).catch(error => error);
  assert.equal(againResult.code, 1);
  const again = JSON.parse(againResult.stdout);
  assert.equal(again.outcome, 'not_ready');
  assert.equal(again.service_id, id); assert.equal(again.pid, child.pid);
  await assert.rejects(call(['run', '--target', 'other-target', '--port', String(port + 1)]), /already running/);
  const config = JSON.parse(await fs.readFile(path.join(serviceDirectory, 'fixture.json'), 'utf8'));
  assert.equal(config.target, 'no-bridge'); assert.equal(config.port, port);
  config.custom_preserved = {nested: 'setting'};
  await fs.writeFile(path.join(serviceDirectory, 'fixture.json'), JSON.stringify(config));
  const recovering = await execute(process.execPath, [cli, 'service', 'recover', '--profile', 'fixture', '--wait-ms', '500'], {env, timeout: 3000, windowsHide: true}).catch(error => error);
  assert.equal(recovering.code, 1);
  const notReady = JSON.parse(recovering.stdout);
  assert.equal(notReady.outcome, 'not_ready'); assert.equal(notReady.next_action, 'open_owned_service_window');
  assert.equal(notReady.pid, child.pid);
  const restarted = await execute(process.execPath, [cli, 'service', 'restart', '--profile', 'fixture', '--wait-ms', '2000'], {env, timeout: 7000, windowsHide: true}).catch(error => error);
  assert.equal(restarted.code, 1);
  assert.ok(restarted.stdout?.trim(), `restart returned no status: ${restarted.stderr}\n${await fs.readFile(path.join(serviceDirectory, 'fixture.log'), 'utf8').catch(() => '')}`);
  const restartedStatus = JSON.parse(restarted.stdout);
  assert.notEqual(restartedStatus.pid, child.pid); assert.equal(restartedStatus.outcome, 'not_ready'); assert.equal(restartedStatus.operation, 'restart');
  assert.equal(restartedStatus.target, config.target); assert.equal(restartedStatus.port, config.port);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(serviceDirectory, 'fixture.json'), 'utf8')), config);
  const newPid = restartedStatus.pid;
  t.after(async () => {try {await call(['stop']);} catch {} });
  assert.equal((await call(['stop'])).phase, 'stopped');
  await exited;
  assert.equal((await call(['status'])).phase, 'stopped');
});
