import WebSocket from 'ws';
import {listInstances, selectInstance, sendRequest} from '../src/client-core.mjs';

const target = process.argv[2];
if (!target) throw new Error('Usage: node scripts/probe-stream.mjs WORKSPACE_TARGET');
const instance = selectInstance(await listInstances(), target);
const endpoint = await sendRequest(instance, {op: 'tcp.stream.endpoint'}, 5000);
const uri = new URL(endpoint.uri);
console.log(JSON.stringify({endpoint_scheme: uri.protocol, endpoint_host: uri.hostname, has_query: !!uri.search}));
uri.protocol = uri.protocol === 'https:' ? 'wss:' : 'ws:';
await new Promise(resolve => {
  const ws = new WebSocket(uri, {headers: {'x-tunnelterm-token': endpoint.token}, handshakeTimeout: 5000, perMessageDeflate: false});
  const timer = setTimeout(() => {console.log(JSON.stringify({probe: 'timeout'})); ws.terminate();}, 6000);
  ws.on('open', () => console.log(JSON.stringify({websocket_open: true})));
  ws.on('message', data => {console.log(JSON.stringify({message_type: data[0], packet_bytes: data.length})); ws.terminate();});
  ws.on('unexpected-response', (_request, response) => {
    let redirectHost;
    try {redirectHost = new URL(response.headers.location).hostname;} catch {}
    console.log(JSON.stringify({http_status: response.statusCode, redirect_host: redirectHost,
      has_auth_challenge: !!response.headers['www-authenticate']}));
    response.resume();
    ws.terminate();
  });
  ws.on('error', error => console.log(JSON.stringify({error_code: error.code,
    error_kind: /certificate/i.test(error.message) ? 'certificate' : /Unexpected server response/.test(error.message) ? 'http' : error.name})));
  ws.on('close', () => {clearTimeout(timer); resolve();});
});
