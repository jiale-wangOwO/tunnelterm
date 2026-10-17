import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import health from '../src/bridge-health.cjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
};
function timers() {
  const pending = new Map();
  let sequence = 0;
  return {setTimer(fn) {pending.set(++sequence, fn); return sequence;}, clearTimer(id) {pending.delete(id);},
    fire() {for (const [id, fn] of [...pending]) {pending.delete(id); fn();}}, pending};
}

test('a live local bridge is not ready until the selected workspace probe succeeds', async () => {
  const stat = deferred(), clock = timers();
  let calls = 0;
  const monitor = health.createRemoteHealthProbe({probe: () => {calls++; return stat.promise;}, isTrusted: () => true, ...clock});
  assert.deepEqual(monitor.snapshot(), {bridge_alive: true, remote_ready: false, ready: false,
    provider_state: 'unchecked', health_code: 'PROVIDER_UNCHECKED', next_action: 'wait_for_probe'});
  const checking = monitor.check();
  await flush();
  assert.equal(calls, 1); assert.equal(monitor.snapshot().provider_state, 'checking');
  stat.resolve({type: 2});
  const ready = await checking;
  assert.equal(ready.bridge_alive, true); assert.equal(ready.remote_ready, true); assert.equal(ready.ready, true);
  assert.equal(ready.provider_state, 'ready'); assert.equal(ready.health_code, 'PROVIDER_READY');
  assert.equal(clock.pending.size, 0);
});

test('hung native probes retain one flight after bounded timeout; late success cannot publish false ready', async () => {
  const stat = deferred(), clock = timers();
  let calls = 0;
  const monitor = health.createRemoteHealthProbe({probe: () => {calls++; return calls === 1 ? stat.promise : Promise.resolve();}, isTrusted: () => true, ...clock});
  const first = monitor.check();
  for (let i = 0; i < 50; i++) assert.equal(monitor.check(), first);
  await flush(); assert.equal(calls, 1);
  clock.fire();
  assert.equal((await first).health_code, 'PROVIDER_TIMEOUT');
  for (let i = 0; i < 50; i++) assert.equal(monitor.check(), first);
  assert.equal(calls, 1); assert.equal(clock.pending.size, 0);
  stat.resolve(); await flush();
  assert.equal(monitor.snapshot().ready, false);
  assert.equal(monitor.snapshot().provider_state, 'timeout');
  assert.equal((await monitor.check()).ready, true); assert.equal(calls, 2);
});

test('untrusted and stopped workspaces never start a native probe', async () => {
  let calls = 0, trusted = false, stopped = false;
  const monitor = health.createRemoteHealthProbe({probe: () => {calls++;}, isTrusted: () => trusted, isStopped: () => stopped});
  assert.equal((await monitor.check()).health_code, 'WORKSPACE_UNTRUSTED');
  assert.equal(calls, 0);
  trusted = true; stopped = true;
  assert.equal((await monitor.check()).bridge_alive, false); assert.equal(calls, 0);
});

test('stop settles a pending caller immediately and prevents late probe completion or retry', async () => {
  const stat = deferred(), clock = timers();
  let calls = 0;
  const monitor = health.createRemoteHealthProbe({probe: () => {calls++; return stat.promise;}, isTrusted: () => true, ...clock});
  const pending = monitor.check(); await flush();
  monitor.stop();
  const stopped = await pending;
  assert.equal(stopped.ready, false); assert.equal(stopped.bridge_alive, false); assert.equal(stopped.health_code, 'BRIDGE_STOPPED');
  stat.resolve(); await flush();
  assert.equal((await monitor.check()).health_code, 'BRIDGE_STOPPED');
  assert.equal(calls, 1); assert.equal(clock.pending.size, 0);
});

test('trust revoked during an in-flight probe cannot become ready when that operation finishes', async () => {
  const stat = deferred(), clock = timers();
  let trusted = true, calls = 0;
  const monitor = health.createRemoteHealthProbe({probe: () => {calls++; return stat.promise;}, isTrusted: () => trusted, ...clock});
  const pending = monitor.check(); await flush();
  trusted = false;
  assert.equal((await monitor.check()).health_code, 'WORKSPACE_UNTRUSTED');
  assert.equal((await pending).ready, false);
  stat.resolve(); await flush();
  assert.equal(monitor.snapshot().health_code, 'WORKSPACE_UNTRUSTED'); assert.equal(calls, 1);
});

