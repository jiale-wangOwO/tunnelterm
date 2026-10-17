// Run in the same user/session as the independent service; public metadata only.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {defaultDevTunnelExecutable} from '../src/devtunnel-client.mjs';
import {stateRoot} from '../src/client-core.mjs';
const selected = defaultDevTunnelExecutable();
const name = process.platform === 'win32' ? 'devtunnel.exe' : 'devtunnel';
const cached = path.join(stateRoot(), 'bin', name);
const shared = path.join(os.homedir(), '.tunnelterm', 'bin', name);
const result = {pid: process.pid, selected_executable: selected, paths: []};
for (const executable of [...new Set([selected, shared, cached])]) {
  let state = 'unavailable', exit = null;
  try {
    const value = await promisify(execFile)(executable, ['user', 'show'], {windowsHide: true, timeout: 5000, encoding: 'utf8', maxBuffer: 16384});
    state = /not logged in/i.test(value.stdout + value.stderr) ? 'not_logged_in' : /logged in/i.test(value.stdout + value.stderr) ? 'cached_account_present' : 'unknown';
    exit = 0;
  } catch (error) {exit = error.code;}
  result.paths.push({executable, state, exit});
}
const directory = process.env.TUNNELTERM_SERVICE_HOME ? path.resolve(process.env.TUNNELTERM_SERVICE_HOME) :
  process.platform === 'win32' && !process.env.TUNNELTERM_HOME ? path.join(os.homedir(), '.tunnelterm', 'services') : path.join(stateRoot(), 'services');
await fs.mkdir(directory, {recursive: true, mode: 0o700});
await fs.writeFile(path.join(directory, 'cli-context-probe.json'), JSON.stringify(result), {mode: 0o600});
