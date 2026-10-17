import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import test from 'node:test';
import {createDevTunnelGateway, privateTunnelAddress, resolveCliTunnel, defaultDevTunnelExecutable} from '../src/devtunnel-client.mjs';
import path from 'node:path';

const endpoint = {uri: 'https://example-42000.jpe1.devtunnels.ms/ssh', token: 'broker-token', generation: 'first'};

for (const [cause, expected] of [[{code:'ETIMEDOUT'}, 'NETWORK_UNAVAILABLE'], [{code:'ABORT_ERR'}, 'CANCELLED'], [{code:1}, 'CLI_FAILED'],
  [{code:'ENOENT'}, 'CLI_UNAVAILABLE'], [{code:3, stderr:'Login required.'}, 'AUTH_REQUIRED']]) {
  test(`official account check classifies ${String(cause.code)} as ${expected} without starting a carrier`, async t => {
    let lookups = 0, starts = 0, checks = 0;
    const gateway = createDevTunnelGateway({run: async () => {checks++; throw {...cause, message:'PRIVATE_RAW_ERROR https://private.invalid/secret'};},
      lookup: async () => {lookups++;}, launch: () => {starts++; return fakeProcess();}});
    t.after(() => gateway.close());
    await assert.rejects(gateway.resolve(endpoint), error => error.code === expected && !error.message.includes('PRIVATE_RAW_ERROR'));
    assert.equal(lookups, 0); assert.equal(starts, 0);
    assert.equal(checks, ['ETIMEDOUT', 1].includes(cause.code) ? 2 : 1);
  });
}

function mappedCarrier() {
  const child = fakeProcess();
  setImmediate(() => child.stdout.write('Forwarding from 127.0.0.1:42001 to host port 42000\n'));
  return child;
}

