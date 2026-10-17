import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await fs.readFile(new URL('../remote-stream/extension.cjs', import.meta.url), 'utf8');
function activateWithMocks({startBroker, mapUri, workspaceState = {get() {}, async update() {}}, isTrusted = true, remoteName = 'tunnel',
  bootstrapPort = 0, workspaceFolders, getConfiguration = () => ({get: () => bootstrapPort})}) {
  let endpoint;
  const context = {subscriptions: [], workspaceState};
  const vscode = {
    workspace: {isTrusted, workspaceFolders, getConfiguration}, env: {remoteName, asExternalUri: mapUri},
    Uri: {parse: value => value},
    commands: {registerCommand: (name, handler) => {
      assert.equal(name, 'tunnelterm.streamEndpoint');
      endpoint = handler;
      return {dispose() {}};
    }},
  };
  const module = {exports: {}};
  vm.runInNewContext(source, {module, setTimeout, clearTimeout, require: name => {
    if (name === 'vscode') return vscode;
    if (name === './broker.cjs') return {startBroker};
    throw new Error(`Unexpected dependency: ${name}`);
  }});
  module.exports.activate(context);
  return {endpoint, dispose: () => context.subscriptions.at(-1).dispose()};
}
const uri = {toString: () => 'http://127.0.0.1:12345/ssh'};
const flush = () => new Promise(resolve => setImmediate(resolve));

test('a transient endpoint mapping failure preserves the ready broker and existing streams', async () => {
  let starts = 0, closes = 0, mappings = 0;
  let existingStreamAlive = true;
  const broker = {port: 12345, token: 'test-token', generation: 'same-generation', close: async () => {
    closes++;
    existingStreamAlive = false;
  }};
  const extension = activateWithMocks({startBroker: async () => {starts++; return broker;},
    mapUri: async () => {if (++mappings === 2) throw new Error('Temporary mapping failure'); return uri;}});
  try {
    const first = await extension.endpoint();
    await assert.rejects(extension.endpoint(), /Temporary mapping failure/);
    assert.equal(closes, 0);
    assert.equal(existingStreamAlive, true);
    const recovered = await extension.endpoint();
    assert.equal(recovered.generation, first.generation);
    assert.equal(recovered.token, first.token);
    assert.equal(starts, 1);
    assert.equal(mappings, 3);
    assert.equal(closes, 0);
  } finally {extension.dispose(); await flush();}
  assert.equal(closes, 1);
});

test('a never-resolving native mapping is bounded and retries share it without closing existing streams', async () => {
  let starts = 0, mappings = 0, closes = 0;
  const extension = activateWithMocks({startBroker: async () => {starts++; return {port: 1, token: 'test', generation: 'one', close: async () => closes++};},
    mapUri: () => {mappings++; return new Promise(() => {});}});
  try {
    const typedTimeout = error => error.code === 'MAPPING_TIMEOUT' && error.name === 'TunnelTermMappingTimeout'
      && /did not finish before its deadline/.test(error.message);
    await assert.rejects(extension.endpoint({mapping_timeout_ms: 20}), typedTimeout);
    await assert.rejects(extension.endpoint({mapping_timeout_ms: 20}), typedTimeout);
    assert.equal(starts, 1); assert.equal(mappings, 1); assert.equal(closes, 0);
  } finally {extension.dispose(); await flush();}
  assert.equal(closes, 1);
});

test('dispose rejects an in-flight mapping immediately rather than waiting for its deadline', async () => {
  const extension = activateWithMocks({startBroker: async () => ({port: 1, token: 'test', generation: 'one', close: async () => {}}),
    mapUri: () => new Promise(() => {})});
  const pending = extension.endpoint({mapping_timeout_ms: 4000});
  const rejected = assert.rejects(pending, /is stopped/);
  await flush();
  extension.dispose();
  await rejected;
});

test('concurrent endpoint callers share a failed startup and a later request can retry', async () => {
  let starts = 0, closes = 0;
  const extension = activateWithMocks({startBroker: async () => {
    if (++starts === 1) throw new Error('Broker startup failed');
    return {port: 12345, token: 'test', generation: 'retry', close: async () => closes++};
  }, mapUri: async () => uri});
  try {
    const outcomes = await Promise.allSettled([extension.endpoint(), extension.endpoint()]);
    assert.equal(starts, 1);
    assert.ok(outcomes.every(outcome => outcome.status === 'rejected' && /Broker startup failed/.test(outcome.reason.message)));
    assert.equal((await extension.endpoint()).generation, 'retry');
    assert.equal(starts, 2);
    assert.equal(closes, 0);
  } finally {extension.dispose(); await flush();}
  assert.equal(closes, 1);
});

