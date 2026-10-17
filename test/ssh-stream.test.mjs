import assert from 'node:assert/strict';
import net from 'node:net';
import {randomBytes, createHash} from 'node:crypto';
import {once} from 'node:events';
import {PassThrough, Readable} from 'node:stream';
import {spawn} from 'node:child_process';
import test from 'node:test';
import WebSocket, {WebSocketServer} from 'ws';
import {startBroker} from '../remote-stream/broker.cjs';
import {relayStream, startStreamForward} from '../src/ssh-stream.mjs';
import {probeSshBanner, startManagedService} from '../src/managed-service.mjs';

async function setup(t, handler) {
  const destination = net.createServer({allowHalfOpen: true}, handler);
  const sockets = new Set();
  destination.on('connection', s => {sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s));});
  destination.listen(0, '127.0.0.1');
  await once(destination, 'listening');
  const broker = await startBroker({destinationPort: destination.address().port});
  const endpoint = {protocol: 1, uri: `http://127.0.0.1:${broker.port}/ssh`, token: broker.token, generation: broker.generation};
  const instance = {instance: 'test', runtimeGeneration: 'test-ui-generation', active: true, workspace: 'vscode-remote://tunnel+test/home/test/project', capabilities: {ssh_stream: 1}};
  const forward = await startStreamForward({port: 0, discover: async () => [instance], request: async () => endpoint});
  t.after(async () => {await forward.close(); await broker.close(); for (const s of sockets) s.destroy(); await new Promise(resolve => destination.close(resolve));});
  return {forward, broker, endpoint, instance};
}
function connect(port) {
  const socket = net.createConnection({host: '127.0.0.1', port});
  socket.on('error', () => {});
  return socket;
}
async function collect(socket) {
  const chunks = [];
  socket.on('data', data => chunks.push(data));
  await once(socket, 'end');
  return Buffer.concat(chunks);
}
const hash = buffer => createHash('sha256').update(buffer).digest('hex');

async function controlCarrier(t, {autoPong = true} = {}) {
  const carrier = new WebSocketServer({host: '127.0.0.1', port: 0, autoPong});
  await once(carrier, 'listening');
  t.after(async () => {
    for (const ws of carrier.clients) ws.terminate();
    await new Promise(resolve => carrier.close(resolve));
  });
  return {carrier, endpoint: {uri: `http://127.0.0.1:${carrier.address().port}/ssh`, token: 'test'}};
}

function observeIntervals(t) {
  const active = new Set();
  const create = globalThis.setInterval, clear = globalThis.clearInterval;
  t.mock.method(globalThis, 'setInterval', (...args) => {
    const interval = create(...args); active.add(interval); return interval;
  });
  t.mock.method(globalThis, 'clearInterval', interval => {active.delete(interval); clear(interval);});
  return active;
}

test('heartbeat uses control frames only, preserves SSH bytes and clears its timer after EOF', {timeout: 3000}, async t => {
  const {carrier, endpoint} = await controlCarrier(t);
  const intervals = observeIntervals(t);
  let pings = 0, heartbeatReady;
  const messages = [], heartbeat = new Promise(resolve => {heartbeatReady = resolve;});
  carrier.on('connection', ws => {
    ws.send(Buffer.from([2]));
    ws.on('ping', () => {if (++pings === 3) heartbeatReady();});
    ws.on('message', packet => {
      messages.push(Buffer.from(packet));
      if (packet[0] === 0) ws.send(packet);
      else if (packet[0] === 1) {ws.send(Buffer.from([1])); ws.close(1000);}
    });
  });
  const input = new PassThrough(), output = new PassThrough();
  const received = collect(output), states = [];
  const relayed = relayStream(endpoint, input, output, {heartbeatInterval: 20, onState: state => states.push(state)});
  input.write('SSH bytes, not a heartbeat');
  await heartbeat;
  assert.equal(intervals.size, 1);
  input.end();
  await relayed;
  assert.equal((await received).toString(), 'SSH bytes, not a heartbeat');
  assert.deepEqual(messages.map(packet => packet[0]), [0, 1]);
  assert.equal(states[0].sent_bytes, Buffer.byteLength('SSH bytes, not a heartbeat'));
  assert.equal(states[0].received_bytes, Buffer.byteLength('SSH bytes, not a heartbeat'));
  assert.equal(states[0].failed, false);
  assert.equal(intervals.size, 0);
});

test('missing pong never kills a quiet connected stream or injects SSH input', {timeout: 3000}, async t => {
  const {carrier, endpoint} = await controlCarrier(t, {autoPong: false});
  const intervals = observeIntervals(t);
  let pings = 0, heartbeatReady, remote;
  const heartbeat = new Promise(resolve => {heartbeatReady = resolve;});
  const messages = [];
  carrier.on('connection', ws => {
    remote = ws; ws.send(Buffer.from([2]));
    ws.on('ping', () => {if (++pings === 4) heartbeatReady();});
    ws.on('message', packet => {
      messages.push(Buffer.from(packet));
      if (packet[0] === 1) {ws.send(Buffer.from([1])); ws.close(1000);}
    });
  });
  const input = new PassThrough(), output = new PassThrough(); output.resume();
  let settled = false;
  const relayed = relayStream(endpoint, input, output, {heartbeatInterval: 20});
  void relayed.then(() => {settled = true;}, () => {settled = true;});
  await heartbeat;
  assert.equal(settled, false);
  assert.equal(remote.readyState, WebSocket.OPEN);
  assert.deepEqual(messages, []);
  input.end(); await relayed;
  assert.equal(intervals.size, 0);
});

test('heartbeat can be disabled and only accepts safe timer intervals', {timeout: 3000}, async t => {
  const {carrier, endpoint} = await controlCarrier(t);
  const intervals = observeIntervals(t);
  let pings = 0, connected;
  const ready = new Promise(resolve => {connected = resolve;});
  carrier.on('connection', ws => {
    ws.send(Buffer.from([2])); ws.on('ping', () => pings++);
    ws.on('message', packet => {if (packet[0] === 1) {ws.send(Buffer.from([1])); ws.close(1000);}});
  });
  const input = new PassThrough(), output = new PassThrough(); output.resume();
  const relayed = relayStream(endpoint, input, output, {heartbeatInterval: 0, onConnected: connected});
  await ready; await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(pings, 0); assert.equal(intervals.size, 0);
  input.end(); await relayed;
  for (const heartbeatInterval of [-1, 0.1, NaN, Infinity, '20', 2147483648]) {
    assert.throws(() => relayStream(endpoint, new PassThrough(), new PassThrough(), {heartbeatInterval}), /heartbeatInterval/);
  }
});

