import net from 'node:net';
import WebSocket from 'ws';
import {listInstances, selectInstance, sendRequest} from './client-core.mjs';
import {createDevTunnelGateway} from './devtunnel-client.mjs';

// Filesystem readiness is not the authenticated SSH stream's readiness. A
// previously verified route may be tested while that independent provider is
// temporarily unavailable, but only inside this transport: general-purpose
// exec/read clients must retain selectInstance's stricter active requirement.
const TRANSIENT_PROVIDER_CODES = new Set(['PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE']);
const instanceKey = instance => `${instance.instance}:${instance.runtimeGeneration}`;
const exactWorkspace = (instance, target) => {
  if (instance.workspace === target) return true;
  try {return decodeURIComponent(new URL(instance.workspace).pathname) === target;} catch {return false;}
};
function freshTrustedStreamBridge(instance) {
  return instance.bridge_alive === true && instance.trusted === true &&
    instance.capabilities?.ssh_stream === 1 &&
    Number.isFinite(instance.ageMilliseconds) && instance.ageMilliseconds >= 0 && instance.ageMilliseconds < 20_000 &&
    typeof instance.workspace === 'string' && !!instance.workspace &&
    typeof instance.instance === 'string' && !!instance.instance &&
    typeof instance.runtimeGeneration === 'string' && !!instance.runtimeGeneration;
}
function transientStreamBridge(instance) {
  return freshTrustedStreamBridge(instance) && TRANSIENT_PROVIDER_CODES.has(instance.health_code);
}
function compatibleRoute(seed, instance, requireGeneration = false) {
  return seed?.workspace === instance.workspace && seed?.identity === instanceKey(instance) &&
    seed?.endpoint?.protocol === 1 && typeof seed.endpoint.uri === 'string' && !!seed.endpoint.uri &&
    typeof seed.endpoint.token === 'string' && !!seed.endpoint.token &&
    (!requireGeneration || (typeof seed.endpoint.generation === 'string' && !!seed.endpoint.generation));
}
function selectStreamInstance(instances, target, ownsRoute) {
  const candidates = instances.filter(instance => !instance.active && typeof target === 'string' && !!target && exactWorkspace(instance, target) &&
    transientStreamBridge(instance) && ownsRoute(instance));
  if (!candidates.length) return selectInstance(instances, target);
  // A seed is never permission to choose between independently open windows.
  if (instances.filter(instance => exactWorkspace(instance, target) && freshTrustedStreamBridge(instance)).length !== 1) {
    throw new Error('Selected SSH workspace matches multiple live bridge windows');
  }
  const candidate = candidates[0];
  const selected = selectInstance(instances.map(instance => instance === candidate ? {...instance, active: true} : instance), target);
  return selected.instance === candidate.instance && selected.runtimeGeneration === candidate.runtimeGeneration ? candidate : selected;
}