test('dispose during startup closes only the owned broker once and forbids further endpoint calls', async () => {
  let resolveStartup, starts = 0, closes = 0;
  const startup = new Promise(resolve => {resolveStartup = resolve;});
  const extension = activateWithMocks({startBroker: () => {starts++; return startup;}, mapUri: async () => uri});
  const pending = extension.endpoint();
  const stopped = assert.rejects(pending, /is stopped/);
  await flush();
  extension.dispose();
  extension.dispose();
  resolveStartup({port: 12345, token: 'test', generation: 'disposed', close: async () => closes++});
  await stopped;
  await flush();
  await assert.rejects(extension.endpoint(), /is stopped/);
  assert.equal(starts, 1);
  assert.equal(closes, 1);
});

function savedPorts(initial) {
  const values = new Map(initial === undefined ? [] : [['tunnelterm.streamListenPort', initial]]);
  const reads = [], writes = [];
  return {values, reads, writes,
    get(key) {reads.push(key); return values.get(key);},
    async update(key, value) {writes.push([key, value]); values.set(key, value);},
  };
}

test('workspace restart reuses the bound port but never persists authentication or generation', async () => {
  const workspaceState = savedPorts();
  const ports = [], closed = [];
  const startup = async options => {
    ports.push(options.listenPort);
    const number = ports.length;
    return {port: 32123, token: `ephemeral-${number}`, generation: `generation-${number}`,
      close: async () => closed.push(number)};
  };
  const mapping = async value => {
    assert.equal(workspaceState.values.get('tunnelterm.streamListenPort'), 32123, 'save must precede mapping');
    assert.equal(value, 'http://127.0.0.1:32123/ssh');
    return uri;
  };
  const first = activateWithMocks({startBroker: startup, mapUri: mapping, workspaceState});
  const oldEndpoint = await first.endpoint();
  first.dispose(); await flush();
  const next = activateWithMocks({startBroker: startup, mapUri: mapping, workspaceState});
  try {
    const newEndpoint = await next.endpoint();
    assert.deepEqual(ports, [0, 32123]);
    assert.equal(newEndpoint.protocol, 1);
    assert.equal(newEndpoint.brokerPort, 32123);
    assert.equal(newEndpoint.portPersistence, 'workspace');
    assert.notEqual(newEndpoint.token, oldEndpoint.token);
    assert.notEqual(newEndpoint.generation, oldEndpoint.generation);
    assert.deepEqual(workspaceState.writes, [
      ['tunnelterm.streamListenPort', 32123], ['tunnelterm.streamListenPort', 32123],
    ]);
    assert.ok(workspaceState.reads.every(key => key === 'tunnelterm.streamListenPort'));
    assert.equal(workspaceState.values.size, 1);
  } finally {next.dispose(); await flush();}
  assert.deepEqual(closed, [1, 2]);
});

test('failed mapping still preserves the saved port for the next workspace activation', async () => {
  const workspaceState = savedPorts();
  const ports = [];
  const startBroker = async ({listenPort}) => {ports.push(listenPort);
    return {port: 32124, token: 'test', generation: String(ports.length), close: async () => {}};};
  const first = activateWithMocks({startBroker, workspaceState, mapUri: async () => {throw new Error('port quota');}});
  await assert.rejects(first.endpoint(), /port quota/);
  first.dispose(); await flush();
  const next = activateWithMocks({startBroker, workspaceState, mapUri: async () => uri});
  try {await next.endpoint(); assert.deepEqual(ports, [0, 32124]);}
  finally {next.dispose(); await flush();}
});

test('invalid saved port fails closed before startup, storage writes or cloud mapping', async () => {
  for (const invalid of [0, -1, 65536, 1.5, '32123', null, NaN, {}]) {
    let starts = 0, mappings = 0;
    const workspaceState = savedPorts(invalid);
    const extension = activateWithMocks({workspaceState,
      startBroker: async () => {starts++; throw new Error('unexpected startup');},
      mapUri: async () => {mappings++; return uri;}});
    try {
      await assert.rejects(extension.endpoint(), /Saved TunnelTerm broker port is invalid/);
      assert.equal(starts, 0); assert.equal(mappings, 0); assert.equal(workspaceState.writes.length, 0);
    } finally {extension.dispose(); await flush();}
  }
});

test('occupied saved port retries only that port without replacing its hint or mapping a new port', async () => {
  const ports = [], workspaceState = savedPorts(32125);
  let mappings = 0;
  const extension = activateWithMocks({workspaceState, startBroker: async ({listenPort}) => {
    ports.push(listenPort); throw Object.assign(new Error('listen EADDRINUSE'), {code: 'EADDRINUSE'});
  }, mapUri: async () => {mappings++; return uri;}});
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(extension.endpoint(), error => error.code === 'EADDRINUSE');
    }
    assert.deepEqual(ports, [32125, 32125]);
    assert.equal(workspaceState.values.get('tunnelterm.streamListenPort'), 32125);
    assert.equal(workspaceState.writes.length, 0); assert.equal(mappings, 0);
  } finally {extension.dispose(); await flush();}
});