test('heartbeat send failure ends only its owned relay and clears the timer', {timeout: 3000}, async t => {
  const {carrier, endpoint} = await controlCarrier(t);
  const intervals = observeIntervals(t);
  carrier.on('connection', ws => {ws.on('error', () => {}); ws.send(Buffer.from([2]));});
  let attempts = 0;
  t.mock.method(WebSocket.prototype, 'ping', (...args) => {
    attempts++; args.at(-1)(new Error('private carrier detail'));
  });
  const states = [];
  await assert.rejects(relayStream(endpoint, new PassThrough(), new PassThrough(), {
    heartbeatInterval: 20, onState: state => states.push(state),
  }), error => /heartbeat send failed/.test(error.message) && !error.message.includes('private'));
  assert.equal(attempts, 1); assert.equal(intervals.size, 0);
  assert.equal(states[0].end_reason, 'send_failed');
  assert.equal(states[0].failed, true);
  await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(attempts, 1);
});

test('abnormal WebSocket close exposes only a fixed end reason and numeric code', {timeout: 3000}, async t => {
  const {carrier, endpoint} = await controlCarrier(t);
  const intervals = observeIntervals(t);
  carrier.on('connection', ws => {ws.send(Buffer.from([2])); setTimeout(() => ws.close(4001, 'private route detail'), 60);});
  const states = [];
  await assert.rejects(relayStream(endpoint, new PassThrough(), new PassThrough(), {
    heartbeatInterval: 20, onState: state => states.push(state),
  }), /disconnected before EOF/);
  assert.equal(intervals.size, 0);
  assert.equal(states[0].end_reason, 'ws_closed'); assert.equal(states[0].ws_close_code, 4001);
  assert.ok(!JSON.stringify(states).includes('private route detail'));
});

test('failed compatible startup seed cold-resolves once within the same warm budget', {timeout: 3000}, async t => {
  const instance = {active: true, instance: 'seed-test', workspace: 'seed-workspace', runtimeGeneration: 'unchanged', capabilities: {ssh_stream: 1}};
  const old = {protocol: 1, uri: 'http://127.0.0.1:1/old', token: 'old', generation: 'old'};
  const fresh = {...old, uri: 'http://127.0.0.1:2/fresh', generation: 'fresh'};
  const resolves = [], budgets = []; let requests = 0;
  const forward = await startStreamForward({port: 0, seed: {workspace: instance.workspace, identity: 'seed-test:unchanged', endpoint: old},
    discover: async () => [instance], request: async () => {requests++; return fresh;},
    gateway: {resolve: async (endpoint, budget) => {resolves.push(endpoint.generation); budgets.push(budget); if(endpoint.generation === 'old'){await new Promise(resolve => setTimeout(resolve, 25)); throw new Error('stale CLI mapping');} return endpoint;}, close: async () => {}}});
  t.after(() => forward.close());
  assert.equal(requests, 1); assert.deepEqual(resolves, ['old', 'fresh']);
  assert.ok(budgets.every(budget => budget > 0 && budget <= 30000));
  assert.ok(budgets[1] <= budgets[0] - 10);
});

test('healthy compatible seed may warm slowly without reopening a stalled native mapper', {timeout: 3500}, async t => {
  const instance = {active: true, instance: 'slow-seed', workspace: 'slow-seed', runtimeGeneration: 'same', capabilities: {ssh_stream: 1}};
  const endpoint = {protocol: 1, uri: 'http://127.0.0.1:1', token: 'owned', generation: 'same'};
  let requests = 0;
  const forward = await startStreamForward({port: 0, seed: {workspace: instance.workspace, identity: 'slow-seed:same', endpoint},
    discover: async () => [instance], request: async () => {requests++; throw new Error('native mapping is stalled');},
    gateway: {resolve: async value => {await new Promise(resolve => setTimeout(resolve, 1800)); return value;}, close: async () => {}}});
  t.after(() => forward.close()); assert.equal(requests, 0);
});

function transientInstance(instance, overrides = {}) {
  return {...instance, active: false, bridge_alive: true, trusted: true, ageMilliseconds: 100,
    health_code: 'PROVIDER_TIMEOUT', ...overrides};
}
function savedRoute(instance, endpoint) {
  return {workspace: instance.workspace, identity: `${instance.instance}:${instance.runtimeGeneration}`, endpoint};
}

test('same-generation saved SSH route survives only the two explicit transient provider codes', {timeout: 5000}, async t => {
  const {endpoint, instance} = await setup(t, socket => {
    socket.write('SSH-2.0-transient-test\r\n');
    socket.on('data', data => socket.write(data)); socket.on('end', () => socket.end());
  });
  for (const health_code of ['PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE']) {
    let requests = 0;
    const current = transientInstance(instance, {health_code});
    const forward = await startStreamForward({port: 0, target: current.workspace, seed: savedRoute(current, endpoint),
      discover: async () => [current], request: async () => {requests++; throw new Error('native mapper must not be reopened');}});
    t.after(() => forward.close());
    const socket = connect(forward.port);
    assert.match((await once(socket, 'data'))[0].toString(), /^SSH-2\.0-transient-test/);
    const output = collect(socket); socket.end('exactly-once');
    assert.equal((await output).toString(), 'exactly-once');
    assert.equal(requests, 0);
    assert.equal(forward.routeSeed().identity, savedRoute(current, endpoint).identity);
  }
});

test('filesystem timeout neither evicts a verified route nor closes existing SSH streams', {timeout: 5000}, async t => {
  const {endpoint, instance} = await setup(t, socket => {
    socket.write('SSH-2.0-held-test\r\n');
    socket.on('data', data => socket.write(data)); socket.on('end', () => socket.end());
  });
  let current = instance, requests = 0;
  const forward = await startStreamForward({port: 0, target: instance.workspace, discover: async () => [current],
    request: async () => {requests++; return endpoint;}});
  t.after(() => forward.close());
  const held = connect(forward.port); await once(held, 'data');
  current = transientInstance(instance);
  await new Promise(resolve => setTimeout(resolve, 1100)); // exercise the route monitor
  held.write('existing'); assert.equal((await once(held, 'data'))[0].toString(), 'existing');
  const fresh = connect(forward.port);
  assert.match((await once(fresh, 'data'))[0].toString(), /^SSH-2\.0-held-test/);
  const output = collect(fresh); fresh.end('fresh'); assert.equal((await output).toString(), 'fresh');
  assert.equal(requests, 1);
  assert.ok(forward.routeSeed());
  held.destroy();
});