export function relayStream(endpoint, input, output, {connectTimeout = 5000, heartbeatInterval = 15000, onConnected = () => {}, onState = () => {}} = {}) {
  if (!Number.isSafeInteger(heartbeatInterval) || heartbeatInterval < 0 || heartbeatInterval > 2147483647) {
    throw new TypeError('SSH stream heartbeatInterval must be 0 or a positive timer interval');
  }
  const uri = new URL(endpoint.uri);
  if (!['http:', 'https:'].includes(uri.protocol)) throw new Error('Unsupported stream endpoint protocol');
  uri.protocol = uri.protocol === 'https:' ? 'wss:' : 'ws:';
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(uri, {headers: {'x-tunnelterm-token': endpoint.token},
      handshakeTimeout: connectTimeout, perMessageDeflate: false, maxPayload: 65537, followRedirects: false});
    let connected = false;
    let transportOpened = false;
    let remoteEnded = false;
    let localEnded = false;
    let finished = false;
    let sentBytes = 0, receivedBytes = 0;
    let sendStarted = 0, outputBlockedAt = 0, lastReceivedAt = Date.now();
    let sendTail = Promise.resolve();
    input.pause();
    let heartbeat;
    const timer = setTimeout(() => finish(new Error('SSH streaming connection exceeded its 5-second setup budget'), 'setup_timeout'), connectTimeout);
    const onDrain = () => {outputBlockedAt = 0; ws.resume();};
    function finish(error, endReason, wsCloseCode) {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      // Fixed metadata only. Observability must neither disclose bytes nor
      // interrupt cleanup if an optional diagnostic sink fails.
      try {onState({upgraded: transportOpened, broker_open: connected, local_fin: localEnded,
        remote_fin: remoteEnded, sent_bytes: sentBytes, received_bytes: receivedBytes, failed: !!error,
        send_pending: !!sendStarted, send_wait_ms: sendStarted ? Date.now() - sendStarted : 0,
        output_blocked: !!outputBlockedAt, output_wait_ms: outputBlockedAt ? Date.now() - outputBlockedAt : 0,
        receive_idle_ms: Date.now() - lastReceivedAt,
        ...(endReason ? {end_reason: endReason} : {}),
        ...(Number.isInteger(wsCloseCode) && wsCloseCode >= 1000 && wsCloseCode <= 4999 ? {ws_close_code: wsCloseCode} : {})});} catch {}
      clearTimeout(timer);
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      input.off('close', onInputClose);
      output.off('error', onError);
      output.off('close', onOutputClose);
      output.off('drain', onDrain);
      // A layered tunnel may retain its upstream when our loopback TCP is
      // abruptly destroyed. Send the protocol Close before dropping the
      // carrier so the broker destroys this connection's destination socket.
      // This is cancellation only: stdin EOF still uses the ordered FIN below.
      let closeTimer;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(closeTimer);
        if (error) reject(error); else resolve();
      };
      if (ws.readyState === WebSocket.CLOSED) {settle(); return;}
      // Keep this timer referenced: a proxy with no other handles must finish
      // its own bounded cleanup before its finally block stops the carrier.
      closeTimer = setTimeout(() => {ws.terminate(); settle();}, 1000);
      ws.once('close', settle);
      if (ws.readyState === WebSocket.OPEN || (ws.readyState === WebSocket.CLOSING && transportOpened)) {
        ws.resume(); // paused output must not hide the Close acknowledgement
        if (ws.readyState === WebSocket.OPEN) ws.close(1000);
      } else ws.terminate();
    }
    const onError = () => finish(new Error('Local SSH connection was reset'), 'local_io_error');
    const onInputClose = () => {
      if (!localEnded) finish(new Error('Local SSH input closed before EOF'), 'local_input_closed');
      else if (input === output && remoteEnded) finish();
    };
    const onOutputClose = () => {
      if (!remoteEnded) finish(new Error('Local SSH output closed before EOF'), 'local_output_closed');
      else if (input === output && localEnded) finish();
    };
    function sendPacket(packet) {
      return new Promise((resolve, reject) => {
        if (finished) {reject(new Error('SSH stream already closed')); return;}
        sendStarted = Date.now();
        ws.send(packet, error => {sendStarted = 0; error ? reject(new Error('SSH stream send failed')) : resolve();});
      });
    }
    function enqueueSend(action) {
      sendTail = sendTail.then(async () => {if (!finished) await action();})
        .catch(error => finish(error, 'send_failed'));
    }
    function onData(data) {
      input.pause();
      // A Readable may emit end while send callbacks for its final large chunk
      // are still pending. Serialize every fragment AND FIN on the same tail.
      enqueueSend(async () => {
        for (let offset = 0; offset < data.length; offset += 65536) {
          await sendPacket(Buffer.concat([Buffer.from([0]), data.subarray(offset, offset + 65536)]));
          sentBytes += Math.min(65536, data.length - offset);
        }
        if (!localEnded && !finished) input.resume();
      });
    }
    function onEnd() {
      localEnded = true;
      enqueueSend(() => sendPacket(Buffer.from([1])));
    }
    input.on('error', onError);
    ws.once('open', () => {
      transportOpened = true;
      if (!heartbeatInterval) return;
      // Control frames keep quiet tunnel carriers active without writing to
      // the SSH channel. A delayed/missing pong is not permission to kill a
      // paused consumer or replay an already-established session.
      heartbeat = setInterval(() => {
        if (finished || ws.readyState !== WebSocket.OPEN) return;
        const failed = () => finish(new Error('SSH stream heartbeat send failed'), 'send_failed');
        try {ws.ping(undefined, undefined, error => {if (error) failed();});}
        catch {failed();}
      }, heartbeatInterval);
      heartbeat.unref();
    });
    input.on('close', onInputClose);
    output.on('error', onError);
    output.on('close', onOutputClose);
    output.on('drain', onDrain);
    ws.on('unexpected-response', (_request, response) => {
      // An explicit broker rejection differs from an unresolved route or CLI
      // login problem. Do not retain a capability that this broker rejected.
      const error = new Error('SSH stream broker rejected its authentication');
      if ([401, 403].includes(response.statusCode)) error.code = 'BROKER_AUTH_REJECTED';
      response.resume();
      finish(error, 'ws_error');
    });
    ws.on('error', () => finish(new Error('SSH stream unavailable; reconnect the trusted VS Code Tunnel and check the companion extension'), 'ws_error'));
    ws.on('message', (data, binary) => {
      if (finished) return; // Close handshake can still deliver buffered data.
      lastReceivedAt = Date.now();
      if (!binary || !data.length) {
        finish(Object.assign(new Error('Invalid SSH stream packet'), !connected ? {code: 'BROKER_PROTOCOL_REJECTED'} : {}), 'invalid_packet'); return;
      }
      if (data[0] === 2 && data.length === 1 && !connected) {
        connected = true;
        clearTimeout(timer);
        onConnected();
        input.on('data', onData);
        input.once('end', onEnd);
        if (input.readableEnded) onEnd(); else input.resume();
      } else if (data[0] === 0 && connected && !remoteEnded && data.length > 1) {
        receivedBytes += data.length - 1;
        if (!output.write(data.subarray(1))) {outputBlockedAt = Date.now(); ws.pause();}
      } else if (data[0] === 1 && connected && !remoteEnded && data.length === 1) {
        remoteEnded = true;
        output.end();
      } else finish(Object.assign(new Error('Out-of-order SSH stream packet'), !connected ? {code: 'BROKER_PROTOCOL_REJECTED'} : {}), 'invalid_packet');
    });
    ws.on('close', code => finish(remoteEnded ? undefined : new Error('Remote SSH stream disconnected before EOF'), 'ws_closed', code));
  });
}

