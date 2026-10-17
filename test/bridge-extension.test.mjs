import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import health from '../src/bridge-health.cjs';

const extensionFile = fileURLToPath(new URL('../src/extension.cjs', import.meta.url));
const source = await fs.readFile(extensionFile, 'utf8');
const nodeRequire = createRequire(import.meta.url);
const flush = () => new Promise(resolve => setImmediate(resolve));
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(predicate) {
  for (let i = 0; i < 100; i++) {if (await predicate()) return; await pause();}
  throw new Error('Test fixture did not settle');
}

async function harness(t, {trusted = true, stat = async () => ({type: 2}), endpoint = async () => ({}),
  localRename = operation => operation()} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tunnelterm-bridge-health-'));
  const folderUri = {scheme: 'vscode-remote', authority: 'tunnel+fixture', path: '/selected-workspace',
    toString: () => 'vscode-remote://tunnel+fixture/selected-workspace'};
  const calls = [], delayDurations = [], intervals = new Map(), deadlines = new Map();
  let statusWrites = 0;
  let statusWriteAttempts = 0;
  let sequence = 0, monitor;
  const setTimer = (fn, milliseconds) => {
    const id = ++sequence;
    delayDurations.push(milliseconds);
    deadlines.set(id, () => {deadlines.delete(id); fn();});
    return id;
  };
  const clearTimer = id => deadlines.delete(id);
  const workspace = {isTrusted: trusted, workspaceFolders: [{uri: folderUri}],
    getConfiguration: () => ({get: (_key, fallback) => fallback}),
    fs: {stat(uri) {calls.push(uri); return stat(uri);}}};
  const vscode = {workspace, env: {remoteName: 'tunnel'}, commands: {
    registerCommand: () => ({dispose() {}}), executeCommand: endpoint},
    window: {showInformationMessage: async () => {}, showWarningMessage: async () => {}},
  };
  const context = {subscriptions: [], extension: {packageJSON: {version: 'test'}}, extensionPath: path.dirname(path.dirname(extensionFile))};
  const exports = {};
  vm.runInNewContext(source, {exports, Buffer, __filename: extensionFile,
    process: {env: {...process.env, TUNNELTERM_HOME: root}, pid: process.pid, platform: process.platform},
    setTimeout: setTimer, clearTimeout: clearTimer,
    setInterval: (fn, milliseconds) => {const id = ++sequence; intervals.set(id, {fn, milliseconds}); return id;},
    clearInterval: id => intervals.delete(id),
    require: name => name === 'vscode' ? vscode : name === './bridge-health.cjs'
      ? {...health, createRemoteHealthProbe: options => {monitor = health.createRemoteHealthProbe({...options, setTimer, clearTimer}); return monitor;}}
      : name === 'node:fs/promises' ? {...fs, rename: async (...args) => {
        if (path.basename(args[1]) === 'status.json') statusWriteAttempts++;
        const result = await localRename(() => fs.rename(...args), args[1]);
        if (path.basename(args[1]) === 'status.json') statusWrites++;
        return result;
      }} : nodeRequire(name),
  });
  const activation = exports.activate(context);
  void activation.catch(() => {});
  const directory = path.join(root, 'instances', crypto.createHash('sha256')
    .update(`${folderUri.authority}\0${folderUri.path}\0${process.pid}`).digest('hex').slice(0, 16));
  const status = async () => {try {return JSON.parse(await fs.readFile(path.join(directory, 'status.json'), 'utf8'));} catch {return undefined;}};
  let disposal;
  const dispose = () => {
    disposal ||= Promise.allSettled(context.subscriptions.map(item => item.dispose()));
    return disposal;
  };
  t.after(async () => {
    try {await dispose(); await activation;}
    finally {await fs.rm(root, {recursive: true, force: true});}
  });
  function tick(milliseconds) {
    return Promise.allSettled([...intervals.values()].filter(interval => interval.milliseconds === milliseconds)
      .map(interval => interval.fn()));
  }
  return {activation, calls, folderUri, workspace, deadlines, intervals, status, dispose, tick, directory,
    delayDurations, statusWrites: () => statusWrites, statusWriteAttempts: () => statusWriteAttempts};
}