test('cold prepared mapping without a saved seed cannot borrow inactive provider readiness before authentication', {timeout: 1000}, async t => {
  const instance = {instance: 'cold', runtimeGeneration: 'same', workspace: 'vscode-remote://tunnel+guard/home/guard', active: true, capabilities: {ssh_stream: 1}};
  let current = instance, relays = 0, requests = 0;
  const forward = await startStreamForward({port: 0, target: instance.workspace, discover: async () => [current],
    request: async () => {requests++; return {protocol: 1, uri: 'http://127.0.0.1:1/ssh', token: 'owned', generation: 'broker'};},
    relay: async () => {relays++; throw new Error('must not start');}});
  t.after(() => forward.close());
  current = transientInstance(instance);
  const socket = connect(forward.port), closed = new Promise(resolve => socket.once('close', resolve));
  socket.resume(); socket.write('not-verified'); await closed;
  assert.equal(requests, 1); assert.equal(relays, 0); assert.equal(forward.routeSeed(), undefined);
});

test('verified routes cannot bypass revocation, stale heartbeat or bridge-generation replacement', {timeout: 5000}, async t => {
  const {endpoint, instance} = await setup(t, socket => {
    socket.on('data', data => socket.write(data)); socket.on('end', () => socket.end());
  });
  let current = instance, requests = 0;
  const forward = await startStreamForward({port: 0, target: instance.workspace, discover: async () => [current],
    request: async () => {requests++; return endpoint;}});
  t.after(() => forward.close());
  const held = connect(forward.port); held.write('held'); await once(held, 'data');
  for (const overrides of [{ageMilliseconds: 20_000}, {bridge_alive: false}, {health_code: 'PERMISSION_DENIED'},
    {runtimeGeneration: 'replacement'}, {trusted: false}]) {
    current = transientInstance(instance, overrides);
    const socket = connect(forward.port), closed = new Promise(resolve => socket.once('close', resolve));
    socket.resume(); socket.write('not-authorized'); await closed;
  }
  assert.equal(requests, 1);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(forward.routeSeed(), undefined);
  held.write('preserved'); assert.equal((await once(held, 'data'))[0].toString(), 'preserved');
  held.destroy();
});

test('inactive bridge seed cannot bypass cold start, trust, freshness, identity or non-transient failures', {timeout: 3000}, async () => {
  const base = transientInstance({instance: 'guarded', runtimeGeneration: 'same', workspace: 'vscode-remote://tunnel+guard/home/guard', capabilities: {ssh_stream: 1}});
  const endpoint = {protocol: 1, uri: 'http://127.0.0.1:1/ssh', token: 'PRIVATE_ROUTE_TOKEN', generation: 'broker'};
  const seed = savedRoute(base, endpoint);
  const cases = [
    ...['PERMISSION_DENIED', 'WORKSPACE_UNAVAILABLE', 'CANCELLED', 'PROVIDER_FAILED', 'PROVIDER_CHECKING',
      'BRIDGE_IO_FAILED', 'BRIDGE_STOPPED', 'WORKSPACE_UNTRUSTED'].map(health_code => ({instance: {...base, health_code}})),
    ...[-1, 20_000, Infinity, NaN, undefined].map(ageMilliseconds => ({instance: {...base, ageMilliseconds}})),
    {instance: {...base, trusted: false}}, {instance: {...base, trusted: undefined}},
    {instance: {...base, bridge_alive: false}}, {instance: {...base, capabilities: {ssh_stream: 0}}},
    {instance: {...base, runtimeGeneration: 'replacement'}}, {instance: {...base, instance: 'replacement'}},
    {seed: undefined}, {seed: {...seed, workspace: 'another-workspace'}},
    {seed: {...seed, endpoint: {...endpoint, generation: undefined}}},
    {seed: {...seed, endpoint: {...endpoint, token: ''}}},
    {target: 'guard'}, {target: undefined},
  ];
  for (const fixture of cases) {
    let requests = 0, resolves = 0;
    await assert.rejects(startStreamForward({port: 0,
      target: Object.hasOwn(fixture, 'target') ? fixture.target : base.workspace,
      seed: Object.hasOwn(fixture, 'seed') ? fixture.seed : seed,
      discover: async () => [fixture.instance || base],
      request: async () => {requests++; return endpoint;},
      gateway: {resolve: async value => {resolves++; return value;}, close: async () => {}}}),
    error => /No active/.test(error.message) && !error.message.includes(endpoint.token));
    assert.equal(requests, 0); assert.equal(resolves, 0);
  }
});

test('a compatible seed never selects between duplicate fresh trusted workspace windows', {timeout: 1000}, async () => {
  const first = transientInstance({instance: 'one', runtimeGeneration: 'same', workspace: 'vscode-remote://tunnel+guard/home/guard', capabilities: {ssh_stream: 1}});
  const second = {...first, instance: 'two'};
  const endpoint = {protocol: 1, uri: 'http://127.0.0.1:1/ssh', token: 'owned', generation: 'broker'};
  let requests = 0;
  await assert.rejects(startStreamForward({port: 0, target: first.workspace, seed: savedRoute(first, endpoint),
    discover: async () => [first, second], request: async () => {requests++; return endpoint;}}), /multiple live bridge windows/);
  assert.equal(requests, 0);
});

test('failed inactive seed mapping is invalidated without a fresh endpoint lookup', {timeout: 1000}, async () => {
  const instance = transientInstance({instance: 'one', runtimeGeneration: 'same', workspace: 'vscode-remote://tunnel+guard/home/guard', capabilities: {ssh_stream: 1}});
  const endpoint = {protocol: 1, uri: 'http://127.0.0.1:1/ssh', token: 'owned', generation: 'broker'};
  let requests = 0, closes = 0;
  await assert.rejects(startStreamForward({port: 0, target: instance.workspace, seed: savedRoute(instance, endpoint),
    discover: async () => [instance], request: async () => {requests++; return endpoint;},
    gateway: {resolve: async () => {throw new Error('route failed before OPEN');}, close: async () => {closes++;}}}),
  error => error.seedInvalidated === true);
  assert.equal(requests, 0); assert.equal(closes, 1);
});

