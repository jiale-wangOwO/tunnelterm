import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const args = process.argv.slice(2);
const remote = args.includes('--remote');
const targetIndex = args.indexOf('--target');
const target = targetIndex >= 0 ? args[targetIndex + 1] : undefined;
if (targetIndex >= 0 && !target) throw new Error('--target requires a value');
const transport = new StdioClientTransport({command: process.execPath,
  args: [fileURLToPath(new URL('../bin/tunnelterm-mcp.mjs', import.meta.url))], stderr: 'inherit'});
const client = new Client({name: 'tunnelterm-smoke', version: '1.0'});
const value = result => {
  if (result.isError) throw new Error(result.content[0].text);
  return result.structuredContent || JSON.parse(result.content[0].text);
};
let sessionId;
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 11);
  const discovery = value(await client.callTool({name: 'list_connections', arguments: {}}));
  console.log(`MCP initialized; 11 tools; ${discovery.connections.length} active connections.`);
  if (remote) {
    const exec = value(await client.callTool({name: 'exec', arguments: {
      target, command: "printf 'tunnelterm-mcp-ok\\n'; printf 'tunnelterm-mcp-stderr\\n' >&2; exit 7", timeout_seconds: 10,
    }}));
    assert.equal(exec.exit_code, 7);
    assert.equal(exec.stdout.trim(), 'tunnelterm-mcp-ok');
    assert.equal(exec.stderr.trim(), 'tunnelterm-mcp-stderr');
    console.log('Remote exec passed: separate streams and exit code 7.');
    const session = value(await client.callTool({name: 'session_start', arguments: {target}}));
    sessionId = session.session_id;
    const readUntil = async marker => {
      const deadline = Date.now() + 15_000;
      let output = '';
      while (Date.now() < deadline) {
        const response = value(await client.callTool({name: 'session_poll', arguments: {session_id: sessionId}}));
        output += response.output;
        if (output.includes(marker)) return;
        if (response.done) throw new Error('PTY exited before expected output');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('PTY smoke test exceeded its deadline');
    };
    await client.callTool({name: 'session_send', arguments: {session_id: sessionId,
      input: "export TUNNELTERM_MCP_SMOKE=ready; printf '%s-%s\\n' 'mcp' \"$TUNNELTERM_MCP_SMOKE\"\n"}}).then(value);
    await readUntil('mcp-ready');
    await client.callTool({name: 'session_send', arguments: {session_id: sessionId,
      input: "printf '%s-%s\\n' 'persistent' \"$TUNNELTERM_MCP_SMOKE\"\n"}}).then(value);
    await readUntil('persistent-ready');
    console.log('Remote PTY passed: state persists across separate tool calls.');
  }
} finally {
  if (sessionId) await client.callTool({name: 'session_close', arguments: {session_id: sessionId}}).catch(() => {});
  await client.close();
}
