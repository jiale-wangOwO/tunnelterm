import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  encodeRemoteUri,
  listInstances,
  selectInstance,
  stateRoot,
} from '../src/client-core.mjs';

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