test('inactive route authentication failure consumes no SSH input and cannot reuse the rejected seed', {timeout: 5000}, async t => {
  let received = 0;
  const {endpoint, instance} = await setup(t, socket => {socket.on('data', data => {received += data.length;});});
  const current = transientInstance(instance);
  let requests = 0, relays = 0;
  const forward = await startStreamForward({port: 0, target: current.workspace,
    seed: savedRoute(current, {...endpoint, token: 'rejected-private-token'}), discover: async () => [current],
    request: async () => {requests++; return endpoint;}, relay: (...args) => {relays++; return relayStream(...args);}});
  t.after(() => forward.close());
  for (let index = 0; index < 2; index++) {
    const socket = connect(forward.port), closed = new Promise(resolve => socket.once('close', resolve));
    socket.resume(); socket.write('must-not-be-replayed'); await closed;
  }
  assert.equal(relays, 1); assert.equal(requests, 0); assert.equal(received, 0);
  assert.equal(forward.routeSeed(), undefined);
  assert.equal(forward.routeSeedState().seedInvalidated, true);
});

test('supervisor discards an explicitly rejected saved broker capability across recovery epochs', {timeout: 5000}, async t => {
  let inputBytes = 0;
  const {endpoint, instance} = await setup(t, socket => {
    socket.write('SSH-2.0-rejection-test\r\n'); socket.on('data', data => {inputBytes += data.length;});
  });
  const current = transientInstance(instance), writes = [];
  let starts = 0, seededStarts = 0, requests = 0, relays = 0;
  const seed = savedRoute(current, {...endpoint, token: 'rejected-private-token'});
  const service = await startManagedService({target: current.workspace, port: 0, seed, retryBase: 10, retryMax: 20,
    saveSeed: async value => {writes.push(value);},
    workerFactory: async options => {
      starts++; if (options.seed) seededStarts++;
      return startStreamForward({...options, discover: async () => [current],
        request: async () => {requests++; return endpoint;}, relay: (...args) => {relays++; return relayStream(...args);}});
    }});
  t.after(() => service.close());
  const deadline = Date.now() + 2000;
  while (starts < 3) {assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10));}
  assert.equal(seededStarts, 1); assert.equal(relays, 1); assert.equal(requests, 0); assert.equal(inputBytes, 0);
  assert.deepEqual(writes, [undefined]); assert.equal(service.status().accepting_new, false);
  assert.ok(!JSON.stringify(service.status()).includes(seed.endpoint.token));
});

test('managed service promotes an inactive-provider seed only after a fresh authenticated SSH banner', {timeout: 5000}, async t => {
  const {endpoint, instance} = await setup(t, socket => {
    socket.write('SSH-2.0-promoted-test\r\n');
    socket.on('data', data => socket.write(data)); socket.on('end', () => socket.end());
  });
  const current = transientInstance(instance);
  const service = await startManagedService({target: current.workspace, port: 0, seed: savedRoute(current, endpoint), healthInterval: 60000,
    workerFactory: async options => startStreamForward({...options, discover: async () => [current],
      request: async () => {throw new Error('cold mapping forbidden');}})});
  t.after(() => service.close());
  const deadline = Date.now() + 2000;
  while (service.status().phase !== 'ready') {assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10));}
  assert.equal(service.status().accepting_new, true); assert.ok(service.status().last_banner_ms !== null);
  assert.ok(!JSON.stringify(service.status()).includes(endpoint.token));
  const socket = connect(service.port); assert.match((await once(socket, 'data'))[0].toString(), /^SSH-2\.0-promoted-test/);
  socket.destroy();
});

test('owned endpoint and authenticated OPEN without an SSH banner never advertise ready', {timeout: 3000}, async t => {
  const {endpoint, instance} = await setup(t, socket => {socket.on('data', () => {});});
  const current = transientInstance(instance);
  const service = await startManagedService({target: current.workspace, port: 0, seed: savedRoute(current, endpoint),
    retryBase: 60000, retryMax: 60000, probe: (port, options) => probeSshBanner(port, {...options, timeout: 60}),
    workerFactory: async options => startStreamForward({...options, discover: async () => [current],
      request: async () => {throw new Error('cold mapping forbidden');}})});
  t.after(() => service.close());
  const deadline = Date.now() + 1500;
  while (service.status().phase !== 'offline') {assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10));}
  assert.equal(service.status().accepting_new, false); assert.equal(service.status().last_ready, null);
  assert.equal(service.status().backend_epochs, 0);
});

test('failure after inactive-provider OPEN never replays SSH input or refreshes the native endpoint', {timeout: 1000}, async t => {
  const instance = transientInstance({instance: 'opened', runtimeGeneration: 'same', workspace: 'vscode-remote://tunnel+guard/home/guard', capabilities: {ssh_stream: 1}});
  const endpoint = {protocol: 1, uri: 'http://127.0.0.1:1/ssh', token: 'owned', generation: 'broker'};
  let requests = 0, relays = 0;
  const forward = await startStreamForward({port: 0, target: instance.workspace, seed: savedRoute(instance, endpoint),
    discover: async () => [instance], request: async () => {requests++; return endpoint;},
    relay: async (_endpoint, _input, _output, options) => {relays++; options.onConnected(); throw new Error('failure after OPEN');}});
  t.after(() => forward.close());
  const socket = connect(forward.port), closed = new Promise(resolve => socket.once('close', resolve));
  socket.resume(); socket.write('exactly-once'); await closed;
  assert.equal(relays, 1); assert.equal(requests, 0);
});

test('cold fallback stays bounded and closes its gateway if fresh discovery never settles', {timeout: 1000}, async () => {
  const instance = {active: true, instance: 'bounded', workspace: 'bounded', runtimeGeneration: 'same', capabilities: {ssh_stream: 1}};
  let requests = 0, closes = 0;
  const began = Date.now();
  await assert.rejects(startStreamForward({port: 0, warmTimeout: 60,
    seed: {workspace: instance.workspace, identity: 'bounded:same', endpoint: {protocol: 1, uri: 'http://127.0.0.1:1', token: 'old'}},
    discover: async () => [instance], request: () => {requests++; return new Promise(() => {});},
    gateway: {resolve: async () => {throw new Error('old mapping unavailable');}, close: async () => {closes++;}}}), error => error.seedInvalidated === true && /total budget/.test(error.message));
  assert.equal(requests, 1); assert.equal(closes, 1); assert.ok(Date.now() - began < 500);
});

