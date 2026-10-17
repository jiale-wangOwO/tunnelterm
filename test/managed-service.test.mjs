import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import {once} from 'node:events';
import test from 'node:test';
import {startManagedService, startServiceControl, probeSshBanner} from '../src/managed-service.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, timeout = 1500) {
  const end = Date.now() + timeout;
  while (!predicate()) {if (Date.now() > end) throw new Error('Bounded test condition failed'); await pause(5);}
}
async function worker(t) {
  const sockets = new Set();
  let closes = 0;
  const server = net.createServer({allowHalfOpen: true}, socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    socket.write('SSH-2.0-managed-test\r\n');
    socket.on('data', data => {if (!socket.write(data)) socket.pause();});
    socket.on('drain', () => socket.resume()); socket.on('end', () => socket.end());
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const close = async () => {closes++; for (const socket of sockets) socket.destroy(); if (server.listening) await new Promise(resolve => server.close(resolve));};
  t.after(close);
  return {port: server.address().port, close, closes: () => closes,
    routeSeed: () => ({endpoint: {token: 'SECRET_CAPABILITY_NEVER_LOG'}, identity: 'fixture', workspace: 'fixture'})};
}
function connect(port) {const socket = net.createConnection({host: '127.0.0.1', port}); socket.on('error', () => {}); return socket;}

test('explicitly invalidated startup hint is not offered again on the next cold recovery', {timeout: 3000}, async t => {
  const working = await worker(t), seeds = [];
  const seed = {workspace: 'fixture', identity: 'unchanged', endpoint: {token: 'owned-hint'}};
  const service = await startManagedService({target: 'fixture', port: 0, seed, retryBase: 10, retryMax: 30, healthInterval: 60000,
    workerFactory: async options => {seeds.push(options.seed); if(seeds.length === 1){const error = new Error('candidate failed within total budget'); error.seedInvalidated = true; throw error;} return working;}});
  t.after(() => service.close()); await waitFor(() => service.status().phase === 'ready');
  assert.deepEqual(seeds, [seed, undefined]);
});

const fixtureSeed = generation => ({workspace: 'fixture', identity: `fixture:${generation}`,
  endpoint: {protocol: 1, uri: 'http://127.0.0.1:1/ssh', token: `PRIVATE_${generation}`, generation}});

test('missing or malformed invalidation is unknown and never clears a stored hint', {timeout: 3000}, async t => {
  for (const state of [{}, {seed: undefined}, {seedInvalidated: false}, {seedInvalidated: 'true'}]) {
    const seed = fixtureSeed('unknown'), seeds = [], writes = [];
    const service = await startManagedService({target: 'fixture', port: 0, seed, retryBase: 10, retryMax: 20,
      saveSeed: async value => {writes.push(value);}, probe: async () => {throw new Error('banner unavailable');},
      workerFactory: async options => {seeds.push(options.seed); return {port: 1, routeSeedState: async () => state, close: async () => {}};}});
    t.after(() => service.close()); await waitFor(() => seeds.length >= 3);
    assert.ok(seeds.every(value => value === seed)); assert.deepEqual(writes, []);
    await service.close();
  }
});

test('temporary startup CLI or auth failures retain the unresolved private route hint', {timeout: 3000}, async t => {
  for (const code of ['AUTH_REQUIRED', 'CLI_FAILED', 'NETWORK_UNAVAILABLE', 'CANCELLED']) {
    const seed = fixtureSeed('unresolved'), seeds = [], writes = [];
    const service = await startManagedService({target: 'fixture', port: 0, seed, retryBase: 10, retryMax: 20,
      saveSeed: async value => {writes.push(value);},
      workerFactory: async options => {seeds.push(options.seed); throw Object.assign(new Error('temporary dependency failure'), {code});}});
    t.after(() => service.close()); await waitFor(() => seeds.length >= 2);
    assert.ok(seeds.every(value => value === seed)); assert.deepEqual(writes, []);
    await service.close();
  }
});

test('failed invalidated-hint persistence keeps fail-closed memory and logs no capability', {timeout: 3000}, async t => {
  const seed = fixtureSeed('rejected'), seeds = [], events = [];
  let saves = 0;
  const service = await startManagedService({target: 'fixture', port: 0, seed, retryBase: 10, retryMax: 20,
    log: event => events.push(event),
    saveSeed: async value => {saves++; assert.equal(value, undefined); throw new Error('PRIVATE_DISK_DETAIL');},
    probe: async () => {throw new Error('banner unavailable');},
    workerFactory: async options => {
      seeds.push(options.seed);
      if (!options.seed) throw new Error('provider unavailable without a hint');
      return {port: 1, routeSeedState: async () => ({seedInvalidated: true}), close: async () => {}};
    }});
  t.after(() => service.close()); await waitFor(() => seeds.length >= 3);
  assert.deepEqual(seeds.slice(0, 3), [seed, undefined, undefined]); assert.equal(saves, 1);
  assert.equal(service.status().route_persistence, 'unavailable');
  assert.equal(service.status().accepting_new, false);
  assert.ok(events.some(event => event.event === 'state_store_unavailable'));
  assert.ok(!JSON.stringify(events).includes('PRIVATE_'));
});

test('late rejected old-hint state cannot discard a concurrently verified newer hint or existing lease', {timeout: 5000}, async t => {
  const first = await worker(t), third = await worker(t);
  const oldHint = fixtureSeed('old'), newerHint = fixtureSeed('new');
  let currentHint = oldHint, starts = 0, releaseState;
  first.routeSeed = () => currentHint; third.routeSeed = () => newerHint;
  const statePending = new Promise(resolve => {releaseState = resolve;});
  const seeds = [], writes = [];
  const rejected = {port: 1, routeSeedState: () => statePending, close: async () => {}};
  const service = await startManagedService({target: 'fixture', port: 0, healthInterval: 60000,
    saveSeed: async value => {writes.push(value);},
    probe: (port, options) => {if (port === rejected.port) throw new Error('old hint rejected'); return probeSshBanner(port, options);},
    workerFactory: async options => {seeds.push(options.seed); starts++; return starts === 1 ? first : starts === 2 ? rejected : third;}});
  t.after(() => service.close()); await waitFor(() => service.status().phase === 'ready');
  const held = connect(service.port); t.after(() => held.destroy()); await once(held, 'data');
  const refreshed = service.refresh(); void refreshed.catch(() => {});
  await waitFor(() => starts === 2);
  currentHint = newerHint; await service.check();
  releaseState({seedInvalidated: true}); await assert.rejects(refreshed, /old hint rejected/);
  assert.equal(service.status().phase, 'ready'); assert.ok(!writes.includes(undefined));
  held.write('preserved'); assert.equal((await once(held, 'data'))[0].toString(), 'preserved');
  assert.equal(first.closes(), 0);
  await service.refresh(); assert.equal(seeds[2], newerHint); assert.equal(first.closes(), 0);
});

test('hint persistence serializes old-hint clearing before a concurrently verified replacement', {timeout: 5000}, async t => {
  const first = await worker(t), oldHint = fixtureSeed('old'), newerHint = fixtureSeed('new');
  let currentHint = oldHint, starts = 0, releaseClear, clearing = false;
  first.routeSeed = () => currentHint;
  const clearPending = new Promise(resolve => {releaseClear = resolve;});
  const writes = [];
  const rejected = {port: 1, routeSeedState: async () => ({seedInvalidated: true}), close: async () => {}};
  const service = await startManagedService({target: 'fixture', port: 0, healthInterval: 60000,
    saveSeed: async value => {if (value === undefined) {clearing = true; await clearPending;} writes.push(value);},
    probe: (port, options) => {if (port === rejected.port) throw new Error('old hint rejected'); return probeSshBanner(port, options);},
    workerFactory: async () => ++starts === 1 ? first : rejected});
  t.after(() => service.close()); await waitFor(() => service.status().phase === 'ready');
  const refreshed = service.refresh(); void refreshed.catch(() => {}); await waitFor(() => clearing);
  currentHint = newerHint;
  const checked = service.check();
  await pause(20); assert.deepEqual(writes, [oldHint]);
  releaseClear(); await assert.rejects(refreshed, /old hint rejected/); await checked;
  assert.deepEqual(writes, [oldHint, undefined, newerHint]); assert.equal(service.status().phase, 'ready');
});

test('stable entry swaps backend epochs and drains only the old unreferenced worker', {timeout: 5000}, async t => {
  const first = await worker(t), second = await worker(t);
  let starts = 0, capturedSeed;
  const service = await startManagedService({target: 'fixture', port: 0, healthInterval: 60000,
    workerFactory: async options => {capturedSeed = options.seed; return starts++ === 0 ? first : second;}});
  t.after(() => service.close());
  await waitFor(() => service.status().phase === 'ready');
  const stablePort = service.port;
  const old = connect(stablePort); t.after(() => old.destroy());
  assert.match((await once(old, 'data'))[0].toString(), /SSH-2.0/);
  await service.refresh();
  assert.equal(service.port, stablePort); assert.equal(first.closes(), 0);
  assert.equal(service.status().backend_epochs, 2);
  assert.equal(capturedSeed.endpoint.token, 'SECRET_CAPABILITY_NEVER_LOG');
  assert.ok(!JSON.stringify(service.status()).includes('SECRET_CAPABILITY_NEVER_LOG'));
  old.write('old-live'); assert.equal((await once(old, 'data'))[0].toString(), 'old-live');
  const fresh = connect(stablePort); t.after(() => fresh.destroy());
  assert.match((await once(fresh, 'data'))[0].toString(), /SSH-2.0/);
  old.destroy(); await waitFor(() => first.closes() === 1);
  assert.equal(second.closes(), 0); assert.equal(service.status().phase, 'ready');
});

test('failed new-connection health check recovers without killing an existing lease', {timeout: 5000}, async t => {
  const first = await worker(t), second = await worker(t);
  let starts = 0, failed = false;
  const service = await startManagedService({target: 'fixture', port: 0, healthInterval: 60000,
    workerFactory: async () => starts++ === 0 ? first : second,
    probe: (port, options) => {if (failed && port === first.port) throw new Error('new streams stopped'); return probeSshBanner(port, options);}});
  t.after(() => service.close());
  await waitFor(() => service.status().phase === 'ready');
  const held = connect(service.port); t.after(() => held.destroy()); await once(held, 'data');
  failed = true;
  await Promise.all([service.check(), service.check(), service.check()]);
  assert.equal(starts, 2); assert.equal(first.closes(), 0);
  held.write('preserved'); assert.equal((await once(held, 'data'))[0].toString(), 'preserved');
  assert.equal(service.status().phase, 'ready');
});

test('a transient banner failure followed by CLI startup failure can recover the same current route', {timeout: 5000}, async t => {
  const first = await worker(t), hint = fixtureSeed('same-route'), starts = [];
  first.routeSeed = () => hint;
  let failNextProbe = false;
  const service = await startManagedService({target: 'fixture', port: 0, healthInterval: 60000, retryBase: 25, retryMax: 25,
    workerFactory: async options => {
      starts.push(options.seed);
      if (starts.length > 1) throw Object.assign(new Error('PRIVATE_CLI_TEXT'), {
        code: 'CLI_FAILED', detail: 'CLI_CHECK_CLI_FAILED', cause_kind: 'PROCESS_EXIT', exit_code: 1});
      return first;
    },
    probe: (port, options) => {
      if (failNextProbe) {failNextProbe = false; throw new Error('temporary banner timeout');}
      return probeSshBanner(port, options);
    }});
  t.after(() => service.close()); await waitFor(() => service.status().phase === 'ready' && !service.status().updating);
  const held = connect(service.port); t.after(() => held.destroy()); await once(held, 'data');
  failNextProbe = true;
  await assert.rejects(service.check(), /PRIVATE_CLI_TEXT/);
  assert.equal(service.status().phase, 'recovering');
  assert.equal(service.status().last_failure.detail, 'CLI_CHECK_CLI_FAILED');
  assert.equal(service.status().last_failure.cause_kind, 'PROCESS_EXIT');
  assert.equal(service.status().last_failure.exit_code, 1);
  assert.ok(!JSON.stringify(service.status()).includes('PRIVATE_'));
  await waitFor(() => service.status().phase === 'ready' && !service.status().updating);
  assert.equal(starts.length, 2, 'Retry proves the current route instead of cold-starting a third worker');
  assert.equal(service.status().last_failure, null); assert.equal(first.closes(), 0);
  held.write('same-lease'); assert.equal((await once(held, 'data'))[0].toString(), 'same-lease');
  const fresh = connect(service.port); t.after(() => fresh.destroy());
  assert.match((await once(fresh, 'data'))[0].toString(), /SSH-2.0/);
});

test('throwing or hanging route metadata does not downgrade a freshly banner-verified route', {timeout: 5000}, async t => {
  for (const mode of ['throw', 'hang']) {
    const working = await worker(t), events = [], writes = [];
    working.routeSeed = () => {if (mode === 'throw') throw new Error('PRIVATE_SEED_RPC'); return new Promise(() => {});};
    const service = await startManagedService({target: 'fixture', port: 0, healthInterval: 60000,
      workerFactory: async () => working, saveSeed: async value => {writes.push(value);}, log: event => events.push(event)});
    t.after(() => service.close());
    await waitFor(() => service.status().phase === 'ready' && !service.status().updating, 2000);
    assert.equal(service.status().accepting_new, true); assert.equal(service.status().consecutive_failures, 0);
    assert.equal(service.status().last_failure, null); assert.deepEqual(writes, []);
    assert.ok(events.some(event => event.event === 'route_hint_unavailable'));
    assert.ok(!JSON.stringify(events).includes('PRIVATE_'));
    const fresh = connect(service.port); t.after(() => fresh.destroy());
    assert.match((await once(fresh, 'data'))[0].toString(), /SSH-2.0/);
    fresh.destroy(); await service.close();
  }
});

test('late old-epoch health metadata cannot replace a newer shadow hint or readiness', {timeout: 5000}, async t => {
  const first = await worker(t), second = await worker(t), third = await worker(t);
  const oldHint = fixtureSeed('old-health'), newHint = fixtureSeed('new-shadow'), staleHint = fixtureSeed('stale-health');
  first.routeSeed = () => oldHint; second.routeSeed = third.routeSeed = () => newHint;
  const seeds = [], writes = []; let releaseHint, metadataStarted = false;
  const pendingHint = new Promise(resolve => {releaseHint = resolve;});
  const service = await startManagedService({target: 'fixture', port: 0, healthInterval: 60000,
    workerFactory: async options => {seeds.push(options.seed); return [first, second, third][seeds.length - 1];},
    saveSeed: async value => {writes.push(value);},
    probe: async (port, options) => ({...await probeSshBanner(port, options), banner_ms: port === first.port ? 11 : 22})});
  t.after(() => service.close()); await waitFor(() => service.status().phase === 'ready' && !service.status().updating);
  const held = connect(service.port); t.after(() => held.destroy()); await once(held, 'data');
  first.routeSeed = () => {metadataStarted = true; return pendingHint;};
  const checked = service.check(); await waitFor(() => metadataStarted);
  await service.refresh(); const adopted = service.status().current_epoch;
  assert.equal(service.status().last_banner_ms, 22);
  releaseHint(staleHint); await checked;
  assert.equal(service.status().current_epoch, adopted); assert.equal(service.status().phase, 'ready');
  assert.equal(service.status().last_banner_ms, 22); assert.deepEqual(writes, [oldHint, newHint]);
  assert.equal(first.closes(), 0); assert.equal(second.closes(), 0);
  held.write('old-owned-stream'); assert.equal((await once(held, 'data'))[0].toString(), 'old-owned-stream');
  await service.refresh(); assert.equal(seeds[2], newHint, 'Future cold setup uses only the current verified hint');
});

test('a late failed old-epoch probe cannot override a healthy shadow adoption', {timeout: 5000}, async t => {
  const first = await worker(t), second = await worker(t); let starts = 0, deferFirst = false, rejectProbe, probeStarted = false;
  const pendingProbe = new Promise((_, reject) => {rejectProbe = reject;});
  const service = await startManagedService({target: 'fixture', port: 0, healthInterval: 60000,
    workerFactory: async () => ++starts === 1 ? first : second,
    probe: (port, options) => {if (deferFirst && port === first.port) {probeStarted = true; return pendingProbe;} return probeSshBanner(port, options);}});
  t.after(() => service.close()); await waitFor(() => service.status().phase === 'ready' && !service.status().updating);
  deferFirst = true; const checked = service.check(); await waitFor(() => probeStarted);
  await service.refresh(); const adopted = service.status().current_epoch;
  rejectProbe(new Error('old route failed too late')); await checked;
  assert.equal(service.status().current_epoch, adopted); assert.equal(service.status().accepting_new, true);
  assert.equal(starts, 2); assert.equal(service.status().last_failure, null);
});

test('close cancels hanging metadata and its late result cannot restore stopped state or persist a hint', {timeout: 3000}, async t => {
  const working = await worker(t), originalHint = fixtureSeed('before-close'), writes = [];
  working.routeSeed = () => originalHint;
  let releaseHint, metadataStarted = false;
  const pendingHint = new Promise(resolve => {releaseHint = resolve;});
  const service = await startManagedService({target: 'fixture', port: 0, healthInterval: 60000,
    workerFactory: async () => working, saveSeed: async value => {writes.push(value);}});
  t.after(() => service.close()); await waitFor(() => service.status().phase === 'ready' && !service.status().updating);
  working.routeSeed = () => {metadataStarted = true; return pendingHint;};
  const checked = service.check(); await waitFor(() => metadataStarted);
  const began = Date.now(); await service.close(); await checked;
  assert.ok(Date.now() - began < 500); assert.equal(service.status().phase, 'stopped');
  releaseHint(fixtureSeed('after-close')); await pause(20);
  assert.equal(service.status().phase, 'stopped'); assert.equal(service.status().accepting_new, false);
  assert.deepEqual(writes, [originalHint]); assert.equal(service.status().backend_epochs, 0);
});

test('coalesced checks share one probe but every caller receives only safe public status', {timeout: 3000}, async t => {
  const working = await worker(t); let probes = 0, releaseProbe, deferProbe = false;
  const pendingProbe = new Promise(resolve => {releaseProbe = resolve;});
  const service = await startManagedService({target: 'fixture', port: 0, healthInterval: 60000,
    workerFactory: async () => working,
    probe: async (port, options) => {probes++; if (deferProbe) await pendingProbe; return probeSshBanner(port, options);}});
  t.after(() => service.close()); await waitFor(() => service.status().phase === 'ready' && !service.status().updating);
  const identity = service.status().service_id;
  deferProbe = true;
  const first = service.check(), second = service.check();
  assert.equal(probes, 2, 'Startup and one shared health probe only');
  releaseProbe();
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.service_id, identity); assert.equal(result.pid, process.pid);
    assert.equal(result.phase, 'ready'); assert.equal(result.accepting_new, true);
    for (const privateKey of ['worker', 'refs', 'retiring', 'routeSeed', 'close']) assert.equal(privateKey in result, false);
    assert.ok(!JSON.stringify(result).includes('SECRET_CAPABILITY'));
  }
  assert.equal(probes, 2);
});