test('persistence failure closes the newly owned broker and shares the failed startup', async () => {
  let starts = 0, closes = 0, mappings = 0;
  const workspaceState = {get: () => 32126, update: async () => {throw new Error('storage unavailable');}};
  const extension = activateWithMocks({workspaceState, startBroker: async ({listenPort}) => {
    assert.equal(listenPort, 32126); starts++;
    return {port: 32126, token: 'ephemeral', generation: 'ephemeral', close: async () => closes++};
  }, mapUri: async () => {mappings++; return uri;}});
  try {
    const results = await Promise.allSettled([extension.endpoint(), extension.endpoint()]);
    assert.ok(results.every(result => result.status === 'rejected' && /owned broker was closed/.test(result.reason.message)));
    assert.equal(starts, 1); assert.equal(closes, 1); assert.equal(mappings, 0);
  } finally {extension.dispose(); await flush();}
  assert.equal(closes, 1, 'dispose must not close a failed startup twice');
});

test('endpoint callers wait for successful port persistence before publishing a mapping', async () => {
  let persist, starts = 0, mappings = 0;
  const written = new Promise(resolve => {persist = resolve;});
  const extension = activateWithMocks({workspaceState: {get() {}, update: () => written},
    startBroker: async () => {starts++; return {port: 32127, token: 'test', generation: 'test', close: async () => {}};},
    mapUri: async () => {mappings++; return uri;}});
  try {
    const requests = [extension.endpoint(), extension.endpoint()];
    await flush(); assert.equal(starts, 1); assert.equal(mappings, 0);
    persist(); await Promise.all(requests); assert.equal(mappings, 1);
  } finally {extension.dispose(); await flush();}
});

test('dispose during persistence closes the owned broker once and never maps it', async () => {
  let persist, closes = 0, mappings = 0;
  const written = new Promise(resolve => {persist = resolve;});
  const extension = activateWithMocks({workspaceState: {get() {}, update: () => written},
    startBroker: async () => ({port: 32128, token: 'test', generation: 'test', close: async () => closes++}),
    mapUri: async () => {mappings++; return uri;}});
  const rejected = assert.rejects(extension.endpoint(), /is stopped/);
  await flush(); extension.dispose(); extension.dispose();
  await rejected; persist(); await flush();
  assert.equal(closes, 1); assert.equal(mappings, 0);
});

test('trust and Remote Tunnel capability checks precede any workspace storage or listener access', async () => {
  for (const checks of [{isTrusted: false}, {remoteName: 'ssh-remote'}]) {
    let accessed = 0;
    const forbidden = () => {accessed++; throw new Error('unexpected resource access');};
    const extension = activateWithMocks({...checks, workspaceState: {get: forbidden, update: forbidden},
      startBroker: forbidden, mapUri: forbidden});
    try {await assert.rejects(extension.endpoint(), /requires a trusted Remote Tunnel workspace/); assert.equal(accessed, 0);}
    finally {extension.dispose(); await flush();}
  }
});

test('explicit first-start bootstrap binds and persists one port; later settings cannot migrate it', async () => {
  const workspaceState = savedPorts(), ports = [];
  const startBroker = async ({listenPort}) => {
    ports.push(listenPort);
    return {port: listenPort, token: `test-${ports.length}`, generation: `generation-${ports.length}`, close: async () => {}};
  };
  const first = activateWithMocks({workspaceState, startBroker, bootstrapPort: 32129, mapUri: async () => uri});
  const before = await first.endpoint(); first.dispose(); await flush();
  const next = activateWithMocks({workspaceState, startBroker, bootstrapPort: 32130,
    getConfiguration: () => {throw new Error('saved port must not read the bootstrap setting');}, mapUri: async () => uri});
  try {
    const after = await next.endpoint();
    assert.deepEqual(ports, [32129, 32129]);
    assert.equal(after.brokerPort, 32129); assert.equal(after.portPersistence, 'workspace');
    assert.notEqual(after.token, before.token); assert.notEqual(after.generation, before.generation);
    assert.deepEqual(workspaceState.writes, [['tunnelterm.streamListenPort', 32129], ['tunnelterm.streamListenPort', 32129]]);
  } finally {next.dispose(); await flush();}
});