test('failure after OPEN never replays SSH input or reacquires an endpoint', {timeout: 3000}, async t => {
  const instance = {active: true, instance: 'opened', workspace: 'opened', runtimeGeneration: 'same', capabilities: {ssh_stream: 1}};
  const endpoint = {protocol: 1, uri: 'http://127.0.0.1:1', token: 'owned', generation: 'same'};
  let requests = 0, relays = 0;
  const forward = await startStreamForward({port: 0, discover: async () => [instance], request: async () => {requests++; return endpoint;},
    relay: async (_endpoint, _input, _output, options) => {relays++; options.onConnected(); throw new Error('owned post-OPEN failure');}});
  t.after(() => forward.close());
  const socket = connect(forward.port); socket.resume(); socket.write('must-not-replay');
  await new Promise(resolve => socket.once('close', resolve));
  assert.equal(relays, 1); assert.equal(requests, 1);
});

test('pre-OPEN gateway mapping failure evicts a verified candidate once without consuming input', {timeout: 3000}, async t => {
  const {endpoint, instance} = await setup(t, socket => {socket.on('data', data => socket.write(data)); socket.on('end', () => socket.end());});
  let failMapping = false, requests = 0, failures = 0;
  const stages = [];
  const forward = await startStreamForward({port: 0, discover: async () => [instance], request: async () => {requests++; return endpoint;},
    gateway: {resolve: async value => {if(failMapping){failMapping=false; failures++; throw new Error('CLI mapping failed before OPEN');} return value;}, close: async () => {}},
    trace: entry => stages.push(entry.stage)});
  t.after(() => forward.close());
  const held = connect(forward.port); held.write('held'); await once(held, 'data');
  failMapping = true;
  const fresh = connect(forward.port), output = collect(fresh);
  fresh.end('exactly-once');
  assert.equal((await output).toString(), 'exactly-once');
  assert.equal(failures, 1); assert.equal(requests, 2);
  assert.equal(stages.filter(stage => stage === 'mapping_candidate_evicted').length, 1);
  held.write('still-live'); assert.equal((await once(held, 'data'))[0].toString(), 'still-live');
});

test('relay diagnostic exposes only counts and lifecycle flags, not endpoint or payload', {timeout: 3000}, async t => {
  const {endpoint} = await setup(t, socket => {
    socket.on('data', data => socket.write(data)); socket.on('end', () => socket.end());
  });
  const bytes = Buffer.from('private diagnostic payload 中文');
  const input = new PassThrough(), output = new PassThrough();
  const received = collect(output), states = [];
  input.end(bytes);
  await relayStream(endpoint, input, output, {onState: state => states.push(state)});
  assert.equal(hash(await received), hash(bytes));
  assert.equal(states.length, 1);
  const {receive_idle_ms, end_reason, ws_close_code, ...state} = states[0];
  assert.ok(receive_idle_ms >= 0);
  assert.equal(end_reason, 'ws_closed');
  assert.ok(Number.isInteger(ws_close_code) && ws_close_code >= 1000 && ws_close_code <= 4999);
  assert.deepEqual(state, {upgraded: true, broker_open: true, local_fin: true, remote_fin: true,
    sent_bytes: bytes.length, received_bytes: bytes.length, failed: false, send_pending: false,
    send_wait_ms: 0, output_blocked: false, output_wait_ms: 0});
  const serialized = JSON.stringify(states);
  for (const secret of [endpoint.uri, endpoint.token, bytes.toString()]) assert.ok(!serialized.includes(secret));
});

test('a failing optional diagnostic sink cannot interrupt relay shutdown', {timeout: 3000}, async t => {
  const {endpoint} = await setup(t, socket => {
    socket.on('data', data => socket.write(data)); socket.on('end', () => socket.end());
  });
  const input = new PassThrough(), output = new PassThrough();
  const received = collect(output);
  input.end('owned-test');
  await relayStream(endpoint, input, output, {onState: () => {throw new Error('diagnostic sink unavailable');}});
  assert.equal((await received).toString(), 'owned-test');
});

test('native mapping timeout recovers authenticated new streams while two held connections remain alive', {timeout: 5000}, async t => {
  const {endpoint, instance} = await setup(t, socket => {
    socket.on('data', data => socket.write(data));
    socket.on('end', () => socket.end());
  });
  let mappingHung = false, requests = 0;
  const stages = [];
  const forward = await startStreamForward({port: 0, discover: async () => [instance], request: async () => {
    requests++;
    if (mappingHung) throw new Error('VS Code port mapping did not finish before its deadline; the same native mapping is still pending');
    return endpoint;
  }, trace: entry => stages.push(entry.stage)});
  t.after(() => forward.close());
  const held = [connect(forward.port), connect(forward.port)];
  for (const socket of held) {socket.write('held'); assert.equal((await once(socket, 'data'))[0].toString(), 'held');}
  stages.length = 0;
  mappingHung = true;
  for (let index = 0; index < 6; index++) {
    const socket = connect(forward.port);
    const output = collect(socket);
    const message = Buffer.from(`日志/EOF/${index}/中文`);
    socket.end(message);
    assert.equal(hash(await output), hash(message));
  }
  assert.equal(stages.filter(stage => stage === 'mapping_recovery_candidate').length, 6);
  assert.equal(requests, 1, 'a healthy authenticated route must not reopen the native mapping per connection');
  for (const socket of held) {assert.equal(socket.destroyed, false); socket.write('still-live'); assert.equal((await once(socket, 'data'))[0].toString(), 'still-live');}
});