test('checks serialize with the newly adopted epochs bounded ready metadata', {timeout: 3000}, async t => {
  const working = await worker(t); let probes = 0, metadataStarted = false, releaseHint;
  const pendingHint = new Promise(resolve => {releaseHint = resolve;});
  working.routeSeed = () => {metadataStarted = true; return pendingHint;};
  const service = await startManagedService({target: 'fixture', port: 0, healthInterval: 60000,
    workerFactory: async () => working, probe: (port, options) => {probes++; return probeSshBanner(port, options);}});
  t.after(() => service.close()); await waitFor(() => metadataStarted);
  const checked = service.check();
  assert.equal(probes, 1, 'Adoption already has a fresh banner; its metadata application is single-flight');
  releaseHint(fixtureSeed('adoption'));
  const result = await checked;
  assert.equal(probes, 1); assert.equal(result.service_id, service.status().service_id);
  assert.equal(result.phase, 'ready'); assert.equal(result.updating, false);
});

test('backend failure during adoption metadata schedules a short recheck not the normal health interval', {timeout: 3000}, async t => {
  const first = await worker(t), second = await worker(t); let starts = 0, metadataStarted = false, releaseHint;
  const pendingHint = new Promise(resolve => {releaseHint = resolve;});
  first.routeSeed = () => {metadataStarted = true; return pendingHint;};
  const service = await startManagedService({target: 'fixture', port: 0, healthInterval: 60000, retryBase: 10, retryMax: 10,
    workerFactory: async () => ++starts === 1 ? first : second});
  t.after(() => service.close()); await waitFor(() => metadataStarted);
  await first.close();
  const failed = connect(service.port); t.after(() => failed.destroy());
  await waitFor(() => service.status().phase === 'recovering');
  releaseHint(fixtureSeed('ended-adoption'));
  await waitFor(() => starts === 2 && service.status().phase === 'ready' && !service.status().updating);
  const fresh = connect(service.port); t.after(() => fresh.destroy());
  assert.match((await once(fresh, 'data'))[0].toString(), /SSH-2.0/);
  assert.equal(service.status().accepting_new, true);
});

