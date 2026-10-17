import net from 'node:net';
import http from 'node:http';
import {randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {createForkedWorker} from './forked-worker.mjs';
import {classifyStreamFailure, safeStartupFailureFields} from './stream-errors.mjs';

// Private capability comparison only. No identity, URI or token is ever
// serialized into lifecycle diagnostics. A newer concurrent hint must survive.
function sameRouteHint(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;
  return left.workspace === right.workspace && left.identity === right.identity &&
    left.endpoint?.protocol === 1 && right.endpoint?.protocol === 1 &&
    typeof left.endpoint.uri === 'string' && left.endpoint.uri === right.endpoint.uri &&
    typeof left.endpoint.token === 'string' && left.endpoint.token === right.endpoint.token &&
    typeof left.endpoint.generation === 'string' && left.endpoint.generation === right.endpoint.generation;
}

// A new TCP connection through the entire authenticated stream must reach sshd.
// This sends no SSH credentials, opens no shell, and never executes a command.
export function probeSshBanner(port, {timeout = 4500, signal} = {}) {
  return new Promise((resolve, reject) => {
    const began = Date.now();
    const socket = net.createConnection({host: '127.0.0.1', port});
    let buffer = Buffer.alloc(0), finished = false;
    const done = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      // A hard close is intentional: only this owned unauthenticated probe.
      if (socket.resetAndDestroy && !socket.connecting) socket.resetAndDestroy(); else socket.destroy();
      if (error) reject(error); else resolve({banner_ms: Date.now() - began});
    };
    const abort = () => done(new Error('Health probe cancelled'));
    const timer = setTimeout(() => done(new Error('New SSH connection did not reach an SSH banner within its health budget')), timeout);
    socket.on('error', () => done(new Error('New SSH connection failed its health check')));
    socket.on('close', () => {if (!finished) done(new Error('New SSH connection closed before its banner'));});
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 4096) {done(new Error('Invalid SSH banner')); return;}
      for (const line of buffer.toString('ascii').split('\n').slice(0, -1)) {
        if (/^SSH-2\.0-[^\r\n]+\r?$/.test(line)) {done(); return;}
      }
    });
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
  });
}

