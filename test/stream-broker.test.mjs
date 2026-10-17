import assert from 'node:assert/strict';
import net from 'node:net';
import {once} from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import {startBroker} from '../remote-stream/broker.cjs';

test('default broker uses an owned ephemeral loopback port and close is idempotent', {timeout: 2000}, async () => {
  const broker = await startBroker();
  try {
    assert.ok(Number.isInteger(broker.port) && broker.port > 0 && broker.port <= 65535);
    assert.match(broker.token, /^[a-f0-9]{64}$/);
    assert.match(broker.generation, /^[a-f0-9-]{36}$/);
  } finally {await Promise.all([broker.close(), broker.close()]);}
});

test('owned broker restart rebinds the exact port with fresh authentication and generation', {timeout: 3000}, async () => {
  const first = await startBroker();
  const port = first.port, token = first.token, generation = first.generation;
  await first.close();
  const next = await startBroker({listenPort: port});
  try {
    assert.equal(next.port, port);
    assert.notEqual(next.token, token);
    assert.notEqual(next.generation, generation);
  } finally {await next.close();}
});

test('invalid listen hints fail before creating a listener', async () => {
  for (const listenPort of [-1, 65536, 1.5, '12345', null, NaN, Infinity, {}]) {
    await assert.rejects(startBroker({listenPort}), /listenPort must be an integer from 0 to 65535/);
  }
});

test('EADDRINUSE preserves the other owned test listener and never falls back to a random port', {timeout: 3000}, async t => {
  let accepts = 0;
  const other = net.createServer(socket => {accepts++; socket.end('other-owned-test-listener');});
  other.listen(0, '127.0.0.1'); await once(other, 'listening');
  t.after(() => new Promise(resolve => other.close(resolve)));
  const port = other.address().port;
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(startBroker({listenPort: port}), error => error.code === 'EADDRINUSE');
    assert.equal(other.listening, true);
    assert.equal(other.address().port, port);
  }
  const socket = net.createConnection({host: '127.0.0.1', port});
  const chunks = [];
  socket.on('data', bytes => chunks.push(bytes));
  await once(socket, 'close');
  assert.equal(Buffer.concat(chunks).toString(), 'other-owned-test-listener');
  assert.equal(accepts, 1);
});

test('a token from the previous broker generation cannot authenticate after exact-port reuse', {timeout: 3000}, async t => {
  let destinations = 0;
  const destination = net.createServer(socket => {destinations++; socket.destroy();});
  destination.listen(0, '127.0.0.1'); await once(destination, 'listening');
  t.after(() => new Promise(resolve => destination.close(resolve)));
  const first = await startBroker({destinationPort: destination.address().port});
  const port = first.port, oldToken = first.token;
  await first.close();
  const next = await startBroker({destinationPort: destination.address().port, listenPort: port});
  t.after(() => next.close());
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ssh`, {headers: {'x-tunnelterm-token': oldToken}});
  ws.on('error', () => {});
  const [error] = await once(ws, 'error');
  assert.match(error.message, /403/);
  assert.equal(destinations, 0);
});