test('planned shadow refresh continues accepting new connections on the healthy epoch', {timeout: 4000}, async t => {
  const first = await worker(t), second = await worker(t);
  let complete, starts = 0;
  const preparing = new Promise(resolve => {complete = resolve;});
  const service = await startManagedService({target: 'fixture', port: 0, healthInterval: 60000,
    workerFactory: async () => starts++ === 0 ? first : preparing});
  t.after(() => service.close()); await waitFor(() => service.status().phase === 'ready');
  const refreshed = service.refresh();
  await waitFor(() => starts === 2);
  assert.equal(service.status().accepting_new, true);
  const fresh = connect(service.port); t.after(() => fresh.destroy());
  assert.match((await once(fresh, 'data'))[0].toString(), /SSH-2.0/);
  complete(second); await refreshed;
  fresh.write('pinned'); assert.equal((await once(fresh, 'data'))[0].toString(), 'pinned');
  assert.equal(first.closes(), 0);
});

test('offline startup binds a stable entry and automatically retries into ready', {timeout: 3000}, async t => {
  const working = await worker(t);
  let starts = 0;
  const service = await startManagedService({target: 'fixture', port: 0, retryBase: 10, retryMax: 30, healthInterval: 60000,
    workerFactory: async () => {if (++starts === 1) throw new Error('provider offline'); return working;}});
  t.after(() => service.close());
  assert.ok(service.server.listening);
  await waitFor(() => starts === 1 && service.status().phase === 'offline');
  const port = service.port;
  await waitFor(() => service.status().phase === 'ready');
  assert.equal(service.port, port); assert.equal(starts, 2);
});