for (const code of [1, 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH']) {
  test(`read-only account preflight retries transient candidate ${code} once and starts exactly one carrier`, async t => {
    let checks = 0, lookups = 0, starts = 0; const options = [], logs = [], began = Date.now();
    const gateway = createDevTunnelGateway({command: 'inert-official', run: async (command, args, config) => {
      assert.equal(command, 'inert-official'); assert.deepEqual(args, ['user', 'show']); options.push(config); checks++;
      if (checks === 1) throw {code, stdout: '', stderr: '', message: 'PRIVATE account=PRIVATE token=PRIVATE https://private.invalid/secret'};
      return {stdout: 'Synthetic cached account', stderr: ''};
    }, lookup: async () => {lookups++; return 'example.jpe1';}, launch: () => {starts++; return mappedCarrier();}, log: message => logs.push(message)});
    t.after(() => gateway.close());
    const actual = await Promise.all([gateway.resolve(endpoint, 30000), gateway.resolve(endpoint, 30000)]);
    assert.equal(checks, 2); assert.equal(lookups, 1); assert.equal(starts, 1);
    assert.ok(Date.now() - began >= 240, 'the retry waits for its bounded backoff');
    assert.equal(actual[0].uri, 'http://127.0.0.1:42001/ssh'); assert.equal(actual[1].token, endpoint.token);
    assert.ok(options.every(option => option.timeout > 0 && option.timeout <= 5000 && option.windowsHide && option.signal === options[0].signal));
    assert.equal(options[0].timeout, 5000);
    assert.equal(logs.filter(message => message === 'Official CLI account check retry 2 of 2').length, 1);
    assert.equal(JSON.stringify(logs).includes('PRIVATE'), false); assert.equal(JSON.stringify(logs).includes('private.invalid'), false);
  });
}

for (const [label, cause] of [
  ['explicit authentication', {code: 1, stderr: 'Login required.'}],
  ['explicit authentication even after timeout/kill', {code: 'ETIMEDOUT', killed: true, signal: 'SIGTERM', stderr: 'HTTP 401 Unauthorized'}],
  ['missing executable', {code: 'ENOENT'}], ['denied executable', {code: 'EACCES'}], ['invalid executable', {code: 'ENOEXEC'}],
  ['cancelled', {code: 'ABORT_ERR'}], ['cancelled by name', {code: 1, name: 'AbortError'}],
  ['invalid argument', {code: 'ERR_INVALID_ARG_VALUE'}], ['TypeError', {code: 1, name: 'TypeError'}],
  ['maxBuffer', {code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true}], ['signal exit', {code: 1, signal: 'SIGTERM'}],
  ['unexplained kill', {code: null, killed: true}], ['unknown spawn', {code: 1, syscall: 'spawn inert-official'}],
  ['credential', {code: 1, stderr: 'Credential vault unavailable'}], ['configuration', {code: 1, stderr: 'Invalid configuration'}],
  ['permission', {code: 1, stderr: 'Access denied'}], ['argument hint', {code: 1, stderr: 'Usage: invalid argument'}],
  ['unsupported command', {code: 1, stderr: 'Unknown command user'}], ['unsupported option', {code: 1, stderr: 'Unrecognized option --example'}],
  ['headless handle', {code: 1, stderr: 'The console handle is invalid'}], ['storage', {code: 1, stderr: 'Unable to open credential file'}],
  ['certificate', {code: 'ECONNRESET', stderr: 'TLS certificate rejected'}], ['other exit code', {code: 3}],
]) test(`account preflight does not retry ${label}`, async t => {
  let checks = 0, lookups = 0, starts = 0; const logs = [];
  const gateway = createDevTunnelGateway({run: async () => {checks++; throw cause;}, lookup: async () => {lookups++;}, launch: () => {starts++; return mappedCarrier();}, log: message => logs.push(message)});
  t.after(() => gateway.close());
  await assert.rejects(gateway.resolve(endpoint));
  assert.equal(checks, 1); assert.equal(lookups, 0); assert.equal(starts, 0); assert.deepEqual(logs, []);
});

test('successful user show carrying an explicit login failure never retries or starts metadata', async t => {
  let checks = 0, lookups = 0;
  const gateway = createDevTunnelGateway({run: async () => {checks++; return {stdout: 'Synthetic cached account', stderr: 'Login required.'};}, lookup: async () => {lookups++;}});
  t.after(() => gateway.close());
  await assert.rejects(gateway.resolve(endpoint), error => error.code === 'AUTH_REQUIRED');
  assert.equal(checks, 1); assert.equal(lookups, 0);
});

test('account retry cannot extend the first resolve budget or borrow a later caller budget', async t => {
  let checks = 0, lookups = 0; const budgets = [];
  const gateway = createDevTunnelGateway({run: async (_command, _args, options) => {
    budgets.push(options.timeout); checks++;
    await new Promise(resolve => setTimeout(resolve, 80));
    throw {code: 1};
  }, lookup: async () => {lookups++;}});
  t.after(() => gateway.close());
  const first = gateway.resolve(endpoint, 150), second = gateway.resolve(endpoint, 30000);
  await Promise.all([assert.rejects(first), assert.rejects(second)]);
  assert.equal(checks, 1); assert.equal(lookups, 0); assert.equal(budgets.length, 1); assert.ok(budgets[0] > 0 && budgets[0] <= 150);
});

test('second account call receives only the remaining original budget', async t => {
  let checks = 0; const budgets = [];
  const gateway = createDevTunnelGateway({run: async (_command, _args, options) => {
    budgets.push(options.timeout); checks++;
    if (checks === 1) {await new Promise(resolve => setTimeout(resolve, 80)); throw {code: 1};}
    return {stdout: 'Synthetic cached account', stderr: ''};
  }, lookup: async () => 'example.jpe1', launch: () => mappedCarrier()});
  t.after(() => gateway.close());
  await gateway.resolve(endpoint, 1000);
  assert.equal(checks, 2); assert.ok(budgets[0] <= 1000); assert.ok(budgets[1] <= budgets[0] - 300); assert.ok(budgets[1] > 0);
});

test('closing during account backoff cancels the retry and never starts metadata or a carrier', async () => {
  let checks = 0, lookups = 0, starts = 0, retryStarted;
  const retry = new Promise(resolve => {retryStarted = resolve;});
  const gateway = createDevTunnelGateway({run: async () => {checks++; throw {code: 1};}, lookup: async () => {lookups++;}, launch: () => {starts++; return mappedCarrier();}, log: message => {if (message === 'Official CLI account check retry 2 of 2') retryStarted();}});
  const pending = gateway.resolve(endpoint, 1000);
  await retry; await gateway.close();
  await assert.rejects(pending, error => error.code === 'CANCELLED');
  await new Promise(resolve => setTimeout(resolve, 280));
  assert.equal(checks, 1); assert.equal(lookups, 0); assert.equal(starts, 0);
});

test('closing during an owned account call aborts it without a retry or late carrier', async () => {
  let checks = 0, lookups = 0, starts = 0, observedSignal;
  const gateway = createDevTunnelGateway({run: async (_command, _args, {signal}) => {
    checks++; observedSignal = signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject({code: 'ABORT_ERR'}), {once: true}));
  }, lookup: async () => {lookups++;}, launch: () => {starts++; return mappedCarrier();}});
  const pending = gateway.resolve(endpoint, 1000);
  await gateway.close(); await assert.rejects(pending, error => error.code === 'CANCELLED');
  assert.equal(observedSignal.aborted, true); assert.equal(checks, 1); assert.equal(lookups, 0); assert.equal(starts, 0);
});

