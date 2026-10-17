import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {StringDecoder} from 'node:string_decoder';
import {stateRoot} from './client-core.mjs';
import {cliOperationError, hasExplicitCliAuthFailure} from './stream-errors.mjs';

// Only the read-only account preflight is eligible for one bounded retry. A
// generic CLI exit is not evidence of expired credentials or a network outage.
const transientCheckCodes = new Set(['ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH']);
const permanentCheckPattern = /\bconsole\b|\bterminal\b|\bhandle\b|\bcredential|\bkeyring\b|\bkeychain\b|\bvault\b|\bstorage\b|\bstore\b|\bdirectory\b|\bfile\b|\bpermission\b|\baccess denied\b|\bnot permitted\b|\bconfiguration\b|\bconfig\b|\bargument\b|\busage\b|\b(?:unknown|unrecognized|invalid)\s+(?:command|option|flag|subcommand)\b|\btls\b|\bssl\b|\bcertificate\b|\bproxy\b|\bstdin\b|\bstdout\b|\bstderr\b|\bexception\b|\bpanic\b/i;
const checkText = cause => [cause?.stdout, cause?.stderr, cause?.message].map(value => String(value || '')).join('\n');
function retryableAccountCheck(cause, error) {
  // Inspect the original signal first: an exec timeout can also carry explicit
  // auth output, which must never be retried merely because the child died.
  if (hasExplicitCliAuthFailure(cause) || permanentCheckPattern.test(checkText(cause))) return false;
  if (cause?.killed === true || cause?.signal || cause?.name === 'TypeError' || cause?.name === 'RangeError') return false;
  return error.code === 'NETWORK_UNAVAILABLE' && transientCheckCodes.has(cause?.code)
    || error.code === 'CLI_FAILED' && cause?.code === 1 && !cause?.syscall;
}
function waitForAccountRetry(signal) {
  return new Promise((resolve, reject) => {
    const finish = error => {clearTimeout(timer); signal.removeEventListener('abort', abort); error ? reject(error) : resolve();};
    const abort = () => finish(cliOperationError({code: 'ABORT_ERR'}, 'CHECK'));
    const timer = setTimeout(() => finish(), 250);
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
  });
}

export function privateTunnelAddress(uri) {
  const parsed = new URL(uri);
  if (parsed.protocol !== 'https:') return undefined;
  const match = parsed.hostname.match(/^([a-z0-9-]+)-(\d+)\.([a-z0-9]+)\.devtunnels\.ms$/i);
  if (!match) return undefined;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) throw new Error('Invalid dev tunnel port');
  return {tunnel: `${match[1]}.${match[3]}`, port};
}

export async function resolveCliTunnel(command, endpoint, run = promisify(execFile), {timeout = 12000, signal} = {}) {
  if (!endpoint.tunnel) throw new Error('Private endpoint is missing its VS Code tunnel label');
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000) throw new Error('Invalid metadata lookup budget');
  const deadline = Date.now() + timeout;
  const options = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Private tunnel metadata lookup exceeded its total budget');
    return {encoding: 'utf8', timeout: remaining, signal, windowsHide: true, maxBuffer: 128 * 1024};
  };
  const execute = async args => {try {return await run(command, args, options());} catch(cause) {throw cliOperationError(cause, 'METADATA');}};
  const listing = JSON.parse((await execute(['list', '--labels', endpoint.tunnel, '--limit', '20', '--json'])).stdout);
  const hostname = new URL(endpoint.uri).hostname;
  for (const candidate of listing.tunnels || []) {
    if (!/^[a-z0-9][a-z0-9-]*\.[a-z0-9]+$/i.test(candidate.tunnelId || '')) continue;
    const detail = JSON.parse((await execute(['show', candidate.tunnelId, '--json'])).stdout);
    if ((detail.tunnel?.ports || []).some(port => {
      try {return new URL(port.portUri).hostname === hostname;} catch {return false;}
    })) return candidate.tunnelId;
  }
  throw new Error('The logged-in account could not match the private web endpoint to its VS Code tunnel');
}

export function defaultDevTunnelExecutable({environment = process.env, platform = process.platform, home = os.homedir(), root = stateRoot(), exists = existsSync} = {}) {
  const executable = platform === 'win32' ? 'devtunnel.exe' : 'devtunnel';
  const cached = path.join(root, 'bin', executable);
  const shared = path.join(home, '.tunnelterm', 'bin', executable);
  return environment.TUNNELTERM_DEVTUNNEL || (exists(shared) ? shared : exists(cached) ? cached : 'devtunnel');
}