test('startup cancellation is bounded and disposes a late worker without adoption', {timeout: 3000}, async t => {
  const working = await worker(t);
  let complete;
  const delayed = new Promise(resolve => {complete = resolve;});
  const service = await startManagedService({target: 'fixture', port: 0, workerFactory: () => delayed});
  await pause(5);
  const began = Date.now(); await service.close();
  assert.ok(Date.now() - began < 500);
  complete(working); await waitFor(() => working.closes() === 1);
  assert.equal(service.status().phase, 'stopped');
});

test('active stop is refused and drain waits for the owned connection', {timeout: 4000}, async t => {
  const working = await worker(t);
  const service = await startManagedService({target: 'fixture', port: 0, workerFactory: async () => working, healthInterval: 60000});
  t.after(() => service.close()); await waitFor(() => service.status().phase === 'ready');
  const held = connect(service.port); await once(held, 'data');
  assert.throws(() => service.stop(), /Active SSH/);
  service.drain(); assert.equal(service.status().phase, 'draining');
  held.write('not-killed'); assert.equal((await once(held, 'data'))[0].toString(), 'not-killed');
  held.destroy(); await service.closed;
  assert.equal(service.status().phase, 'stopped');
});

test('lifecycle control requires a capability and exposes no tokens or arbitrary commands', {timeout: 3000}, async t => {
  const working = await worker(t);
  const service = await startManagedService({target: 'fixture', port: 0, workerFactory: async () => working, healthInterval: 60000});
  t.after(() => service.close());
  const control = await startServiceControl(service, {token: 'LOCAL_CONTROL_SECRET'}); t.after(() => control.close());
  const get = (path, token) => new Promise((resolve, reject) => {
    http.get({hostname: '127.0.0.1', port: control.port, path, agent: false, headers: token ? {'x-tunnelterm-control': token} : {}}, response => {
      let body = ''; response.on('data', chunk => {body += chunk;}); response.on('end', () => resolve({code: response.statusCode, body}));
    }).on('error', reject);
  });
  assert.equal((await get('/status')).code, 403);
  const status = await get('/status', 'LOCAL_CONTROL_SECRET');
  assert.equal(status.code, 200);
  assert.ok(!status.body.includes('SECRET'));
  assert.equal((await get('/exec?command=anything', 'LOCAL_CONTROL_SECRET')).code, 404);
});
