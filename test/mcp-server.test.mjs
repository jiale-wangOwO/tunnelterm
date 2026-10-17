import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMcpServer} from '../src/mcp-server.mjs';

const bridge = {instance: 'test-instance', tunnel: 'my-server', workspace: 'vscode-remote://tunnel+my-server/home/test/project', defaultCwd: '/home/test/project', active: true, ready: true, token: 'private-token', directory: '/private/state', allowedRoots: ['/home/test/project']};
async function harness(t, options = {}) {
  const {server, cleanup} = await createMcpServer({discover: async () => [bridge], defaultTarget: undefined, ...options});
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({name: 'tunnelterm-test', version: '1.0'});
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {await cleanup(); await client.close(); await server.close();});
  return client;
}
const value = response => response.structuredContent || JSON.parse(response.content[0].text);

test('MCP discovery publishes all tools, excludes tokens and rejects ambiguous connections', async t => {
  const client = await harness(t, {discover: async () => [bridge, {...bridge, instance: 'second', tunnel: 'other'}]});
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 11);
  assert.ok(tools.tools.every(tool => tool.description && tool.inputSchema));
  const connections = await client.callTool({name: 'list_connections', arguments: {}});
  assert.equal(value(connections).connections.length, 2);
  assert.doesNotMatch(JSON.stringify(connections), /private-token|private\/state/);
  const ambiguous = await client.callTool({name: 'exec', arguments: {command: 'pwd'}});
  assert.equal(ambiguous.isError, true);
  assert.match(value(ambiguous).error, /More than one/);
});

test('MCP lists fresh local bridges separately from remote readiness and returns safe cached status', async t => {
  let requests = 0;
  const offline = {...bridge, active: false, ready: false, updated: new Date().toISOString(),
    bridge_alive: true, remote_ready: false, provider_state: 'unavailable', health_code: 'PROVIDER_UNAVAILABLE',
    next_action: 'reconnect_remote_workspace', error: 'PRIVATE_ERROR vscode-remote://secret?token=SECRET'};
  const client = await harness(t, {discover: async () => [offline], request: async () => {requests++; throw new Error('No remote call is allowed');}});
  const listed = value(await client.callTool({name: 'list_connections', arguments: {}})).connections;
  assert.equal(listed.length, 1); assert.equal(listed[0].bridge_alive, true); assert.equal(listed[0].ready, false);
  for (const target of [offline.instance, offline.tunnel, offline.workspace, offline.defaultCwd]) {
    const status = value(await client.callTool({name: 'connection_status', arguments: {target}}));
    assert.equal(status.status_source, 'cached_health'); assert.equal(status.health_code, 'PROVIDER_UNAVAILABLE');
    assert.equal(status.error, undefined); assert.doesNotMatch(JSON.stringify(status), /PRIVATE_ERROR|SECRET/);
  }
  const exec = await client.callTool({name: 'exec', arguments: {target: offline.instance, command: 'pwd'}});
  assert.equal(exec.isError, true); assert.equal(requests, 0);
});

test('MCP stale local heartbeats are not live bridges and cannot trigger cached status fallback', async t => {
  let requests = 0;
  const stale = {...bridge, active: false, ready: false, bridge_alive: true, updated: new Date(Date.now() - 30_000).toISOString()};
  const client = await harness(t, {discover: async () => [stale], request: async () => {requests++; return {};}});
  assert.deepEqual(value(await client.callTool({name: 'list_connections', arguments: {}})).connections, []);
  assert.equal(value(await client.callTool({name: 'list_connections', arguments: {include_stale: true}})).connections.length, 1);
  assert.equal((await client.callTool({name: 'connection_status', arguments: {target: stale.instance}})).isError, true);
  assert.equal(requests, 0);
});

test('MCP public diagnostics accept only known enums and actual booleans', async t => {
  const secret = 'PRIVATE_VALUE https://private.invalid?token=SECRET';
  const forged = {...bridge, error: secret, bridge_alive: secret, remote_ready: secret,
    ready: secret, provider_state: secret, health_code: secret, next_action: secret};
  const client = await harness(t, {discover: async () => [forged], request: async () => forged});
  const response = await client.callTool({name: 'list_connections', arguments: {}});
  assert.doesNotMatch(JSON.stringify(response), /PRIVATE_VALUE|private.invalid|SECRET/);
  const status = await client.callTool({name: 'connection_status', arguments: {target: bridge.instance}});
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE_VALUE|private.invalid|SECRET/);
  for (const field of ['error', 'bridge_alive', 'remote_ready', 'ready', 'provider_state', 'health_code', 'next_action']) {
    assert.equal(value(status)[field], undefined);
  }
});

test('MCP exec preserves shell text, separated streams, nonzero exits and output limits', async t => {
  const command = 'printf "%s" "space & $HOME"; exit 7';
  const client = await harness(t, {request: async (instance, body, timeout) => {
    assert.equal(instance.token, bridge.token);
    assert.equal(body.command, command);
    assert.equal(body.cwd, '/home/test/project');
    assert.equal(body.timeout_seconds, 5);
    assert.equal(timeout, 25_000);
    return {exit_code: 7, timed_out: false, stdout_base64: Buffer.from('x'.repeat(400)).toString('base64'), stderr_base64: Buffer.from('warning').toString('base64')};
  }});
  const response = await client.callTool({name: 'exec', arguments: {command, cwd: '/home/test/project', timeout_seconds: 5, max_output_chars: 256}});
  assert.equal(response.isError, undefined);
  assert.equal(value(response).exit_code, 7);
  assert.equal(value(response).stdout.length, 256);
  assert.equal(value(response).stdout_truncated, true);
  assert.equal(value(response).stderr, 'warning');
});