const privateText = 'PRIVATE_VALUE vscode-remote://tunnel+private/private token=PRIVATE_TOKEN';
for (const [cause, code] of [
  [{code: 'ENOPRO'}, 'PROVIDER_UNAVAILABLE'],
  [{message: 'No file system provider found. ' + privateText}, 'PROVIDER_UNAVAILABLE'],
  [{code: 'EACCES'}, 'PERMISSION_DENIED'], [{code: 'NoPermissions'}, 'PERMISSION_DENIED'],
  [{code: 'ENOENT'}, 'WORKSPACE_UNAVAILABLE'], [{code: 'FileNotFound'}, 'WORKSPACE_UNAVAILABLE'],
  [{code: 'ETIMEDOUT'}, 'PROVIDER_TIMEOUT'], [{code: 'ABORT_ERR'}, 'CANCELLED'],
  [{name: 'Canceled'}, 'CANCELLED'], [{code: privateText, message: privateText}, 'PROVIDER_FAILED'],
]) {
  test(`provider failure exposes fixed health code ${code} only (${JSON.stringify(cause.code || cause.name || 'message')})`, async () => {
    assert.equal(health.classifyProviderFailure(cause), code);
    const monitor = health.createRemoteHealthProbe({probe: async () => {throw {...cause, ...(cause.message ? {} : {message: privateText})};}, isTrusted: () => true});
    const value = await monitor.check();
    assert.equal(value.health_code, code); assert.equal(value.ready, false); assert.equal(value.bridge_alive, true);
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_|vscode-remote/);
  });
}

test('endpoint classification separates missing companion, provider loss, mapping stall and unknown errors', () => {
  for (const [cause, expected] of [
    [{message: "command 'tunnelterm.streamEndpoint' not found " + privateText}, 'COMPANION_UNAVAILABLE'],
    [{code: 'ENOPRO', message: privateText}, 'PROVIDER_UNAVAILABLE'],
    [{code: 'MAPPING_TIMEOUT', message: privateText}, 'MAPPING_TIMEOUT'],
    [{name: 'TunnelTermMappingTimeout', message: privateText}, 'MAPPING_TIMEOUT'],
    [{message: 'Temporary mapping failure ' + privateText}, 'MAPPING_UNAVAILABLE'],
    [{code: 'EACCES', message: privateText}, 'PERMISSION_DENIED'],
    [{code: privateText, message: privateText}, 'ENDPOINT_FAILED'],
  ]) {
    const safe = health.streamEndpointError(cause);
    assert.equal(safe.code, expected);
    assert.doesNotMatch(safe.message + JSON.stringify(safe), /PRIVATE_|vscode-remote|token=/);
    if (expected !== 'COMPANION_UNAVAILABLE') assert.doesNotMatch(safe.message, /companion|install/i);
    assert.equal(safe.cause, undefined);
    assert.equal(typeof safe.next_action, 'string');
  }
});

test('endpoint diagnostics reconstruct fixed messages and canonical actions only', () => {
  const safe = health.publicStreamEndpointFailure({code: 'MAPPING_TIMEOUT', error: privateText,
    message: privateText, next_action: privateText, uri: privateText, token: privateText});
  assert.deepEqual(Object.keys(safe).sort(), ['code', 'error', 'next_action']);
  assert.equal(safe.code, 'MAPPING_TIMEOUT');
  assert.equal(safe.next_action, 'reload_selected_workspace');
  assert.match(safe.error, /active connections.*reload only the selected/i);
  assert.doesNotMatch(JSON.stringify(safe), /PRIVATE_|vscode-remote|token=/);
  for (const code of [privateText, '__proto__', 'constructor', 1, undefined]) {
    assert.deepEqual(health.publicStreamEndpointFailure({code, next_action: 'reload_selected_workspace'}), {});
  }
  assert.deepEqual(health.publicStreamEndpointFailure(null), {});
});

test('public health drops forged enums, strings pretending to be booleans and arbitrary diagnostics', () => {
  assert.deepEqual(health.publicHealth({bridge_alive: true, remote_ready: false, provider_state: 'timeout',
    health_code: 'PROVIDER_TIMEOUT', next_action: 'reconnect_remote_workspace', error: privateText}), {
    bridge_alive: true, remote_ready: false, provider_state: 'timeout', health_code: 'PROVIDER_TIMEOUT', next_action: 'reconnect_remote_workspace'});
  assert.deepEqual(health.publicHealth({bridge_alive: privateText, remote_ready: 1, provider_state: privateText,
    health_code: privateText, next_action: privateText, error: privateText}), {});
});

test('health helper ships with the extension and CLI package', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.files.includes('src/bridge-health.cjs'));
});