test('bootstrap setting is read from the first workspace folder only when no port is saved', async () => {
  const folder = {scheme: 'vscode-remote', path: '/owned-test-workspace'};
  const calls = [], workspaceState = savedPorts();
  const extension = activateWithMocks({workspaceState, workspaceFolders: [{uri: folder}, {uri: {path: '/other'}}],
    getConfiguration(section, resource) {
      calls.push([section, resource]);
      return {get(key, fallback) {calls.push([key, fallback]); return 32131;}};
    }, startBroker: async ({listenPort}) => {
      assert.equal(listenPort, 32131);
      return {port: listenPort, token: 'test', generation: 'test', close: async () => {}};
    }, mapUri: async () => uri});
  try {await extension.endpoint(); assert.deepEqual(calls, [['tunneltermStream', folder], ['bootstrapPort', 0]]);}
  finally {extension.dispose(); await flush();}
});

test('valid nonzero bootstrap bounds are accepted without allocating another port', async () => {
  for (const bootstrapPort of [1024, 65535]) {
    const workspaceState = savedPorts();
    const extension = activateWithMocks({workspaceState, bootstrapPort, startBroker: async ({listenPort}) => {
      assert.equal(listenPort, bootstrapPort);
      return {port: listenPort, token: 'test', generation: 'test', close: async () => {}};
    }, mapUri: async () => uri});
    try {await extension.endpoint(); assert.equal(workspaceState.values.get('tunnelterm.streamListenPort'), bootstrapPort);}
    finally {extension.dispose(); await flush();}
  }
});

test('invalid first-start bootstrap fails before broker, persistence or cloud mapping access', async () => {
  for (const bootstrapPort of [-1, 1, 1023, 65536, 1024.5, '32132', null, NaN, false, {}]) {
    let starts = 0, mappings = 0;
    const workspaceState = savedPorts();
    const extension = activateWithMocks({workspaceState, bootstrapPort,
      startBroker: async () => {starts++; throw new Error('unexpected startup');},
      mapUri: async () => {mappings++; return uri;}});
    try {
      await assert.rejects(extension.endpoint(), /bootstrapPort must be 0 or an integer from 1024 to 65535/);
      assert.equal(starts, 0); assert.equal(mappings, 0); assert.equal(workspaceState.writes.length, 0);
    } finally {extension.dispose(); await flush();}
  }
});

test('invalid saved port cannot be bypassed by a valid bootstrap setting', async () => {
  let starts = 0, reads = 0;
  const extension = activateWithMocks({workspaceState: savedPorts(0),
    getConfiguration: () => {reads++; return {get: () => 32133};},
    startBroker: async () => {starts++; throw new Error('unexpected startup');}, mapUri: async () => uri});
  try {await assert.rejects(extension.endpoint(), /Saved TunnelTerm broker port is invalid/); assert.equal(starts, 0); assert.equal(reads, 0);}
  finally {extension.dispose(); await flush();}
});

test('occupied explicit bootstrap retries only its configured port and never saves a fallback', async () => {
  const ports = [], workspaceState = savedPorts();
  let mappings = 0;
  const extension = activateWithMocks({workspaceState, bootstrapPort: 32134,
    startBroker: async ({listenPort}) => {ports.push(listenPort); throw Object.assign(new Error('listen EADDRINUSE'), {code: 'EADDRINUSE'});},
    mapUri: async () => {mappings++; return uri;}});
  try {
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(extension.endpoint(), error => error.code === 'EADDRINUSE');
    assert.deepEqual(ports, [32134, 32134]); assert.equal(workspaceState.values.size, 0);
    assert.equal(workspaceState.writes.length, 0); assert.equal(mappings, 0);
  } finally {extension.dispose(); await flush();}
});

test('failure to save an explicit bootstrap closes only its owned broker before any mapping', async () => {
  let closes = 0, mappings = 0;
  const extension = activateWithMocks({bootstrapPort: 32135,
    workspaceState: {get() {}, update: async () => {throw new Error('storage unavailable');}},
    startBroker: async ({listenPort}) => {
      assert.equal(listenPort, 32135);
      return {port: listenPort, token: 'test', generation: 'test', close: async () => closes++};
    }, mapUri: async () => {mappings++; return uri;}});
  try {await assert.rejects(extension.endpoint(), /owned broker was closed/); assert.equal(closes, 1); assert.equal(mappings, 0);}
  finally {extension.dispose(); await flush();}
  assert.equal(closes, 1);
});

test('companion manifest exposes a resource-scoped optional bootstrap with no machine-specific default', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../remote-stream/package.json', import.meta.url), 'utf8'));
  const setting = manifest.contributes.configuration.properties['tunneltermStream.bootstrapPort'];
  assert.equal(setting.type, 'integer'); assert.equal(setting.scope, 'resource'); assert.equal(setting.default, 0);
  assert.deepEqual(setting.anyOf, [{enum: [0]}, {minimum: 1024, maximum: 65535}]);
  assert.equal(Object.keys(manifest.contributes.configuration.properties).length, 1);
});