test('MCP rejects invalid arguments before issuing bridge requests', async t => {
  let calls = 0;
  const client = await harness(t, {request: async () => {calls++; return {};}});
  for (const [name, args] of [
    ['exec', {command: 'pwd', timeout_seconds: 31}],
    ['read_file', {path: 'relative'}],
    ['write_file', {path: '/home/test/project/a', content: 'bad!', encoding: 'base64'}],
    ['download_file', {remote_path: '/home/test/project/a', local_path: 'relative'}],
  ]) {
    const response = await client.callTool({name, arguments: args});
    assert.equal(response.isError, true);
  }
  assert.equal(calls, 0);
});

test('MCP transfers preserve binary bytes and downloads refuse accidental overwrite', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tunnelterm-mcp-files-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const data = Buffer.from([0, 255, 128, 65, 13, 10, 0]);
  const local = path.join(root, 'binary');
  const download = path.join(root, 'nested', 'binary');
  await fs.writeFile(local, data);
  const files = new Map();
  const client = await harness(t, {request: async (_instance, body) => {
    if (body.op === 'write') {files.set(body.path, Buffer.from(body.data_base64, 'base64')); return {bytes: data.length};}
    return {data_base64: files.get(body.path).toString('base64')};
  }});
  const remote = '/home/test/project/binary';
  await client.callTool({name: 'upload_file', arguments: {local_path: local, remote_path: remote}});
  assert.deepEqual(files.get(remote), data);
  const read = await client.callTool({name: 'read_file', arguments: {path: remote, encoding: 'base64', offset_bytes: 1, length_bytes: 2}});
  assert.deepEqual(Buffer.from(value(read).content, 'base64'), data.subarray(1, 3));
  assert.equal(value(read).truncated, true);
  await client.callTool({name: 'download_file', arguments: {remote_path: remote, local_path: download}});
  assert.deepEqual(await fs.readFile(download), data);
  const overwrite = await client.callTool({name: 'download_file', arguments: {remote_path: remote, local_path: download}});
  assert.equal(overwrite.isError, true);
  assert.deepEqual(await fs.readFile(download), data);
});

test('MCP owns sessions, retains clipped PTY output and cleans up on disconnect', async t => {
  const calls = [];
  const client = await harness(t, {request: async (_instance, body) => {
    calls.push(body);
    if (body.op === 'session.start') return {session_id: 'owned', cwd: bridge.defaultCwd};
    if (body.op === 'session.poll') return {data_base64: Buffer.from('y'.repeat(600)).toString('base64'), done: true, state: {state: 'exited', exit_code: 0}};
    return {accepted: 1};
  }});
  const foreignSession = await client.callTool({name: 'session_send', arguments: {session_id: 'not-owned', input: 'exit\n'}});
  assert.equal(foreignSession.isError, true);
  assert.equal(calls.length, 0);
  await client.callTool({name: 'session_start', arguments: {}});
  const first = value(await client.callTool({name: 'session_poll', arguments: {session_id: 'owned', max_output_chars: 256}}));
  assert.equal(first.output.length, 256);
  assert.equal(first.done, false);
  const second = value(await client.callTool({name: 'session_poll', arguments: {session_id: 'owned', max_output_chars: 256}}));
  const last = value(await client.callTool({name: 'session_poll', arguments: {session_id: 'owned', max_output_chars: 256}}));
  assert.equal(last.done, true);
  assert.equal((first.output + second.output + last.output).length, 600);
  assert.equal(calls.filter(call => call.op === 'session.poll').length, 1);
  await client.callTool({name: 'session_start', arguments: {}});
  // harness teardown must close this still-running session.
  t.after(() => assert.equal(calls.filter(call => call.op === 'session.close').length, 1));
});

test('stdio MCP initializes and lists connections without stdout noise or a VS Code instance', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tunnelterm-mcp-stdio-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const transport = new StdioClientTransport({command: process.execPath,
    args: [fileURLToPath(new URL('../bin/tunnelterm.mjs', import.meta.url)), 'mcp'],
    env: {...process.env, TUNNELTERM_HOME: root}, stderr: 'pipe'});
  const client = new Client({name: 'stdio-test', version: '1.0'});
  t.after(() => client.close());
  await client.connect(transport);
  const connections = await client.callTool({name: 'list_connections', arguments: {}});
  assert.deepEqual(value(connections), {connections: []});
  assert.equal((await client.listTools()).tools.length, 11);
});

test('MCP PTY preserves multibyte UTF-8 across remote packet boundaries', async t => {
  const data = Buffer.from('中文😀');
  const chunks = [data.subarray(0, 1), data.subarray(1, 7), data.subarray(7)];
  const client = await harness(t, {request: async (_instance, body) => {
    if (body.op === 'session.start') return {session_id: 'unicode'};
    if (body.op === 'session.poll') return {data_base64: chunks.shift().toString('base64'), done: chunks.length === 0};
    return {};
  }});
  await client.callTool({name: 'session_start', arguments: {}});
  let text = '';
  for (let i = 0; i < 3; i++) {
    text += value(await client.callTool({name: 'session_poll', arguments: {session_id: 'unicode'}})).output;
  }
  assert.equal(text, '中文😀');
});