// One stable front door; immutable per-connection leases pin backend epochs.
// A retiring epoch is closed only after its last front connection finishes.
export async function startManagedService({target, port = 22222, serviceId = randomUUID(), seed, saveSeed = async () => {},
  workerFactory = createForkedWorker, probe = probeSshBanner,
  healthInterval = 30000, retryBase = 1000, retryMax = 30000, setupTimeout = 7500, workerStartupTimeout = 35000,
  log = () => {}, now = Date.now} = {}) {
  if (!target) throw new Error('Managed service requires an explicit stable workspace target');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid managed listener port');
  const epochs = new Set();
  let resolveClosed;
  const closed = new Promise(resolve => {resolveClosed = resolve;});
  const connections = new Set();
  const jobs = new Set();
  const controller = new AbortController();
  let current, adopting, recovery, health, timer, closing, draining = false, stopped = false;
  let phase = 'starting', failures = 0, lastReady = null, lastFailure = null, nextCheck = 0;
  let latestSeed = seed, lastLatency = null, persistence = 'unknown';
  let persistenceTail = Promise.resolve();
  const epochId = () => randomUUID();
  function track(promise) {
    jobs.add(promise);
    void promise.finally(() => jobs.delete(promise)).catch(() => {});
    return promise;
  }
  const status = () => ({protocol: 1, service_id: serviceId, pid: process.pid, target, port: server.address()?.port ?? port,
    phase, readiness: 'new TCP connection through authenticated broker to SSH-2.0 banner; not user-authentication',
    active_connections: connections.size, backend_epochs: epochs.size,
    accepting_new: !draining && !stopped && phase === 'ready', updating: !!recovery,
    current_epoch: current?.id ?? null, last_ready: lastReady, last_banner_ms: lastLatency, route_persistence: persistence,
    last_failure: lastFailure, consecutive_failures: failures, next_check: nextCheck || null,
    routes: [...epochs].map(epoch => ({epoch: epoch.id, state: epoch.retiring ? 'retiring' : 'current', active_connections: epoch.refs}))});
  const event = (type, extra = {}) => log({time: new Date(now()).toISOString(), event: type, ...extra});
  function schedule(delay) {
    clearTimeout(timer);
    if (draining || stopped) return;
    nextCheck = now() + delay;
    timer = setTimeout(() => {void check().catch(() => {});}, delay);
    timer.unref();
  }
  async function disposeEpoch(epoch) {
    if (!epoch || epoch.refs || !epoch.retiring) return;
    if (!epoch.closing) epoch.closing = track(Promise.resolve().then(() => epoch.worker.close()).finally(() => epochs.delete(epoch)));
    await epoch.closing;
  }
  function failure(error, keepReady = false) {
    failures++;
    // Never expose remote responses/URLs/capabilities in public status.
    lastFailure = {at: new Date(now()).toISOString(), code: classifyStreamFailure(error), ...safeStartupFailureFields(error)};
    phase = keepReady ? 'ready' : (current ? 'recovering' : 'offline');
    event('recovery_failed', {code: lastFailure.code});
    schedule(Math.min(retryMax, retryBase * 2 ** Math.min(10, failures - 1)));
  }
  function persistRouteHint(value, epoch) {
    // Serialize writes: a clear of an old rejected hint cannot complete after
    // and overwrite a concurrently verified newer route's persistence.
    const pending = persistenceTail.then(async () => {
      if (epoch && (current !== epoch || draining || stopped)) return;
      try {
        await saveSeed(value);
        if (!epoch || current === epoch && !draining && !stopped) persistence = 'saved';
      }
      catch {
        if (!epoch || current === epoch && !draining && !stopped) persistence = 'unavailable';
        event('state_store_unavailable');
      }
    });
    persistenceTail = pending;
    return pending;
  }
  async function discardRejectedHint(error, worker, attemptedSeed) {
    let invalidated = error.seedInvalidated === true;
    if (!invalidated && worker?.routeSeedState) {
      let timeout;
      try {
        const state = await Promise.race([Promise.resolve().then(() => worker.routeSeedState()), new Promise(resolve => {
          timeout = setTimeout(() => resolve(undefined), 1000);
        })]);
        invalidated = state?.seedInvalidated === true;
      } catch {} finally {clearTimeout(timeout);}
    }
    if (!invalidated || !sameRouteHint(latestSeed, attemptedSeed)) return;
    latestSeed = undefined; event('route_hint_discarded');
    // The persistence callback stores an empty envelope, not a file deletion.
    await persistRouteHint(undefined);
  }
  async function readRouteHint(epoch) {
    if (typeof epoch.worker.routeSeed !== 'function') return undefined;
    let timeout, abort;
    try {
      return await Promise.race([Promise.resolve().then(() => epoch.worker.routeSeed()), new Promise(resolve => {
        timeout = setTimeout(() => {event('route_hint_unavailable', {reason: 'timeout'}); resolve(undefined);}, 1000);
        abort = () => resolve(undefined);
        controller.signal.addEventListener('abort', abort, {once: true});
        if (controller.signal.aborted) abort();
      })]);
    } catch {
      event('route_hint_unavailable', {reason: 'failed'});
      return undefined;
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', abort);
    }
  }
  async function ready(epoch, result) {
    if (current !== epoch || draining || stopped) return;
    phase = 'ready'; failures = 0; lastFailure = null;
    lastReady = new Date(now()).toISOString(); lastLatency = result?.banner_ms ?? null;
    // A successful fresh authenticated banner is health evidence. Optional
    // route-hint IPC is bounded metadata, not a reason to reject that route.
    const hint = await readRouteHint(epoch);
    if (current !== epoch || draining || stopped) return;
    if (hint) {latestSeed = hint; await persistRouteHint(hint, epoch);}
    // A shadow refresh may have adopted another epoch while this metadata or
    // persistence was pending. Its health state and timer always win.
    if (current !== epoch || draining || stopped) return;
    if (phase !== 'ready') {schedule(retryBase); return;}
    event('route_ready', {epoch: epoch.id, banner_ms: lastLatency});
    schedule(healthInterval);
  }
  async function recover({preserveReady = false} = {}) {
    if (recovery) return recovery;
    if (draining || stopped) throw new Error('Managed service is draining or stopped');
    const previousReady = preserveReady && phase === 'ready' ? current : undefined;
    if (!previousReady) phase = current ? 'recovering' : 'starting';
    recovery = track((async () => {
      let worker, adoptedEpoch, adopted = false;
      const predecessor = current;
      const attemptedSeed = latestSeed;
      try {
        const pending = Promise.resolve().then(() => workerFactory({target, port: 0, seed: attemptedSeed, log: () => {}, trace: () => {}}));
        let timeout, abort;
        try {
          worker = await Promise.race([pending, new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Backend startup exceeded its total budget')), workerStartupTimeout);
            abort = () => reject(new Error('Backend startup cancelled'));
            controller.signal.addEventListener('abort', abort, {once: true});
            if (controller.signal.aborted) abort();
          })]);
        } catch (error) {
          // An opaque factory may ignore cancellation. Late workers remain
          // owned, but are disposed and can never replace the current epoch.
          void pending.then(late => late.close()).catch(() => {});
          throw error;
        } finally {clearTimeout(timeout); controller.signal.removeEventListener('abort', abort);}
        if (draining || stopped) throw new Error('Managed recovery was cancelled');
        const result = await probe(worker.port, {signal: controller.signal});
        if (draining || stopped) throw new Error('Managed recovery was cancelled');
        // Recovery is single-flight. Keep adoption fenced nevertheless: a late
        // candidate must never replace a newer current epoch.
        if (current !== predecessor) return current;
        const epoch = {id: epochId(), worker, refs: 0, retiring: false};
        const previous = current;
        epochs.add(epoch); current = epoch; adopting = epoch; adoptedEpoch = epoch; adopted = true;
        if (previous) {previous.retiring = true; void disposeEpoch(previous).catch(() => {});}
        await ready(epoch, result);
        return epoch;
      } catch (error) {
        await discardRejectedHint(error, worker, attemptedSeed);
        if (!draining && !stopped) failure(error, current === previousReady && phase === 'ready'); throw error;
      }
      finally {
        if (adopting === adoptedEpoch) adopting = undefined;
        if (worker && !adopted) await worker.close();
      }
    })()).finally(() => {recovery = undefined;});
    // Startup can be offline without an unhandled rejection or missing front door.
    void recovery.catch(() => {});
    return recovery;
  }
  async function check() {
    if (health) {await health; return status();}
    if (draining || stopped) return status();
    // The newly adopted epoch already passed its banner probe. Serialize its
    // initial ready application; a failed overlapping probe must not join this
    // same recovery and accidentally leave the normal 30s timer on a bad route.
    // The old epoch remains independently probeable during a shadow warmup.
    if (recovery && adopting === current) {await recovery; return status();}
    health = track((async () => {
      // Recheck the same current route even after a previous failure. Requiring
      // a brand-new CLI worker first can strand a recovered existing route
      // behind an unrelated transient CLI/setup failure indefinitely.
      if (!current) return recover();
      const tested = current;
      try {
        const result = await probe(tested.worker.port, {signal: controller.signal});
        if (!draining && !stopped && current === tested) await ready(tested, result);
        return tested;
      } catch {
        if (current !== tested) return current;
        if (!draining && !stopped) {phase = 'recovering'; return recover();}
      }
    })()).finally(() => {health = undefined;});
    void health.catch(() => {});
    await health;
    return status();
  }
  const server = net.createServer({allowHalfOpen: true}, socket => {
    socket.on('error', () => {});
    socket.pause(); socket.setNoDelay(true);
    if (draining || stopped || phase !== 'ready' || !current) {socket.destroy(); return;}
    const epoch = current;
    const backend = net.createConnection({host: '127.0.0.1', port: epoch.worker.port, allowHalfOpen: true});
    const record = {socket, backend, epoch};
    connections.add(record); epoch.refs++;
    let released = false, receivedData = false, frontClosed = false, backClosed = false;
    const release = () => {
      if (!frontClosed || !backClosed) return;
      if (released) return;
      released = true; connections.delete(record); epoch.refs--;
      void disposeEpoch(epoch).catch(() => {});
      if (draining && !connections.size) void close().catch(() => {});
    };
    const deadline = setTimeout(() => {backend.destroy(); socket.destroy();}, setupTimeout);
    backend.setNoDelay(true);
    backend.once('data', () => {receivedData = true;});
    const unavailable = () => {
      if (current !== epoch || socket.destroyed || draining || stopped) return;
      phase = 'recovering'; void check().catch(() => {});
    };
    backend.on('error', () => {unavailable(); socket.destroy();});
    socket.on('error', () => backend.destroy());
    socket.on('close', () => {frontClosed = true; backend.destroy(); release();});
    backend.on('close', hadError => {
      backClosed = true;
      clearTimeout(deadline);
      if (!receivedData) unavailable();
      if (hadError || !backend.readableEnded) socket.destroy();
      release();
    });
    backend.once('connect', () => {
      clearTimeout(deadline);
      if (socket.destroyed) {backend.destroy(); return;}
      socket.pipe(backend); backend.pipe(socket); socket.resume();
    });
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen({host: '127.0.0.1', port}, resolve);});
  event('listener_started', {port: server.address().port});
  // Binding is separate from readiness; status reports the distinction.
  void recover().catch(() => {});
  function close() {
    return closing ??= (async () => {
      stopped = true; phase = 'stopping'; clearTimeout(timer); controller.abort();
      for (const {socket, backend} of connections) {socket.destroy(); backend.destroy();}
      await new Promise(resolve => server.close(resolve));
      // A worker factory is contractually bounded (native/CLI startup budgets).
      await Promise.allSettled([...jobs]);
      for (const epoch of epochs) {epoch.retiring = true; epoch.refs = 0;}
      await Promise.allSettled([...epochs].map(disposeEpoch));
      latestSeed = undefined; current = undefined; phase = 'stopped'; resolveClosed();
    })();
  }
  return {server, port: server.address().port, status, check, closed,
    refresh: () => recover({preserveReady: true}).then(status), close,
    stop: ({force = false} = {}) => {
      if (connections.size && !force) throw new Error('Active SSH connections exist; use drain instead of stop');
      return close();
    },
    drain: () => {draining = true; phase = 'draining'; clearTimeout(timer); controller.abort(); if (!connections.size) void close(); return status();}};
}

