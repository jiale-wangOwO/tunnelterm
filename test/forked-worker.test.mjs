import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {fork} from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import test from 'node:test';
import {createForkedWorker} from '../src/forked-worker.mjs';
import {probeSshBanner} from '../src/managed-service.mjs';
import {startBroker} from '../remote-stream/broker.cjs';

function fakeChild(response) {
  const child = new EventEmitter();
  Object.assign(child, {pid: 12345, connected: true, stderr: new PassThrough(), send(message) {
    queueMicrotask(() => {
      if (message.type === 'start') child.emit('message', {type: 'online', port: 1234});
      else if (message.type === 'seed') child.emit('message', {type: 'seed', id: message.id, ...response()});
      else if (message.type === 'stop') {child.connected = false; child.emit('exit', 0);}
    });
  }});
  return child;
}

test('owned worker IPC preserves only explicit seed invalidation booleans alongside the private route', async t => {
  const seed = {workspace: 'fixture', identity: 'fixture:generation', endpoint: {token: 'PRIVATE_CAPABILITY'}};
  for (const seedInvalidated of [true, false, undefined, 'true', 1]) {
    const child = fakeChild(() => ({seed, seedInvalidated}));
    const worker = await createForkedWorker({target: 'fixture'}, {launch: () => child});
    t.after(() => worker.close());
    const state = await worker.routeSeedState();
    assert.equal(state.seed, seed);
    assert.equal(state.seedInvalidated, typeof seedInvalidated === 'boolean' ? seedInvalidated : undefined);
    assert.equal(await worker.routeSeed(), seed);
  }
});

test('disconnected worker preserves a confirmed invalidation but an unqueried worker remains unknown', async t => {
  const child = fakeChild(() => ({seedInvalidated: true}));
  const worker = await createForkedWorker({target: 'fixture'}, {launch: () => child});
  t.after(() => worker.close());
  await worker.routeSeedState(); child.connected = false;
  assert.equal((await worker.routeSeedState()).seedInvalidated, true);
  child.connected = true;
  const unknown = fakeChild(() => ({}));
  const other = await createForkedWorker({target: 'fixture'}, {launch: () => unknown});
  t.after(() => other.close());
  unknown.connected = false;
  assert.equal((await other.routeSeedState()).seedInvalidated, undefined);
  unknown.connected = true;
});

test('failed worker IPC preserves fixed setup diagnostics but strips arbitrary error data', async () => {
  const privateText = 'PRIVATE_TOKEN https://private.invalid/account';
  const child = fakeChild(() => ({}));
  child.send = () => queueMicrotask(() => {
    child.emit('message', {type: 'failed', code: 'CLI_FAILED', detail: 'CLI_CHECK_CLI_FAILED',
      cause_kind: 'PROCESS_EXIT', exit_code: 1, cli_hints: ['console', privateText],
      message: privateText, token: privateText, endpoint: privateText, seedInvalidated: 'true'});
    child.connected = false; child.emit('exit', 1);
  });
  await assert.rejects(createForkedWorker({target: 'fixture'}, {launch: () => child}), error => {
    assert.equal(error.message, 'Transport dependency is unavailable');
    assert.equal(error.detail, 'CLI_CHECK_CLI_FAILED'); assert.equal(error.code, 'CLI_FAILED');
    assert.equal(error.cause_kind, 'PROCESS_EXIT'); assert.equal(error.exit_code, 1);
    assert.deepEqual(error.cli_hints, ['console']); assert.equal(error.seedInvalidated, false);
    assert.equal(JSON.stringify(error).includes('PRIVATE_'), false);
    return true;
  });
});

test('real owned fork returns explicit rejected-seed state over IPC without a remote host', {timeout: 5000}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tunnelterm-owned-worker-test-'));
  const sockets = new Set();
  let destinations = 0, worker, broker;
  const destination = net.createServer(socket => {
    destinations++; sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    socket.write('SSH-2.0-test\r\n');
  });
  t.after(async () => {
    await worker?.close(); await broker?.close();
    for (const socket of sockets) socket.destroy();
    if (destination.listening) await new Promise(resolve => destination.close(resolve));
    await fs.rm(root, {recursive: true, force: true});
  });
  destination.listen(0, '127.0.0.1'); await once(destination, 'listening');
  broker = await startBroker({destinationPort: destination.address().port});
  const directory = path.join(root, 'instances', 'fixture');
  await fs.mkdir(directory, {recursive: true}); await fs.mkdir(path.join(root, 'services'));
  const status = {instance: 'fixture', workspace: 'vscode-remote://tunnel+fixture/home/fixture', runtimeGeneration: 'same',
    ready: false, bridge_alive: true, trusted: true, capabilities: {ssh_stream: 1}, health_code: 'PROVIDER_TIMEOUT',
    updated: new Date().toISOString()};
  await fs.writeFile(path.join(directory, 'status.json'), JSON.stringify(status));
  await fs.writeFile(path.join(directory, 'token'), 'LOCAL_TEST_QUEUE_TOKEN');
  const seed = {workspace: status.workspace, identity: 'fixture:same', endpoint: {protocol: 1,
    uri: `http://127.0.0.1:${broker.port}/ssh`, generation: broker.generation, token: 'REJECTED_TEST_TOKEN'}};
  worker = await createForkedWorker({target: status.workspace, seed}, {
    launch: (module, args, options) => fork(module, args, {...options, env: {...process.env,
      TUNNELTERM_HOME: root, TUNNELTERM_SERVICE_HOME: path.join(root, 'services')}}),
  });
  assert.equal((await worker.routeSeedState()).seedInvalidated, false);
  await assert.rejects(probeSshBanner(worker.port, {timeout: 500}));
  const state = await worker.routeSeedState();
  assert.equal(state.seedInvalidated, true); assert.equal(state.seed, undefined); assert.equal(destinations, 0);
});
