import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../bin/tunnelterm.mjs', import.meta.url));

test('CLI prints help', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], {encoding: 'utf8'});
  assert.equal(result.status, 0);
  assert.match(result.stdout, /tunnelterm shell/);
  assert.match(result.stdout, /Ctrl\+\]/);
});

test('CLI rejects exec without a remote command', () => {
  const result = spawnSync(process.execPath, [cli, 'exec', '--'], {encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires a remote command/);
});