// Authenticated loopback-only lifecycle control. No arbitrary commands/targets.
export async function startServiceControl(service, {token = randomBytes(32).toString('hex'), socketPath} = {}) {
  const authorize = req => {
    const provided = Buffer.from(String(req.headers['x-tunnelterm-control'] || ''));
    const expected = Buffer.from(token);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (!authorize(req)) {res.writeHead(403); res.end('{"error":"Forbidden"}'); return;}
    try {
      let result;
      if (req.method === 'GET' && req.url === '/status') result = service.status();
      else if (req.method === 'POST' && req.url === '/check') result = await service.check();
      else if (req.method === 'POST' && req.url === '/refresh') result = await service.refresh();
      else if (req.method === 'POST' && req.url === '/drain') result = service.drain();
      else if (req.method === 'POST' && req.url === '/stop') {await service.stop(); result = service.status();}
      else {res.writeHead(404); res.end('{"error":"Not found"}'); return;}
      res.end(JSON.stringify(result));
    } catch (error) {res.writeHead(409); res.end(JSON.stringify({error: error.message.startsWith('Active SSH') ? error.message : 'Service operation failed; inspect status'}));}
  });
  server.requestTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    if (socketPath) server.listen(socketPath, resolve); else server.listen(0, '127.0.0.1', resolve);
  });
  return {port: socketPath ? undefined : server.address().port, socketPath, token, close: () => new Promise(resolve => server.close(resolve))};
}