test('a recovery candidate failing authentication is evicted rather than retried indefinitely', {timeout: 5000}, async t => {
  const {endpoint, instance} = await setup(t, socket => {socket.on('data', data => socket.write(data)); socket.on('end', () => socket.end());});
  let mappingHung = false, rejectedHandshakes = 0;
  const errors = [];
  const forward = await startStreamForward({port: 0, discover: async () => [instance], request: async () => {
    if (mappingHung) throw new Error('VS Code port mapping did not finish before its deadline');
    return endpoint;
  }, relay: async (value, input, output, options) => {
    if (mappingHung) {rejectedHandshakes++; return relayStream({...value, token: 'invalid-token'}, input, output, options);}
    return relayStream(value, input, output, options);
  }, log: message => errors.push(message)});
  t.after(() => forward.close());
  const held = connect(forward.port);
  held.write('held'); await once(held, 'data');
  mappingHung = true;
  for (let index = 0; index < 2; index++) {const socket = connect(forward.port); socket.resume(); await once(socket, 'close');}
  assert.equal(rejectedHandshakes, 1);
  assert.match(errors.at(-1), /VS Code port mapping/);
  held.write('still-live'); assert.equal((await once(held, 'data'))[0].toString(), 'still-live');
});

test('mapping recovery never crosses a loaded bridge generation', {timeout: 5000}, async t => {
  const {endpoint, instance} = await setup(t, socket => {socket.on('data', data => socket.write(data)); socket.on('end', () => socket.end());});
  let current = instance, mappingHung = false;
  const stages = [];
  const errors = [];
  const forward = await startStreamForward({port: 0, discover: async () => [current], request: async () => {
    if (mappingHung) throw new Error('VS Code port mapping did not finish before its deadline');
    return endpoint;
  }, trace: entry => stages.push(entry.stage), log: message => errors.push(message)});
  t.after(() => forward.close());
  const held = connect(forward.port);
  held.write('held'); await once(held, 'data');
  current = {...instance, runtimeGeneration: 'new-ui-generation'};
  stages.length = 0;
  mappingHung = true;
  const fresh = connect(forward.port);
  fresh.resume(); await once(fresh, 'close');
  assert.equal(stages.includes('mapping_recovery_candidate'), false);
  assert.match(errors.at(-1), /VS Code port mapping/);
});

test('a stale route retries fresh mapping once before consuming any SSH input', {timeout: 5000}, async t => {
  let receivedBytes = 0, requests = 0, rejected = 0;
  const {endpoint, instance} = await setup(t, socket => {
    socket.on('data', data => {receivedBytes += data.length; socket.write(data);});
    socket.on('end', () => socket.end());
  });
  const forward = await startStreamForward({port: 0, discover: async () => [instance], request: async () => {requests++; return endpoint;},
    relay: (value, input, output, options) => relayStream(rejected++ === 0 ? {...value, token: 'stale-token'} : value, input, output, options)});
  t.after(() => forward.close());
  const input = randomBytes(256 * 1024);
  const socket = connect(forward.port);
  const output = collect(socket);
  socket.end(input);
  assert.equal(hash(await output), hash(input));
  assert.equal(receivedBytes, input.length);
  assert.equal(requests, 2);
});

test('closing a fully EOF-ended duplex settles even if its peer does not close WebSocket', {timeout: 3000}, async t => {
  const carrier = new WebSocketServer({host: '127.0.0.1', port: 0});
  await once(carrier, 'listening');
  carrier.on('connection', ws => {
    ws.on('error', () => {});
    ws.send(Buffer.from([2]));
    ws.on('message', packet => {if (packet[0] === 1) ws.send(Buffer.from([1]));});
  });
  t.after(async () => {for (const ws of carrier.clients) ws.terminate(); await new Promise(resolve => carrier.close(resolve));});
  const instance = {active: true, instance: 'duplex-test', workspace: 'duplex-workspace', runtimeGeneration: 'generation', capabilities: {ssh_stream: 1}};
  const forward = await startStreamForward({port: 0, discover: async () => [instance], request: async () => ({protocol: 1, uri: `http://127.0.0.1:${carrier.address().port}/ssh`, token: 'test', generation: 'broker'})});
  t.after(() => forward.close());
  const socket = connect(forward.port);
  const finished = collect(socket);
  socket.end();
  await finished;
  socket.destroy();
  await forward.close();
});

test('relay cancellation settles within one second when the peer stops reading Close', {timeout: 3000}, async t => {
  const carrier = new WebSocketServer({host: '127.0.0.1', port: 0});
  await once(carrier, 'listening');
  carrier.on('connection', ws => {ws.on('error', () => {}); ws.send(Buffer.from([2]), () => ws.pause());});
  t.after(async () => {for (const ws of carrier.clients) ws.terminate(); await new Promise(resolve => carrier.close(resolve));});
  const input = new PassThrough();
  const output = new PassThrough();
  let connected;
  const ready = new Promise(resolve => {connected = resolve;});
  const relayed = relayStream({uri: `http://127.0.0.1:${carrier.address().port}/ssh`, token: 'test'}, input, output, {onConnected: connected});
  const rejected = assert.rejects(relayed, /reset/);
  await ready;
  const began = Date.now();
  input.destroy(new Error('owned reset'));
  await rejected;
  assert.ok(Date.now() - began >= 900, 'must not settle before its Close cleanup');
  assert.ok(Date.now() - began < 2000, 'must not wait indefinitely for a paused peer');
});

test('forward shutdown settles its owned relay before stopping the shared carrier', {timeout: 5000}, async t => {
  const {endpoint, instance} = await setup(t, socket => {socket.resume(); socket.on('end', () => socket.destroy());});
  const order = [];
  const carrier = new WebSocketServer({host: '127.0.0.1', port: 0});
  await once(carrier, 'listening');
  const upstreams = new Set();
  const downstreams = new Set();
  carrier.on('connection', downstream => {
    downstreams.add(downstream);
    // Record receipt when the peer replies to a Close, not its later TCP
    // 'close' event (which can legitimately run after the initiator's event).
    const replyClose = downstream.close.bind(downstream);
    downstream.close = (...args) => {
      if (args[0] === 1000) order.push('protocol_close');
      return replyClose(...args);
    };
    const upstream = new WebSocket(endpoint.uri.replace('http:', 'ws:'), {headers: {'x-tunnelterm-token': endpoint.token}});
    upstreams.add(upstream);
    upstream.on('error', () => {});
    downstream.on('error', () => {});
    downstream.on('message', packet => upstream.send(packet));
    upstream.on('message', packet => {if (downstream.readyState === WebSocket.OPEN) downstream.send(packet);});
    downstream.on('close', code => {
      if (code !== 1006) upstream.close();
    });
  });
  const forward = await startStreamForward({port: 0, discover: async () => [instance], request: async () => endpoint,
    gateway: {resolve: async value => ({...value, uri: `http://127.0.0.1:${carrier.address().port}/ssh`}), close: async () => {
      order.push('carrier_stop');
      for (const ws of downstreams) ws.terminate();
    }}});
  t.after(async () => {
    await forward.close();
    for (const ws of downstreams) ws.terminate();
    for (const ws of upstreams) ws.terminate();
    await new Promise(resolve => carrier.close(resolve));
  });
  // Destination readiness packet precedes this echoed byte in the same stream.
  const destinationReply = Buffer.from('ready');
  const output = connect(forward.port);
  t.after(() => output.destroy());
  // Wait for accepted stream setup independently of an idle TCP destination.
  await new Promise(resolve => {
    carrier.once('connection', downstream => {
      downstream.once('message', () => resolve());
    });
    output.write(destinationReply);
  });
  await forward.close();
  assert.deepEqual(order, ['protocol_close', 'carrier_stop']);
});