test('late successful account result after close cannot start metadata or a carrier', async () => {
  let release, lookups = 0, starts = 0;
  const gateway = createDevTunnelGateway({run: () => new Promise(resolve => {release = resolve;}), lookup: async () => {lookups++;}, launch: () => {starts++; return mappedCarrier();}});
  const pending = gateway.resolve(endpoint, 50);
  await gateway.close(); release({stdout: 'Synthetic cached account', stderr: ''});
  await assert.rejects(pending, error => error.code === 'CANCELLED');
  assert.equal(lookups, 0); assert.equal(starts, 0);
});

test('an account call that ignores its timeout cannot start metadata after the original deadline', async t => {
  let checks = 0, lookups = 0, starts = 0;
  const gateway = createDevTunnelGateway({run: async () => {
    checks++; await new Promise(resolve => setTimeout(resolve, 110));
    return {stdout: 'Synthetic cached account', stderr: ''};
  }, lookup: async () => {lookups++;}, launch: () => {starts++; return mappedCarrier();}});
  t.after(() => gateway.close());
  await assert.rejects(gateway.resolve(endpoint, 40), /deadline/);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(checks, 1); assert.equal(lookups, 0); assert.equal(starts, 0);
});

test('an injected authorize returning late cannot start metadata after the first resolve budget', async t => {
  let checks = 0, lookups = 0, starts = 0;
  const gateway = createDevTunnelGateway({authorize: async () => {checks++; await new Promise(resolve => setTimeout(resolve, 110));},
    lookup: async () => {lookups++;}, launch: () => {starts++; return mappedCarrier();}});
  t.after(() => gateway.close());
  await assert.rejects(gateway.resolve(endpoint, 40), /deadline/);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(checks, 1); assert.equal(lookups, 0); assert.equal(starts, 0);
});

test('closing during the second owned account call aborts it without a third attempt', async () => {
  let checks = 0, lookups = 0, starts = 0, secondStarted, observedSignal;
  const started = new Promise(resolve => {secondStarted = resolve;});
  const gateway = createDevTunnelGateway({run: async (_command, _args, {signal}) => {
    checks++;
    if (checks === 1) throw {code: 1};
    observedSignal = signal; secondStarted();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject({code: 'ABORT_ERR'}), {once: true}));
  }, lookup: async () => {lookups++;}, launch: () => {starts++; return mappedCarrier();}});
  const pending = gateway.resolve(endpoint, 1000);
  await started; await gateway.close();
  await assert.rejects(pending, error => error.code === 'CANCELLED');
  assert.equal(observedSignal.aborted, true); assert.equal(checks, 2); assert.equal(lookups, 0); assert.equal(starts, 0);
});

