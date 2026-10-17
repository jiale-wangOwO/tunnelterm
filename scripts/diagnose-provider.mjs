// Bounded, non-business probes. Never emit endpoint URIs or capability tokens.
import {listInstances, selectInstance, sendRequest, stateRoot, takeOption} from '../src/client-core.mjs';
import {classifyStreamFailure, safeStartupFailureFields} from '../src/stream-errors.mjs';
import {createDevTunnelGateway, resolveCliTunnel} from '../src/devtunnel-client.mjs';
import WebSocket from 'ws';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const args = process.argv.slice(2);
const profile = takeOption(args, '--profile');
const target = args.shift();
if (!target || args.length || (profile !== undefined && !/^[a-zA-Z0-9_-]{1,48}$/.test(profile))) throw new Error('Usage: diagnose-provider.mjs WORKSPACE [--profile NAME]');
const instance = selectInstance(await listInstances(), target);
const began = Date.now();
let descriptor;
try {
  const endpoint = await sendRequest(instance, {op: 'tcp.stream.endpoint'}, 5000);
  descriptor = {...endpoint, tunnel: instance.tunnel};
  const uri = new URL(endpoint.uri);
  let sameBroker = false, sameCapability = false;
  try {
    if (!profile) throw new Error('No profile selected for route comparison');
    const directory = process.env.TUNNELTERM_SERVICE_HOME ? path.resolve(process.env.TUNNELTERM_SERVICE_HOME) :
      process.platform === 'win32' && !process.env.TUNNELTERM_HOME ? path.join(os.homedir(), '.tunnelterm', 'services') : path.join(stateRoot(), 'services');
    const stored = JSON.parse(await fs.readFile(path.join(directory, `${profile}.route.json`), 'utf8'));
    if (stored.seed?.workspace !== instance.workspace) throw new Error('Route belongs to another workspace');
    sameBroker = stored.seed?.endpoint?.generation === endpoint.generation;
    sameCapability = stored.seed?.endpoint?.token === endpoint.token;
  } catch {}
  console.log(JSON.stringify({probe: 'descriptor_shape', protocol: uri.protocol, loopback: ['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname), port: Number(uri.port), same_broker_as_last_ready: sameBroker, same_capability_as_last_ready: sameCapability}));
  console.log(JSON.stringify({probe: 'endpoint_control', ok: endpoint.protocol === 1 && typeof endpoint.uri === 'string' && typeof endpoint.token === 'string', elapsed_ms: Date.now() - began}));
} catch (error) {
  console.log(JSON.stringify({probe: 'endpoint_control', ok: false, elapsed_ms: Date.now() - began, code: classifyStreamFailure(error), ...safeStartupFailureFields(error)}));
}
if (descriptor) {
  const gateway = createDevTunnelGateway({lookup: async (...args) => {
    const began = Date.now();
    try {return await resolveCliTunnel(...args);}
    catch (error) {
      console.log(JSON.stringify({probe: 'official_metadata_failure', elapsed_ms: Date.now() - began,
        code: classifyStreamFailure(error), ...safeStartupFailureFields(error)}));
      throw error;
    }
  }});
  const start = Date.now();
  try {
    const endpoint = await gateway.resolve(descriptor, 30000);
    console.log(JSON.stringify({probe: 'official_private_mapping', ok: true, elapsed_ms: Date.now() - start}));
    const uri = new URL(endpoint.uri); uri.protocol = uri.protocol === 'https:' ? 'wss:' : 'ws:';
    const stages = {upgraded: false, broker_open: false, ssh_banner: false};
    await new Promise(resolve => {
      const ws = new WebSocket(uri, {headers: {'x-tunnelterm-token': endpoint.token}, handshakeTimeout: 4000, perMessageDeflate: false});
      const deadline = setTimeout(() => {ws.terminate(); resolve();}, 6000);
      ws.once('open', () => {stages.upgraded = true;});
      ws.on('message', packet => {
        if (packet[0] === 2) stages.broker_open = true;
        if (packet[0] === 0 && packet.subarray(1).toString().startsWith('SSH-2.0-')) {stages.ssh_banner = true; ws.close();}
      });
      ws.on('error', () => {});
      ws.once('close', () => {clearTimeout(deadline); resolve();});
    });
    console.log(JSON.stringify({probe: 'authenticated_stream', ...stages}));
  } catch (error) {
    console.log(JSON.stringify({probe: 'official_private_mapping', ok: false, elapsed_ms: Date.now() - start,
      code: classifyStreamFailure(error), ...safeStartupFailureFields(error)}));
  } finally {await gateway.close();}
}
const control = Date.now();
try {
  const result = await sendRequest(instance, {op: 'exec', command: 'printf TUNNELTERM_READONLY_DIAGNOSTIC', timeout_seconds: 2}, 12000);
  console.log(JSON.stringify({probe: 'remote_exec', ok: result.exit_code === 0 && Buffer.from(result.stdout_base64 || '', 'base64').toString() === 'TUNNELTERM_READONLY_DIAGNOSTIC', elapsed_ms: Date.now() - control}));
} catch {console.log(JSON.stringify({probe: 'remote_exec', ok: false, elapsed_ms: Date.now() - control, reason: 'Control response unavailable within budget'}));}
