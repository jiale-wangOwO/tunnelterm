import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const json = async name => JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));

test('public package includes every local runtime module and both CLI entry points', async () => {
  const manifest = await json('package.json');
  const files = new Set(manifest.files);
  assert.equal(files.size, manifest.files.length, 'avoid duplicate package entries');
  for (const file of manifest.files) assert.ok((await fs.stat(path.join(root, file))).isFile(), `missing package file: ${file}`);
  for (const file of Object.values(manifest.bin)) assert.ok(files.has(file.replace(/^\.\//, '')));
  for (const file of manifest.files.filter(name => /\.(mjs|cjs)$/.test(name))) {
    const source = await fs.readFile(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/\b(?:from\s*|import\s*\(|require\s*\()(['"])(\.[^'"]+)\1/g)) {
      const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[2]));
      assert.ok(files.has(relative), `${file} imports unpackaged module ${relative}`);
    }
  }
  assert.ok(files.has('src/bridge-health.cjs'));
  assert.ok(files.has('remote/tunnelterm_agent.py'));
  assert.ok(!files.has('tools/ssh.cmd'), 'local legacy adapter is not a public runtime dependency');
});

test('both extension versions and committed dependency locks are consistent', async () => {
  const main = await json('package.json'), stream = await json('remote-stream/package.json');
  assert.equal(main.version, stream.version);
  for (const prefix of ['', 'remote-stream/']) {
    const manifest = await json(`${prefix}package.json`), lock = await json(`${prefix}package-lock.json`);
    assert.equal(lock.version, manifest.version);
    assert.equal(lock.packages[''].version, manifest.version);
    assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
    assert.deepEqual(lock.packages[''].devDependencies, manifest.devDependencies);
  }
});
