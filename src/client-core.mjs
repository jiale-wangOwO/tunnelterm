import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const PROTOCOL_VERSION = 1;

export function stateRoot(environment = process.env, platform = process.platform, home = os.homedir()) {
  if (environment.TUNNELTERM_HOME) return path.resolve(environment.TUNNELTERM_HOME);
  if (platform === 'win32' && environment.LOCALAPPDATA) {
    return path.join(environment.LOCALAPPDATA, 'TunnelTerm');
  }
  return path.join(home, '.local', 'state', 'tunnelterm');
}

export async function atomicWrite(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = `${file}.tmp-${randomUUID()}`;
  const data = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  await fs.writeFile(temporary, data, {mode: 0o600});
  await fs.rename(temporary, file);
}

export async function listInstances(root = stateRoot(), now = Date.now()) {
  const instancesDirectory = path.join(root, 'instances');
  let names;
  try {
    names = await fs.readdir(instancesDirectory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const result = [];
  for (const name of names) {
    try {
      const directory = path.join(instancesDirectory, name);
      const status = JSON.parse(await fs.readFile(path.join(directory, 'status.json'), 'utf8'));
      const token = (await fs.readFile(path.join(directory, 'token'), 'utf8')).trim();
      const ageMilliseconds = now - Date.parse(status.updated);
      result.push({
        ...status,
        token,
        directory,
        active: status.ready === true && Number.isFinite(ageMilliseconds) && ageMilliseconds < 20_000,
        ageMilliseconds,
      });
    } catch {
      // An extension may be replacing its status file while discovery runs.
    }
  }
  return result.sort((left, right) => Date.parse(right.updated) - Date.parse(left.updated));
}

export function selectInstance(instances, target) {
  const active = instances.filter(instance => instance.active);
  if (!target) {
    if (active.length === 1) return active[0];
    if (!active.length) throw new Error('No active TunnelTerm bridge. Open a trusted VS Code Remote Tunnel workspace first.');
    throw new Error(`More than one bridge is active (${active.map(item => item.tunnel).join(', ')}). Use --target <tunnel-or-instance>.`);
  }
  const exact = active.filter(instance =>
    instance.instance === target || instance.tunnel === target || instance.authority === target);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new Error(`Target ${target} matches multiple windows. Use an instance id from 'tunnelterm list'.`);
  }
  const partial = active.filter(instance =>
    instance.instance.startsWith(target) || instance.workspace?.includes(target));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`Target ${target} is ambiguous. Use a full instance id.`);
  throw new Error(`No active bridge matches target: ${target}`);
}

export async function sendRequest(instance, body, timeoutMilliseconds = 30_000) {
  const id = randomUUID();
  const queue = path.join(instance.directory, 'queue');
  const requestFile = path.join(queue, `${id}.request.json`);
  const responseFile = path.join(queue, `${id}.response.json`);
  await atomicWrite(requestFile, {
    id,
    protocol: PROTOCOL_VERSION,
    token: instance.token,
    ...body,
  });
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      const result = JSON.parse(await fs.readFile(responseFile, 'utf8'));
      await fs.unlink(responseFile).catch(() => {});
      if (!result.ok) throw new Error(result.error || 'Bridge request failed');
      return result;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  await fs.unlink(requestFile).catch(() => {});
  throw new Error('TunnelTerm bridge did not respond before the local deadline');
}

export function takeOption(args, longName, shortName) {
  const index = args.findIndex(value => value === longName || value === shortName);
  if (index < 0) return undefined;
  if (index + 1 >= args.length) throw new Error(`${args[index]} requires a value`);
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

export function takeFlag(args, ...names) {
  const index = args.findIndex(value => names.includes(value));
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

export function encodeRemoteUri(tunnel, remotePath) {
  if (!/^[A-Za-z0-9._-]+$/.test(tunnel)) throw new Error('Tunnel name contains unsupported characters');
  if (!remotePath.startsWith('/')) throw new Error('Remote path must be an absolute POSIX path');
  const encodedPath = remotePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
  return `vscode-remote://tunnel+${tunnel}${encodedPath}`;
}