test('hard local reset sends a protocol Close through a carrier that retains abruptly closed streams', {timeout: 5000}, async t => {
  let closed;
  const remoteClosed = new Promise(resolve => {closed = resolve;});
  const {endpoint} = await setup(t, socket => {socket.resume(); socket.on('end', () => socket.destroy()); socket.on('close', closed);});
  const carrier = new WebSocketServer({host: '127.0.0.1', port: 0});
  await once(carrier, 'listening');
  const upstreams = new Set();
  carrier.on('connection', downstream => {
    const upstream = new WebSocket(endpoint.uri.replace('http:', 'ws:'), {headers: {'x-tunnelterm-token': endpoint.token}});
    upstreams.add(upstream);
    upstream.on('error', () => {});
    downstream.on('error', () => {});
    downstream.on('message', packet => upstream.send(packet));
    upstream.on('message', packet => {if (downstream.readyState === WebSocket.OPEN) downstream.send(packet);});
    // Model a carrier retaining its upstream on raw TCP loss (1006), while
    // forwarding an actual WebSocket Close. No timers hide the distinction.
    downstream.on('close', code => {if (code !== 1006) upstream.close();});
  });
  t.after(async () => {
    for (const ws of carrier.clients) ws.terminate();
    for (const ws of upstreams) ws.terminate();
    await new Promise(resolve => carrier.close(resolve));
  });
  const input = new PassThrough();
  const output = new PassThrough();
  let connected;
  const ready = new Promise(resolve => {connected = resolve;});
  const relayed = relayStream({...endpoint, uri: `http://127.0.0.1:${carrier.address().port}/ssh`}, input, output, {onConnected: connected});
  const rejected = assert.rejects(relayed, /reset/);
  await ready;
  input.destroy(new Error('owned client reset'));
  await rejected;
  let timer;
  try {
    await Promise.race([remoteClosed, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('Carrier retained destination after local reset')), 1000);})]);
  } finally {clearTimeout(timer);}
});

for (const flood of [false, true]) {
  test(`killing an owned local client cleans its destination TCP (${flood ? 'paused output' : 'idle'})`, {timeout: 6000}, async t => {
    let closed, accepted;
    const remoteClosed = new Promise(resolve => {closed = resolve;});
    const remoteAccepted = new Promise(resolve => {accepted = resolve;});
    const {forward} = await setup(t, socket => {
      accepted();
      socket.on('end', () => socket.destroy());
      socket.on('close', closed);
      socket.resume();
      if (flood) {
        const push = () => {while (!socket.destroyed && socket.write(Buffer.alloc(65536))) {}};
        socket.on('drain', push);
        push();
      }
    });
    const child = spawn(process.execPath, ['-e', `
      const net=require('node:net');
      const s=net.createConnection({host:'127.0.0.1',port:${forward.port}});
      s.on('error',()=>{});s.on('connect',()=>{s.write('ready');s.pause();console.log('CLIENT_READY');});
      setInterval(()=>{},1000);
    `], {windowsHide: true});
    child.stderr.resume();
    t.after(() => {if(child.exitCode===null)child.kill();});
    await once(child.stdout, 'data');
    await remoteAccepted;
    await new Promise(resolve => setTimeout(resolve, flood ? 200 : 20));
    const exited = once(child, 'close');
    child.kill();
    await exited;
    let timer;
    try {
      await Promise.race([remoteClosed, new Promise((_, reject) => {timer=setTimeout(() => reject(new Error('Destination TCP survived killed client')), 2000);})]);
    } finally {clearTimeout(timer);}
  });
}

test('FIN follows every fragment of a single 256 KiB Readable chunk', {timeout: 5000}, async t => {
  const trailer = randomBytes(256 * 1024);
  let receivedBytes = 0;
  const {endpoint} = await setup(t, socket => {
    socket.on('data', data => {receivedBytes += data.length; socket.write(data);});
    socket.on('end', () => socket.end(trailer));
  });
  const bytes = randomBytes(256 * 1024);
  const input = new PassThrough();
  const output = new PassThrough();
  const collected = collect(output);
  input.end(bytes);
  await relayStream(endpoint, input, output);
  const actual = await collected;
  assert.equal(receivedBytes, bytes.length);
  assert.equal(actual.length, bytes.length + trailer.length);
  assert.equal(hash(actual), hash(Buffer.concat([bytes, trailer])));
});

test('multiple large input chunks followed immediately by EOF retain all bytes and reverse trailers', {timeout: 5000}, async t => {
  const trailer = randomBytes(512 * 1024);
  let receivedBytes = 0;
  const {endpoint} = await setup(t, socket => {
    socket.on('data', data => {receivedBytes += data.length; socket.write(data);});
    socket.on('end', () => socket.end(trailer));
  });
  const chunks = [randomBytes(256 * 1024), randomBytes(512 * 1024), randomBytes(17)];
  const input = Readable.from(chunks, {objectMode: false});
  const output = new PassThrough();
  const collected = collect(output);
  await relayStream(endpoint, input, output);
  const expected = Buffer.concat([...chunks, trailer]);
  const actual = await collected;
  assert.equal(receivedBytes, expected.length - trailer.length);
  assert.equal(actual.length, expected.length);
  assert.equal(hash(actual), hash(expected));
});