export function createDevTunnelGateway({command, launch = spawn, authorize, lookup = resolveCliTunnel, run = promisify(execFile), metadataTimeout = 30000, log = () => {}} = {}) {
  if (!Number.isInteger(metadataTimeout) || metadataTimeout < 1 || metadataTimeout > 30000) throw new Error('Invalid metadata lookup budget');
  command ??= defaultDevTunnelExecutable();
  const controller = new AbortController();
  authorize ??= async ({deadline}) => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (controller.signal.aborted) throw cliOperationError({code: 'ABORT_ERR'}, 'CHECK');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw cliOperationError({code: 'ETIMEDOUT'}, 'CHECK');
      let status;
      try {
        status = await run(command, ['user', 'show'], {encoding: 'utf8', timeout: Math.min(5000, remaining), signal: controller.signal, windowsHide: true});
      } catch (cause) {
        if (controller.signal.aborted) throw cliOperationError({code: 'ABORT_ERR'}, 'CHECK');
        const error = cliOperationError(cause, 'CHECK');
        if (attempt === 2 || !retryableAccountCheck(cause, error) || deadline - Date.now() <= 250) throw error;
        // A fixed message only; raw CLI text, argv and account data stay local.
        try {log('Official CLI account check retry 2 of 2');} catch {}
        await waitForAccountRetry(controller.signal);
        continue;
      }
      if (controller.signal.aborted) throw cliOperationError({code: 'ABORT_ERR'}, 'CHECK');
      if (hasExplicitCliAuthFailure(status)) throw cliOperationError({message: 'Login required'}, 'CHECK');
      if (Date.now() >= deadline) throw cliOperationError({code: 'ETIMEDOUT'}, 'CHECK');
      return;
    }
  };
  const clients = new Map();
  let closing = false;

  function createClient(tunnel, endpoint, deadline) {
    const client = {ports: new Map(), failure: undefined, child: undefined};
    client.starting = (async () => {
      await authorize({deadline});
      if (closing) throw new Error('SSH gateway is stopping');
      if (Date.now() >= deadline) throw cliOperationError({code: 'ETIMEDOUT'}, 'CHECK');
      // A web-forwarding DNS alias is not necessarily a CLI Tunnel ID. Resolve
      // only the selected VS Code label and verify its exact port URI using
      // official read-only metadata, rather than guessing or hard-coding IDs.
      // The forward owns a 30-second absolute warm deadline and closes this
      // gateway on expiry. Do not impose a shorter list+show sub-deadline that
      // rejects otherwise valid discovery; close aborts both owned CLI calls.
      const cliTunnel = await lookup(command, endpoint, run, {timeout: metadataTimeout, signal: controller.signal});
      if (closing) throw new Error('SSH gateway is stopping');
      const child = launch(command, ['connect', cliTunnel], {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
      client.child = child;
      const decoder = new StringDecoder('utf8');
      let pending = '';
      child.stdout.on('data', data => {
        pending += decoder.write(data);
        const lines = pending.split(/\r?\n/);
        pending = lines.pop().slice(-4096);
        for (const line of lines) {
          // Inspect only the public forwarding summary. Never export CLI login
          // credentials or access tokens into the model or bridge protocol.
          const match = line.match(/Forwarding from 127\.0\.0\.1:(\d+)\s+to host port\s+(\d+)/);
          if (match) client.ports.set(Number(match[2]), Number(match[1]));
        }
      });
      child.stderr.on('data', data => {
        if (/not logged in|unauthori[sz]ed|authentication failed|403|401/i.test(data.toString())) {
          client.failure = new Error('Official devtunnel client cannot authorize this private tunnel. Sign in with its owner account.');
          client.failure.code = 'AUTH_REQUIRED';
        }
      });
      child.on('error', () => {
        client.failure = new Error('Official devtunnel client failed to start');
        if (clients.get(tunnel) === client) clients.delete(tunnel);
      });
      child.on('close', code => {
        client.ports.clear();
        client.failure ??= new Error(`Official devtunnel connection ended (status ${code}); retry after the private tunnel is available`);
        if (clients.get(tunnel) === client) clients.delete(tunnel);
      });
      log('Official devtunnel client started for the selected private tunnel');
    })().catch(error => {
      client.failure = error;
      if (clients.get(tunnel) === client) clients.delete(tunnel);
    });
    clients.set(tunnel, client);
    return client;
  }

  async function resolve(endpoint, timeout = 2500) {
    const address = privateTunnelAddress(endpoint.uri);
    if (!address) return endpoint;
    if (closing) throw new Error('SSH gateway is stopping');
    const deadline = Date.now() + timeout;
    // A shared in-flight client keeps its first caller's budget; another resolve
    // cannot extend its preflight or buy an extra retry.
    const client = clients.get(address.tunnel) || createClient(address.tunnel, endpoint, deadline);
    while (Date.now() < deadline) {
      if (client.failure) throw client.failure;
      const localPort = client.ports.get(address.port);
      if (localPort) {
        const uri = new URL(endpoint.uri);
        uri.protocol = 'http:';
        uri.hostname = '127.0.0.1';
        uri.port = String(localPort);
        return {...endpoint, uri: uri.toString()};
      }
      await new Promise(done => setTimeout(done, 25));
    }
    throw new Error('Official devtunnel client did not establish the selected loopback port before its deadline');
  }

  return {resolve, close: async () => {
    closing = true;
    controller.abort();
    // An opaque injected lookup may never settle; cleanup must not wait on it.
    // The continuation checks `closing` before it can start a late child.
    for (const client of clients.values()) {
      if (client.child && client.child.exitCode === null) client.child.kill();
    }
    clients.clear();
  }};
}
