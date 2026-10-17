import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  encodeRemoteUri,
  listInstances,
  selectInstance,
  sendRequest,
  stateRoot,
} from '../src/client-core.mjs';

// A synthetic queue only: no VS Code process, remote provider or SSH exists.
async function syntheticFailure(t, body, response) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tunnelterm-error-code-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const queue = path.join(directory, 'queue');
  const pending = sendRequest({directory, token: 'synthetic-only'}, body, 1000);
  // Observe rejection immediately; the fixture writes its response below.
  const outcome = pending.then(() => {throw new Error('Synthetic failure unexpectedly succeeded');}, error => error);
  let name;
  for (let count = 0; count < 100 && !name; count++) {
    name = (await fs.readdir(queue).catch(() => [])).find(item => item.endsWith('.request.json'));
    if (!name) await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(name, 'the single request reached the inert queue');
  await fs.writeFile(path.join(queue, name.replace('.request.json', '.response.json')), JSON.stringify({ok: false, protocol: 1, ...response}));
  const error = await outcome;
  assert.equal((await fs.readdir(queue)).filter(item => item.endsWith('.request.json')).length, 1, 'no second request was submitted');
  return error;
}

test('endpoint queue failures preserve allowlisted type and canonical action without native error data', async t => {
  const error = await syntheticFailure(t, {op: 'tcp.stream.endpoint'}, {code: 'MAPPING_TIMEOUT',
    error: 'PRIVATE_ERROR https://private?token=SECRET', next_action: 'PRIVATE_ACTION', token: 'SECRET', cause: {raw: 'PRIVATE_CAUSE'}});
  assert.equal(error.code, 'MAPPING_TIMEOUT'); assert.equal(error.next_action, 'reload_selected_workspace');
  assert.match(error.message, /native endpoint.*pending.*active connections.*reload only the selected/i);
  assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE_|SECRET|https:|token=/);
  assert.equal(error.cause, undefined); assert.equal(error.token, undefined);
});

test('forged endpoint diagnostic code and action are not propagated', async t => {
  for (const code of ['PRIVATE_CODE', '__proto__', 'constructor', 1]) {
    const error = await syntheticFailure(t, {op: 'tcp.stream.endpoint'}, {code, error: 'legacy fixed failure', next_action: 'reload_selected_workspace'});
    assert.equal(error.message, 'legacy fixed failure'); assert.equal(error.code, undefined); assert.equal(error.next_action, undefined);
  }
});

test('typed endpoint diagnostics do not attach to a different operation or change legacy errors', async t => {
  const other = await syntheticFailure(t, {op: 'status'}, {code: 'MAPPING_TIMEOUT', error: 'ordinary status failure', next_action: 'reload_selected_workspace'});
  assert.equal(other.message, 'ordinary status failure'); assert.equal(other.code, undefined); assert.equal(other.next_action, undefined);
  const legacy = await syntheticFailure(t, {op: 'tcp.stream.endpoint'}, {error: 'legacy bridge failure'});
  assert.equal(legacy.message, 'legacy bridge failure'); assert.equal(legacy.code, undefined); assert.equal(legacy.next_action, undefined);
});

test('stateRoot honors an explicit home', () => {
  assert.equal(stateRoot({TUNNELTERM_HOME: './bridge-state'}, 'linux', '/home/test'), path.resolve('./bridge-state'));
  assert.equal(stateRoot({LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local'}, 'win32', 'unused'), path.join('C:\\Users\\test\\AppData\\Local', 'TunnelTerm'));
  assert.equal(stateRoot({}, 'linux', '/home/test'), path.join('/home/test', '.local', 'state', 'tunnelterm'));
});

test('encodeRemoteUri encodes path segments without hiding separators', () => {
  assert.equal(
    encodeRemoteUri('my-server', '/home/test/a folder/#result'),
    'vscode-remote://tunnel+my-server/home/test/a%20folder/%23result',
  );
  assert.throws(() => encodeRemoteUri('bad/name', '/tmp'), /unsupported/);
  assert.throws(() => encodeRemoteUri('good', 'relative'), /absolute/);
});

test('selectInstance chooses a sole active endpoint and reports ambiguity', () => {
  const one = {instance: 'abcdef', tunnel: 'spark', authority: 'tunnel+spark', workspace: 'vscode-remote://tunnel+spark/home/test/project', active: true};
  const two = {instance: '123456', tunnel: 'other', authority: 'tunnel+other', workspace: 'vscode-remote://tunnel+other/home/test/tools', active: true};
  assert.equal(selectInstance([one], undefined), one);
  assert.equal(selectInstance([one, two], 'spark'), one);
  assert.equal(selectInstance([one, two], '123'), two);
  assert.equal(selectInstance([one, two], '/home/test/project'), one);
  assert.throws(() => selectInstance([one, two]), /More than one/);
  assert.throws(() => selectInstance([], undefined), /No active/);
});

test('an exact workspace beats nested-workspace prefix matches without hiding duplicate windows', () => {
  const parent = {instance: 'parent', active: true, workspace: 'vscode-remote://tunnel+spark/home/test/service'};
  const child = {instance: 'child', active: true, workspace: `${parent.workspace}/isolated-test`};
  assert.equal(selectInstance([parent, child], parent.workspace), parent);
  assert.equal(selectInstance([parent, child], '/home/test/service'), parent);
  assert.equal(selectInstance([parent, child], child.workspace), child);
  assert.throws(() => selectInstance([parent, {...parent, instance: 'duplicate'}], parent.workspace), /multiple windows/);
});

test('listInstances marks fresh ready endpoints active and ignores malformed entries', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tunnelterm-test-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const good = path.join(root, 'instances', 'good');
  const bad = path.join(root, 'instances', 'bad');
  await fs.mkdir(good, {recursive: true});
  await fs.mkdir(bad, {recursive: true});
  const now = Date.now();
  await fs.writeFile(path.join(good, 'status.json'), JSON.stringify({
    ready: true,
    updated: new Date(now - 1000).toISOString(),
    instance: 'good',
    tunnel: 'spark',
  }));
  await fs.writeFile(path.join(good, 'token'), 'secret\n');
  await fs.writeFile(path.join(bad, 'status.json'), '{broken');
  const result = await listInstances(root, now);
  assert.equal(result.length, 1);
  assert.equal(result[0].active, true);
  assert.equal(result[0].token, 'secret');
});