test('a failing retry diagnostic callback cannot change account recovery or expose raw error text', async t => {
  let checks = 0, starts = 0;
  const gateway = createDevTunnelGateway({run: async () => {
    checks++; if (checks === 1) throw {code: 1, stderr: 'PRIVATE_OUTPUT token=PRIVATE_TOKEN'};
    return {stdout: 'Synthetic cached account', stderr: ''};
  }, lookup: async () => 'example.jpe1', launch: () => {starts++; return mappedCarrier();}, log: message => {
    assert.equal(message.includes('PRIVATE_'), false);
    if (message === 'Official CLI account check retry 2 of 2') throw new Error('Synthetic diagnostic sink unavailable');
  }});
  t.after(() => gateway.close());
  await gateway.resolve(endpoint, 1000);
  assert.equal(checks, 2); assert.equal(starts, 1);
});

test('account retry does not retry a later metadata failure', async t => {
  let checks = 0, metadata = 0, starts = 0;
  const gateway = createDevTunnelGateway({run: async () => {checks++; if (checks === 1) throw {code: 1}; return {stdout: 'Synthetic cached account', stderr: ''};},
    lookup: async () => {metadata++; throw {code: 'CLI_FAILED'};}, launch: () => {starts++; return mappedCarrier();}});
  t.after(() => gateway.close());
  await assert.rejects(gateway.resolve(endpoint, 1000), error => error.code === 'CLI_FAILED');
  assert.equal(checks, 2); assert.equal(metadata, 1); assert.equal(starts, 0);
});

test('account retry does not retry a later carrier spawn failure', async t => {
  let checks = 0, metadata = 0, starts = 0;
  const gateway = createDevTunnelGateway({run: async () => {checks++; if (checks === 1) throw {code: 1}; return {stdout: 'Synthetic cached account', stderr: ''};},
    lookup: async () => {metadata++; return 'example.jpe1';}, launch: () => {starts++; throw new Error('Synthetic carrier spawn failure');}});
  t.after(() => gateway.close());
  await assert.rejects(gateway.resolve(endpoint, 1000), /Synthetic carrier spawn failure/);
  assert.equal(checks, 2); assert.equal(metadata, 1); assert.equal(starts, 1);
});

test('metadata list and show share a caller budget and cancellation signal', async () => {
  const controller = new AbortController(), budgets = [];
  const actual = await resolveCliTunnel('official', {...endpoint, tunnel: 'selected'}, async (_exe, args, options) => {
    assert.equal(options.signal, controller.signal); budgets.push(options.timeout);
    if(args[0] === 'list') {await new Promise(resolve => setTimeout(resolve, 25)); return {stdout: JSON.stringify({tunnels: [{tunnelId: 'actual.jpe1'}]})};}
    return {stdout: JSON.stringify({tunnel: {ports: [{portUri: endpoint.uri}]}})};
  }, {timeout: 25000, signal: controller.signal});
  assert.equal(actual, 'actual.jpe1'); assert.ok(budgets[0] <= 25000 && budgets[0] > 12000);
  assert.ok(budgets[1] <= budgets[0] - 10);
});

test('gateway close cancels owned pending metadata and never launches a late carrier', async () => {
  let signal, starts = 0;
  const gateway = createDevTunnelGateway({authorize: async () => {}, lookup: (_exe, _endpoint, _run, options) => {
    signal = options.signal;
    assert.equal(options.timeout, 30000);
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('owned lookup cancelled')), {once: true}));
  }, launch: () => {starts++; return fakeProcess();}});
  await assert.rejects(gateway.resolve(endpoint, 30), /deadline/);
  await gateway.close(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(signal.aborted, true); assert.equal(starts, 0);
});
test('executable selection honors explicit configuration and prefers the shared installed CLI', () => {
  const home = '/user', root = '/cached';
  const shared = path.join(home, '.tunnelterm', 'bin', 'devtunnel.exe');
  const cached = path.join(root, 'bin', 'devtunnel.exe');
  const options = {home, root, platform: 'win32', environment: {}, exists: value => [shared, cached].includes(value)};
  assert.equal(defaultDevTunnelExecutable(options), shared);
  assert.equal(defaultDevTunnelExecutable({...options, environment: {TUNNELTERM_DEVTUNNEL: '/configured/official'}}), '/configured/official');
  assert.equal(defaultDevTunnelExecutable({...options, exists: value => value === cached}), cached);
});
function fakeProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
  child.kill = () => {child.exitCode = 0; child.emit('close', 0);};
  return child;
}