// Resolve each accepted connection by workspace identity, not a captured pid/id.
// An extension reload invalidates old sockets; fresh connections acquire a fresh
// endpoint. Every connection has independent flow control and failure state.
export async function startStreamForward({target, port = 22222, seed, warmTimeout = 30000, discover = listInstances, request = sendRequest, relay = relayStream, log = () => {}, trace = () => {}, gateway = createDevTunnelGateway()}) {
  if (!Number.isInteger(warmTimeout) || warmTimeout < 1 || warmTimeout > 30000) throw new Error('Invalid warm setup budget');
  const initial = selectStreamInstance(await discover(), target, instance => compatibleRoute(seed, instance, true));
  const workspace = initial.workspace;
  const endpointLookups = new Map();
  // Recovery candidates, not authoritative URI mappings. They are scoped to
  // the loaded bridge generation and promoted only by a real authenticated
  // broker connection. Every new route is revalidated by the broker; fresh
  // native mapping is reserved for cold start and pre-OPEN route failure.
  const verifiedEndpoints = new Map();
  let preparedEndpoint;
  let lastVerified;
  async function endpointFor(instance, fresh = false) {
    if (instance.capabilities?.ssh_stream !== 1) {
      throw new Error('Loaded UI extension lacks SSH stream capability. Install both prepared TunnelTerm extensions and reload the selected VS Code window.');
    }
    const key = instanceKey(instance);
    const known = verifiedEndpoints.get(key) || (preparedEndpoint?.key === key ? preparedEndpoint.endpoint : undefined);
    if (!fresh && known) return {...known, reusedMapping: true};
    if (endpointLookups.has(key)) return endpointLookups.get(key);
    const pending = (async () => {
      const response = await request(instance, {op: 'tcp.stream.endpoint'}, 5000);
      if (response.protocol !== 1 || typeof response.uri !== 'string' || typeof response.token !== 'string') {
        throw new Error('Remote SSH companion returned an invalid endpoint');
      }
      return {...response, tunnel: instance.tunnel};
    })().catch(error => {
      const verified = verifiedEndpoints.get(key);
      if (verified && String(error.message).startsWith('VS Code port mapping did not finish before its deadline')) {
        return {...verified, reusedMapping: true};
      }
      throw error;
    }).finally(() => {if (endpointLookups.get(key) === pending) endpointLookups.delete(key);});
    endpointLookups.set(key, pending);
    return pending;
  }
  // Warm activation before advertising a listener, outside the SSH handshake.
  let seedInvalidated = false;
  try {
    const compatibleSeed = compatibleRoute(seed, initial);
    // One total warm budget, not a new 30-second allowance per candidate.
    // Persisted routes are hints: a dead old port must not permanently block
    // discovery merely because the local UI generation stayed unchanged.
    const warmDeadline = Date.now() + warmTimeout;
    const warmBudget = () => {
      const remaining = warmDeadline - Date.now();
      if (remaining <= 0) throw new Error('SSH gateway warm setup exceeded its total budget');
      return remaining;
    };
    const boundedWarm = async (operation, budget = warmBudget()) => {
      let timer;
      try {
        return await Promise.race([Promise.resolve().then(() => operation(budget)), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('SSH gateway warm setup exceeded its total budget')), budget);
        })]);
      } finally {clearTimeout(timer);}
    };
    let prepared = compatibleSeed ? seed.endpoint : await boundedWarm(() => endpointFor(initial, true));
    let preparedPreviouslyVerified = compatibleSeed;
    try {await boundedWarm(budget => gateway.resolve(prepared, budget));}
    catch (error) {
      if (!compatibleSeed || ['AUTH_REQUIRED', 'CLI_UNAVAILABLE', 'CLI_FAILED', 'NETWORK_UNAVAILABLE', 'CANCELLED'].includes(error.code)) throw error;
      seedInvalidated = true;
      // If provider health is unavailable, a failed owned route is the end of
      // this attempt. Do not create native mappings to bypass the failed gate.
      if (!initial.active) throw error;
      warmBudget();
      prepared = await boundedWarm(() => endpointFor(initial, true));
      preparedPreviouslyVerified = false;
      await boundedWarm(budget => gateway.resolve(prepared, budget));
    }
    if (typeof prepared.generation === 'string' && typeof initial.runtimeGeneration === 'string') {
      preparedEndpoint = {key: instanceKey(initial), endpoint: prepared, previouslyVerified: preparedPreviouslyVerified};
    }
  }
  catch (error) {if(seedInvalidated) error.seedInvalidated = true; await gateway.close(); throw error;}
  const sockets = new Set();
  const relays = new Set();
  const identities = new Map();
  let connectionSequence = 0;
  const server = net.createServer({allowHalfOpen: true}, socket => {
    const began = Date.now();
    const connection = ++connectionSequence;
    const stage = (name, details = {}) => trace({stage: name, connection, elapsed_ms: Date.now() - began, ...details});
    sockets.add(socket);
    socket.once('close', () => {sockets.delete(socket); identities.delete(socket);});
    socket.on('error', () => {});
    socket.pause();
    socket.setNoDelay(true);
    const setupTimer = setTimeout(() => {stage('setup_deadline'); socket.destroy();}, 7500);
    void (async () => {
      const instance = selectStreamInstance(await discover(), workspace, item =>
        verifiedEndpoints.has(instanceKey(item)) ||
        (preparedEndpoint?.key === instanceKey(item) && preparedEndpoint.previouslyVerified === true));
      stage('discovered');
      if (socket.destroyed) return;
      identities.set(socket, {instance: instance.instance, generation: instance.runtimeGeneration});
      const key = instanceKey(instance);
      for (let attempt = 0; attempt < 2; attempt++) {
        const rawEndpoint = await endpointFor(instance, attempt > 0);
        stage('endpoint_resolved');
        if (rawEndpoint.reusedMapping) stage('mapping_recovery_candidate');
        const previous = verifiedEndpoints.get(key);
        if (previous && previous.generation !== rawEndpoint.generation) verifiedEndpoints.delete(key);
        let streamConnected = false;
        let pending;
        try {
          // Mapping failures are pre-OPEN failures too. Keep them in the same
          // candidate-eviction guard as authenticated WebSocket setup.
          const endpoint = await gateway.resolve(rawEndpoint, 1500);
          stage('loopback_resolved');
          if (socket.destroyed) return;
          pending = relay(endpoint, socket, socket, {connectTimeout: 2500,
          onState: state => stage('relay_finished', state), onConnected: () => {
          streamConnected = true;
          if (typeof rawEndpoint.generation === 'string' && typeof instance.runtimeGeneration === 'string') {
            verifiedEndpoints.set(key, {...rawEndpoint, reusedMapping: false});
            lastVerified = {workspace, identity: key, endpoint: {...rawEndpoint, reusedMapping: false}};
          }
          if (preparedEndpoint?.key === key) preparedEndpoint = undefined;
          clearTimeout(setupTimer); stage('stream_connected');
        }});
          relays.add(pending);
          await pending; break;
        }
        catch (error) {
          if (!streamConnected) {
            if (['BROKER_AUTH_REJECTED', 'BROKER_PROTOCOL_REJECTED'].includes(error.code) &&
              compatibleRoute(seed, instance, true) && rawEndpoint.uri === seed.endpoint.uri &&
              rawEndpoint.token === seed.endpoint.token && rawEndpoint.generation === seed.endpoint.generation) seedInvalidated = true;
            if (verifiedEndpoints.get(key) === previous) verifiedEndpoints.delete(key);
            if (preparedEndpoint?.key === key) preparedEndpoint = undefined;
            if (lastVerified?.identity === key && lastVerified.endpoint.generation === rawEndpoint.generation) lastVerified = undefined;
            // Before OPEN we have consumed no SSH input. One fresh lookup is
            // safe; after OPEN a stream must never replay another SSH session.
            if (instance.active && rawEndpoint.reusedMapping && attempt === 0 && !socket.destroyed) {stage('mapping_candidate_evicted'); continue;}
          }
          throw error;
        } finally {relays.delete(pending);}
      }
      stage('closed');
    })().catch(error => {stage('connection_failed'); log(error.message); socket.destroy();}).finally(() => clearTimeout(setupTimer));
  });
  try {await new Promise((resolve, reject) => {server.once('error', reject); server.listen({host: '127.0.0.1', port}, resolve);});}
  catch (error) {await gateway.close(); throw error;}
  let checking = false;
  const monitor = setInterval(() => {
    if (checking) return;
    checking = true;
    void (async () => {
      const instances = await discover();
      const liveKeys = new Set(instances.filter(item => item.workspace === workspace &&
        (item.active || transientStreamBridge(item))).map(instanceKey));
      for (const key of verifiedEndpoints.keys()) if (!liveKeys.has(key)) verifiedEndpoints.delete(key);
      if (preparedEndpoint && !liveKeys.has(preparedEndpoint.key)) preparedEndpoint = undefined;
      if (lastVerified && !liveKeys.has(lastVerified.identity)) lastVerified = undefined;
      // Control-plane heartbeat is not the data stream's liveness. Only the
      // owned WebSocket/TCP lifecycle may end an established SSH connection.
      // A bridge change invalidates discovery for FUTURE connections only.
    })().catch(() => {}).finally(() => {checking = false;});
  }, 1000);
  monitor.unref();
  let closing;
  return {server, workspace, port: server.address().port,
    // Internal supervisor handoff only; never serialize this capability into
    // status/logs or send it to a consumer such as an SSH client or CEO Hub.
    routeSeed: () => lastVerified && {...lastVerified, endpoint: {...lastVerified.endpoint}},
    routeSeedState: () => ({seed: lastVerified && {...lastVerified, endpoint: {...lastVerified.endpoint}}, seedInvalidated}),
    close: () => closing ??= (async () => {
    clearInterval(monitor);
    verifiedEndpoints.clear();
    preparedEndpoint = undefined;
    lastVerified = undefined;
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    // Local socket close is earlier than the tunnel's protocol Close. Keep our
    // carrier alive until every already-started relay's bounded cleanup settles.
    // Pending endpoint lookups are not relays and cannot delay teardown.
    await Promise.allSettled([...relays]);
    await gateway.close();
  })()};
}
