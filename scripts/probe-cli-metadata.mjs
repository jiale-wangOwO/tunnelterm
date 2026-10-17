// Read-only official CLI probe. Verbose text stays private in memory; output is
// restricted to fixed stage flags and public service hostnames, never headers.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {defaultDevTunnelExecutable} from '../src/devtunnel-client.mjs';
const label = process.argv[2];
if (!/^[a-zA-Z0-9_-]{1,128}$/.test(label || '')) throw new Error('Usage: probe-cli-metadata.mjs TUNNEL_LABEL');
const began = Date.now();
let output = '', error, ok = false, shape;
try {
  const result = await promisify(execFile)(defaultDevTunnelExecutable(), ['list', '--labels', label, '--limit', '20', '--json', ...(process.argv.includes('--verbose') ? ['--verbose'] : [])],
    {timeout: 12000, windowsHide: true, maxBuffer: 128 * 1024, encoding: 'utf8'});
  output = result.stdout + result.stderr; ok = true;
  try {
    const listing = JSON.parse(result.stdout);
    shape = {top_fields: Object.keys(listing), candidates: (listing.tunnels || []).map(item => ({fields: Object.keys(item),
      ports: (item.ports || []).map(port => ({fields: Object.keys(port), has_port_uri: typeof port.portUri === 'string'})),
      endpoints: (item.endpoints || []).map(value => ({fields: Object.keys(value)}))}))};
  } catch {}
} catch (cause) {error = cause; output = String(cause.stdout || '') + String(cause.stderr || '');}
const hosts = new Set();
for (const value of output.matchAll(/https?:\/\/[^\s"<>]+/gi)) {
  try {
    const host = new URL(value[0]).hostname;
    if (/^(?:[a-z0-9-]+\.)*(?:github\.com|visualstudio\.com|devtunnels\.ms)$/i.test(host)) hosts.add(host);
  } catch {}
}
console.log(JSON.stringify({ok, shape, elapsed_ms: Date.now() - began, timeout: !!error?.killed, exit_code: Number.isInteger(error?.code) ? error.code : null,
  verbose_bytes: Buffer.byteLength(output), hosts: [...hosts],
  auth_required: /login required|not logged in|unauthori[sz]ed|\b401\b|\b403\b/i.test(output),
  proxy_error: /proxy authentication|\b407\b/i.test(output),
  tls_error: /certificate|TLS handshake|SSL connection/i.test(output),
  retry_observed: /retry|retrying/i.test(output),
  request_observed: /HTTP|request|GET\s/i.test(output),
  response_observed: /response|status code/i.test(output)}));