test('official gateway shares one authenticated client, handles split summaries and fresh mapped ports', async t => {
  let starts = 0, checks = 0;
  const child = fakeProcess();
  const gateway = createDevTunnelGateway({command: 'official-cli', lookup: async () => 'example.jpe1', authorize: async () => {checks++;}, launch: (_command, args) => {
    starts++;
    assert.deepEqual(args, ['connect', 'example.jpe1']);
    setImmediate(() => {child.stdout.write('SSH: Forwarding from 127.0.0.'); child.stdout.write('1:42001 to host port 42000.\n');});
    return child;
  }});
  t.after(() => gateway.close());
  const values = await Promise.all([gateway.resolve(endpoint), gateway.resolve(endpoint)]);
  assert.equal(starts, 1); assert.equal(checks, 1);
  assert.equal(values[0].uri, 'http://127.0.0.1:42001/ssh');
  assert.equal(values[0].token, endpoint.token);
  child.stdout.write('SSH: Forwarding from 127.0.0.1:43001 to host port 43000.\n');
  const fresh = await gateway.resolve({...endpoint, uri: 'https://example-43000.jpe1.devtunnels.ms/ssh', generation: 'next'});
  assert.equal(fresh.uri, 'http://127.0.0.1:43001/ssh');
  assert.equal(fresh.generation, 'next'); assert.equal(starts, 1);
});

test('a missing mapped port fails only that lookup and preserves the shared client', async t => {
  const child = fakeProcess();
  let starts = 0;
  const gateway = createDevTunnelGateway({authorize: async () => {}, lookup: async () => 'example.jpe1', launch: () => {starts++; return child;}});
  t.after(() => gateway.close());
  await assert.rejects(gateway.resolve(endpoint, 50), /before its deadline/);
  assert.equal(child.exitCode, null);
  child.stdout.write('SSH: Forwarding from 127.0.0.1:42000 to host port 42000.\n');
  assert.equal((await gateway.resolve(endpoint)).uri, 'http://127.0.0.1:42000/ssh');
  assert.equal(starts, 1);
});

test('private web DNS aliases resolve through selected-label metadata to the actual CLI ID', async () => {
  const calls = [];
  const actual = await resolveCliTunnel('official', {...endpoint, tunnel: 'my-server'}, async (_exe, args) => {
    calls.push(args);
    if (args[0] === 'list') return {stdout: JSON.stringify({tunnels: [{tunnelId: 'actual-resource.jpe1'}]})};
    return {stdout: JSON.stringify({tunnel: {ports: [{portNumber: 42000, portUri: 'https://example-42000.jpe1.devtunnels.ms/'}]}})};
  });
  assert.equal(actual, 'actual-resource.jpe1');
  assert.deepEqual(calls[0], ['list', '--labels', 'my-server', '--limit', '20', '--json']);
  assert.deepEqual(calls[1], ['show', 'actual-resource.jpe1', '--json']);
});

test('login failure never launches an interactive client and local endpoints need no CLI', async t => {
  let starts = 0;
  const gateway = createDevTunnelGateway({authorize: async () => {throw new Error('Please log in using the official CLI');}, launch: () => {starts++; return fakeProcess();}});
  t.after(() => gateway.close());
  await assert.rejects(gateway.resolve(endpoint), /Please log in/);
  assert.equal(starts, 0);
  const local = {...endpoint, uri: 'http://127.0.0.1:42000/ssh'};
  assert.equal(await gateway.resolve(local), local);
  assert.equal(privateTunnelAddress('https://not-devtunnels.example/ssh'), undefined);
});

test('gateway cleanup is bounded while an opaque metadata lookup remains pending', async () => {
  let release, starts = 0;
  const lookup = new Promise(resolve => {release = resolve;});
  const gateway = createDevTunnelGateway({authorize: async () => {}, lookup: () => lookup, launch: () => {starts++; return fakeProcess();}});
  await assert.rejects(gateway.resolve(endpoint, 30), /before its deadline/);
  let timer;
  try {
    await Promise.race([gateway.close(), new Promise((_, reject) => {timer=setTimeout(() => reject(new Error('Cleanup waited on an unbounded lookup')), 100);})]);
  } finally {clearTimeout(timer);}
  release('example.jpe1');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 0);
});
