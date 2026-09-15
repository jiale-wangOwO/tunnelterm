import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

test('Windows doctor uses the bundled CLI without launching Code.exe', {skip: process.platform !== 'win32'}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnelterm doctor '));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('tunnelterm doctor '));
    fs.rmSync(root, {recursive: true, force: true});
  });
  fs.mkdirSync(path.join(root, 'bin'));
  // Deliberately not executable: the GUI must never be launched by doctor.
  fs.writeFileSync(path.join(root, 'Code.exe'), '');
  fs.writeFileSync(path.join(root, 'bin', 'code.cmd'), '@echo off\r\necho 9.9.9-test-cli\r\n');
  const result = spawnSync(process.execPath, [cli, 'doctor', '--code', path.join(root, 'Code.exe')], {
    encoding: 'utf8', timeout: 15_000,
    env: {...process.env, TUNNELTERM_HOME: path.join(root, 'state')},
  });
  assert.equal(result.error, undefined);
  assert.match(result.stdout, /VS Code CLI 9\.9\.9-test-cli/);
});

test('open reports an asynchronously launched process failure without waiting for readiness timeout', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnelterm open '));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('tunnelterm open '));
    fs.rmSync(root, {recursive: true, force: true});
  });
  const started = Date.now();
  const result = spawnSync(process.execPath, [
    cli, 'open', 'my-server', '/home/test/project', '--code', process.execPath,
  ], {
    encoding: 'utf8', timeout: 5_000,
    env: {...process.env, TUNNELTERM_HOME: path.join(root, 'state')},
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /VS Code exited with status [1-9]\d*/);
  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual(fs.readdirSync(path.join(root, 'state', 'open-requests')), []);
});

test('open reports spawn errors promptly and removes its pending request', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnelterm spawn '));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('tunnelterm spawn '));
    fs.rmSync(root, {recursive: true, force: true});
  });
  const missingCode = path.join(root, process.platform === 'win32' ? 'missing-code.exe' : 'missing-code');
  const started = Date.now();
  const result = spawnSync(process.execPath, [
    cli, 'open', 'my-server', '/home/test/project', '--code', missingCode,
  ], {
    encoding: 'utf8', timeout: 5_000,
    env: {...process.env, TUNNELTERM_HOME: path.join(root, 'state')},
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT|not found/i);
  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual(fs.readdirSync(path.join(root, 'state', 'open-requests')), []);
});