test('stream preserves four simultaneous binary channels with independent EOF and trailers', {timeout: 10_000}, async t => {
  const {forward} = await setup(t, socket => {
    socket.on('data', data => {if (!socket.write(data)) socket.pause();});
    socket.on('drain', () => socket.resume());
    socket.on('end', () => socket.end(Buffer.from('TRAILER')));
  });
  await Promise.all(Array.from({length: 4}, async () => {
    const input = randomBytes(2 * 1024 * 1024);
    const socket = connect(forward.port);
    const output = collect(socket);
    socket.end(input);
    assert.equal(hash(await output), hash(Buffer.concat([input, Buffer.from('TRAILER')])));
  }));
});

test('a quiet held stream does not delay three auxiliary channels; resets isolate to one channel', {timeout: 5000}, async t => {
  const {forward} = await setup(t, socket => {
    socket.on('data', data => socket.write(data));
    socket.on('end', () => socket.end());
  });
  const held = connect(forward.port);
  held.write('held');
  await once(held, 'data');
  const began = Date.now();
  await Promise.all([1, 2, 3].map(async id => {
    const s = connect(forward.port);
    const received = collect(s);
    s.end(`aux-${id}`);
    assert.equal((await received).toString(), `aux-${id}`);
  }));
  assert.equal(held.destroyed, false);
  assert.ok(Date.now() - began < 2000);
  held.destroy();
  const fresh = connect(forward.port);
  const received = collect(fresh);
  fresh.end('after-reset');
  assert.equal((await received).toString(), 'after-reset');
});

test('slow output consumers apply bounded backpressure and preserve bytes', {timeout: 10_000}, async t => {
  const input = randomBytes(4 * 1024 * 1024);
  const {forward} = await setup(t, socket => {
    socket.on('end', () => socket.end());
    socket.end(input);
  });
  const s = connect(forward.port);
  s.pause();
  await new Promise(resolve => setTimeout(resolve, 200));
  const received = collect(s);
  s.resume();
  s.end();
  assert.equal(hash(await received), hash(input));
});

test('broker rejects missing authentication without creating destination connections', {timeout: 3000}, async t => {
  let accepted = 0;
  const {endpoint} = await setup(t, () => accepted++);
  const ws = new WebSocket(endpoint.uri.replace('http:', 'ws:'));
  const error = once(ws, 'error');
  ws.on('error', () => {});
  await error;
  assert.equal(accepted, 0);
});

test('forward reports old loaded extension capability before opening a listening port', async () => {
  await assert.rejects(startStreamForward({port: 0, discover: async () => [{active: true, instance: 'old'}]}), /lacks SSH stream capability/);
});

test('new connections reselect the stable workspace after a bridge generation change', {timeout: 5000}, async t => {
  let current = {instance: 'old', active: true, workspace: 'stable-workspace', capabilities: {ssh_stream: 1}};
  const ids = [];
  const forward = await startStreamForward({port: 0, discover: async () => [current], request: async instance => {
    ids.push(instance.instance);
    return {protocol: 1, uri: 'http://127.0.0.1:1/ssh', token: 'test'};
  }, relay: async (_endpoint, _input, output, options) => {options.onConnected(); output.end('selected');}});
  t.after(() => forward.close());
  current = {...current, instance: 'new'};
  const s = connect(forward.port);
  const output = collect(s);
  s.end();
  assert.equal((await output).toString(), 'selected');
  assert.deepEqual(ids, ['old', 'new']);
});

test('relay setup fails within its configured budget without logging endpoint secrets', {timeout: 3000}, async t => {
  const input = new (await import('node:stream')).PassThrough();
  const output = new (await import('node:stream')).PassThrough();
  const blackhole = net.createServer(s => {s.on('error', () => {});});
  const sockets = new Set();
  blackhole.on('connection', s => sockets.add(s));
  blackhole.listen(0, '127.0.0.1'); await once(blackhole, 'listening');
  t.after(async () => {for (const s of sockets) s.destroy(); await new Promise(resolve => blackhole.close(resolve));});
  await assert.rejects(relayStream({uri: `http://127.0.0.1:${blackhole.address().port}/ssh?secret=hidden`, token: 'hidden'}, input, output, {connectTimeout: 100}), error => !error.message.includes('hidden'));
});

test('control-plane generation changes preserve live data channels and select the new generation', {timeout: 5000}, async t => {
  let instance = {instance: 'same-id', active: true, workspace: 'stable', runtimeGeneration: 'before', capabilities: {ssh_stream: 1}};
  const signals = [];
  const forward = await startStreamForward({port: 0, discover: async () => [instance], request: async () => ({protocol: 1, uri: 'http://127.0.0.1:1', token: 'test'}),
    relay: async (_endpoint, input, output, options) => {
      options.onConnected();
      input.on('data', data => output.write(data));
      input.resume();
      await once(input, 'close');
    }, log: message => signals.push(message)});
  t.after(() => forward.close());
  const old = connect(forward.port);
  old.write('before'); await once(old, 'data');
  instance = {...instance, runtimeGeneration: 'after'};
  await new Promise(resolve => setTimeout(resolve, 1100));
  old.write('still-live');
  assert.equal((await once(old, 'data'))[0].toString(), 'still-live');
  assert.equal(signals.length, 0);
  assert.equal(forward.server.listening, true);
  const fresh = connect(forward.port);
  fresh.write('after');
  assert.equal((await once(fresh, 'data'))[0].toString(), 'after');
  fresh.destroy();
  old.destroy();
});

test('simultaneous connection setup shares only an in-flight endpoint lookup, not a cached URI', {timeout: 3000}, async t => {
  let requests = 0;
  const instance = {instance: 'test', active: true, workspace: 'stable', capabilities: {ssh_stream: 1}};
  const forward = await startStreamForward({port: 0, discover: async () => [instance], request: async () => {
    requests++;
    await new Promise(resolve => setTimeout(resolve, 50));
    return {protocol: 1, uri: 'http://127.0.0.1:1/ssh', token: 'test'};
  }, relay: async (_endpoint, _input, output, options) => {options.onConnected(); output.end('ready');}});
  t.after(() => forward.close());
  const query = async () => {const s = connect(forward.port); const received = collect(s); s.end(); assert.equal((await received).toString(), 'ready');};
  await Promise.all([query(), query(), query(), query()]);
  assert.equal(requests, 2); // warmup, then the concurrent setup batch
  await query();
  assert.equal(requests, 3); // fresh lookup for the next batch
});