test('UI bridge heartbeat never claims provider readiness when the selected remote provider is absent', async t => {
  const fixture = await harness(t, {stat: async () => {throw {code: 'ENOPRO', message: 'PRIVATE_PROVIDER_ERROR vscode-remote://private?token=SECRET'};}});
  await fixture.activation;
  assert.equal((await fixture.status()).bridge_alive, true);
  assert.equal((await fixture.status()).ready, false);
  for (let i = 0; i < 3; i++) {fixture.tick(5000); await until(() => fixture.calls.length === i + 2); await pause();}
  const status = await fixture.status();
  assert.equal(status.remote_ready, false); assert.equal(status.health_code, 'PROVIDER_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE_PROVIDER_ERROR|SECRET/);
  assert.ok(fixture.calls.every(uri => uri === fixture.folderUri), 'probe only the current selected folder URI');
});

test('UI bridge can recover readiness from a later selected-folder stat and revocation blocks further probes', async t => {
  let available = false;
  const fixture = await harness(t, {stat: async () => {if (!available) throw {code: 'ENOPRO'}; return {type: 2};}});
  await fixture.activation;
  let before = fixture.statusWrites();
  available = true; fixture.tick(5000);
  await until(() => fixture.statusWrites() > before);
  assert.equal((await fixture.status()).ready, true);
  const calls = fixture.calls.length;
  before = fixture.statusWrites();
  fixture.workspace.isTrusted = false; fixture.tick(5000);
  await until(() => fixture.statusWrites() > before);
  assert.equal((await fixture.status()).health_code, 'WORKSPACE_UNTRUSTED');
  assert.equal(fixture.calls.length, calls); assert.equal((await fixture.status()).ready, false);
});

test('UI bridge has no remote probes or queue timers in an untrusted workspace', async t => {
  const fixture = await harness(t, {trusted: false});
  await fixture.activation;
  assert.equal(fixture.calls.length, 0); assert.equal(fixture.intervals.size, 0);
  const status = await fixture.status();
  assert.equal(status.bridge_alive, true); assert.equal(status.ready, false); assert.equal(status.health_code, 'WORKSPACE_UNTRUSTED');
});

test('UI bridge registers disposal before an initial native probe can hang', async t => {
  let finish;
  const native = new Promise(resolve => {finish = resolve;});
  const fixture = await harness(t, {stat: () => native});
  await until(() => fixture.calls.length === 1);
  fixture.dispose(); await fixture.activation;
  await until(async () => (await fixture.status())?.health_code === 'BRIDGE_STOPPED');
  assert.equal(fixture.intervals.size, 0); assert.equal(fixture.deadlines.size, 0);
  finish(); await flush();
  assert.equal((await fixture.status()).ready, false); assert.equal(fixture.calls.length, 1);
});

test('UI bridge heartbeat shares a timed-out native stat rather than building an unbounded retry pile', async t => {
  let finish;
  const native = new Promise(resolve => {finish = resolve;});
  const fixture = await harness(t, {stat: () => native});
  await until(() => fixture.calls.length === 1);
  for (const fn of [...fixture.deadlines.values()]) fn();
  await fixture.activation;
  assert.equal((await fixture.status()).health_code, 'PROVIDER_TIMEOUT');
  for (let i = 0; i < 20; i++) fixture.tick(5000);
  await flush(); await pause();
  assert.equal(fixture.calls.length, 1); assert.equal(fixture.deadlines.size, 0);
  finish(); await flush();
  assert.equal((await fixture.status()).ready, false);
});

test('UI endpoint provider failure is classified safely without recommending a companion reinstall', async t => {
  const fixture = await harness(t, {endpoint: async () => {throw {code: 'ENOPRO', message: 'PRIVATE_ENDPOINT_ERROR https://private?token=SECRET'};}});
  await fixture.activation;
  const id = crypto.randomUUID(), queue = path.join(fixture.directory, 'queue');
  const token = (await fs.readFile(path.join(fixture.directory, 'token'), 'utf8')).trim();
  await fs.writeFile(path.join(queue, `${id}.request.json`), JSON.stringify({id, protocol: 1, token, op: 'tcp.stream.endpoint'}));
  fixture.tick(30);
  const responseFile = path.join(queue, `${id}.response.json`);
  let response;
  await until(async () => {try {response = JSON.parse(await fs.readFile(responseFile, 'utf8')); return true;} catch {return false;}});
  assert.equal(response.ok, false); assert.match(response.error, /filesystem provider is unavailable/);
  assert.equal(response.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(response.next_action, 'reconnect_remote_workspace');
  assert.doesNotMatch(response.error, /PRIVATE_ENDPOINT_ERROR|SECRET|companion|install/i);
});

for (const cause of [{code: 'MAPPING_TIMEOUT'}, {name: 'TunnelTermMappingTimeout'}]) {
  test(`endpoint mapping timeout remains fixed and typed through the local queue (${cause.code || cause.name})`, async t => {
    const fixture = await harness(t, {endpoint: async () => {throw {...cause, message: 'PRIVATE_ENDPOINT_ERROR https://private?token=SECRET', next_action: 'PRIVATE_ACTION'};}});
    await fixture.activation;
    const id = crypto.randomUUID(), queue = path.join(fixture.directory, 'queue');
    const token = (await fs.readFile(path.join(fixture.directory, 'token'), 'utf8')).trim();
    await fs.writeFile(path.join(queue, `${id}.request.json`), JSON.stringify({id, protocol: 1, token, op: 'tcp.stream.endpoint'}));
    fixture.tick(30);
    let response;
    await until(async () => {try {response = JSON.parse(await fs.readFile(path.join(queue, `${id}.response.json`), 'utf8')); return true;} catch {return false;}});
    assert.deepEqual(Object.keys(response).sort(), ['code', 'error', 'next_action', 'ok', 'protocol']);
    assert.equal(response.ok, false); assert.equal(response.code, 'MAPPING_TIMEOUT');
    assert.equal(response.next_action, 'reload_selected_workspace');
    assert.match(response.error, /active connections.*reload only the selected/i);
    assert.doesNotMatch(JSON.stringify(response), /PRIVATE_|SECRET|https:|token=/);
  });
}

test('pending local publication stays single-flight, retains the old timestamp and publishes the latest stopped snapshot', async t => {
  let blocked = false, available = true, release;
  const pending = new Promise(resolve => {release = resolve;});
  const fixture = await harness(t, {stat: async () => {if (!available) throw {code: 'ENOPRO'}; return {type: 2};},
    localRename: async (operation, target) => {
      if (blocked && path.basename(target) === 'status.json') await pending;
      return operation();
    }});
  await fixture.activation;
  const original = await fixture.status(), attempts = fixture.statusWriteAttempts(), writes = fixture.statusWrites();
  const calls = fixture.calls.length;
  blocked = true; available = false;
  const heartbeat = fixture.tick(5000);
  await until(() => fixture.statusWriteAttempts() === attempts + 1);
  for (let i = 0; i < 200; i++) await fixture.tick(5000);
  assert.equal(fixture.statusWriteAttempts(), attempts + 1); assert.equal(fixture.calls.length, calls + 1);
  assert.equal((await fixture.status()).updated, original.updated, 'a pending writer cannot refresh a stale record');
  const stopped = fixture.dispose();
  for (let i = 0; i < 200; i++) await fixture.tick(5000);
  assert.equal(fixture.intervals.size, 0); assert.equal(fixture.calls.length, calls + 1);
  blocked = false; release(); await heartbeat; await stopped;
  const final = await fixture.status();
  assert.equal(final.bridge_alive, false); assert.equal(final.ready, false); assert.equal(final.health_code, 'BRIDGE_STOPPED');
  assert.equal(fixture.statusWrites(), writes + 2, 'concurrent requests coalesce into one initial write and one latest write');
});

test('permanent status publication failure does not replace the previous record or pretend to update its timestamp', async t => {
  let failed = false, available = true;
  const fixture = await harness(t, {stat: async () => {if (!available) throw {code: 'ENOPRO'}; return {type: 2};},
    localRename: async (operation, target) => {
      if (failed && path.basename(target) === 'status.json') throw Object.assign(new Error('PRIVATE_LOCAL_ERROR token=SECRET'), {code: 'EIO'});
      return operation();
    }});
  await fixture.activation;
  const original = await fixture.status(), attempts = fixture.statusWriteAttempts(), calls = fixture.calls.length;
  failed = true; available = false;
  await fixture.tick(5000);
  assert.equal(fixture.statusWriteAttempts(), attempts + 1);
  assert.deepEqual(await fixture.status(), original);
  await fixture.dispose();
  assert.equal(fixture.intervals.size, 0); assert.equal(fixture.calls.length, calls + 1);
  assert.deepEqual(await fixture.status(), original);
  const names = await fs.readdir(fixture.directory);
  assert.ok(!names.some(name => name.startsWith('status.json.tmp-')), 'failed own temporary writes are cleaned, not the old published target');
});

test('Windows status sharing violations retry at most three times within a fixed 150ms wait budget', async t => {
  let failed = false;
  const fixture = await harness(t, {localRename: async (operation, target) => {
    if (failed && path.basename(target) === 'status.json') throw Object.assign(new Error('sharing lock'), {code: 'EPERM'});
    return operation();
  }});
  await fixture.activation;
  const original = await fixture.status(), attempts = fixture.statusWriteAttempts(), delays = fixture.delayDurations.length;
  failed = true;
  const heartbeat = fixture.tick(5000);
  for (let retry = 0; retry < 3; retry++) {
    await until(() => fixture.statusWriteAttempts() === attempts + retry + 1 && fixture.deadlines.size === 1);
    for (const fn of [...fixture.deadlines.values()]) fn();
  }
  await heartbeat;
  assert.equal(fixture.statusWriteAttempts(), attempts + 4);
  assert.deepEqual(fixture.delayDurations.slice(delays).filter(milliseconds => milliseconds === 50), [50, 50, 50]);
  assert.deepEqual(await fixture.status(), original, 'all retries failing must preserve the old record unchanged');
  failed = false;
});
