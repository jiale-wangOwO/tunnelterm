import {startStreamForward} from './ssh-stream.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {classifyStreamFailure, safeStartupFailureFields} from './stream-errors.mjs';
import {stateRoot} from './client-core.mjs';
import {publicStreamEndpointFailure} from './bridge-health.cjs';

let starting, forward, stopping;
const send = value => {if (process.connected) process.send(value);};
const diagnosticsDirectory = process.env.TUNNELTERM_SERVICE_HOME ? path.resolve(process.env.TUNNELTERM_SERVICE_HOME) :
  process.platform === 'win32' && !process.env.TUNNELTERM_HOME ? path.join(os.homedir(), '.tunnelterm', 'services') : path.join(stateRoot(), 'services');
function diagnostic(fields) {
  const record = JSON.stringify({time: new Date().toISOString(), pid: process.pid, parent_pid: process.ppid, ...fields})+'\n';
  void fs.appendFile(path.join(diagnosticsDirectory, 'worker-diagnostics.log'), record, {mode: 0o600}).catch(() => {});
}
function trace(entry) {
  // Explicit allowlist: never serialize arbitrary error text or endpoint data.
  const stages = ['discovered', 'endpoint_resolved', 'loopback_resolved', 'stream_connected',
    'mapping_recovery_candidate', 'mapping_candidate_evicted', 'setup_deadline', 'connection_failed', 'relay_finished'];
  if (!stages.includes(entry.stage)) return;
  const fields = {stage: entry.stage};
  for (const key of ['connection', 'elapsed_ms', 'sent_bytes', 'received_bytes', 'send_wait_ms', 'output_wait_ms', 'receive_idle_ms']) {
    if (Number.isSafeInteger(entry[key]) && entry[key] >= 0) fields[key] = entry[key];
  }
  for (const key of ['upgraded', 'broker_open', 'local_fin', 'remote_fin', 'failed', 'send_pending', 'output_blocked']) {
    if (typeof entry[key] === 'boolean') fields[key] = entry[key];
  }
  if (['setup_timeout', 'local_io_error', 'local_input_closed', 'local_output_closed',
    'ws_error', 'ws_closed', 'invalid_packet', 'send_failed'].includes(entry.end_reason)) fields.end_reason = entry.end_reason;
  if (Number.isSafeInteger(entry.ws_close_code) && entry.ws_close_code >= 1000 && entry.ws_close_code <= 4999) fields.ws_close_code = entry.ws_close_code;
  diagnostic(fields);
}
function stop() {
  return stopping ??= (async () => {
    try {await starting; await forward?.close();} catch {}
    if (process.connected) process.disconnect();
  })();
}
process.on('message', message => {
  if (message?.type === 'start' && !starting && !stopping && typeof message.target === 'string') {
    starting = (async () => {
      forward = await startStreamForward({target: message.target, seed: message.seed, port: 0, trace});
      if (!stopping) send({type: 'online', port: forward.port});
    })();
    void starting.catch(error => {
      const message = String(error.message);
      const endpoint = publicStreamEndpointFailure(error);
      const detail = endpoint.code || (/^CLI_(CHECK|METADATA)_(CLI_UNAVAILABLE|CLI_FAILED|NETWORK_UNAVAILABLE|CANCELLED|AUTH_REQUIRED)$/.test(error.detail || '') ? error.detail :
        /\blogin required\b/i.test(message) ? 'CLI_LOGIN_REQUIRED' : /could not match/i.test(message) ? 'RESOURCE_LOOKUP_MISMATCH' :
        /Invalid local bridge token/i.test(message) ? 'LOCAL_CAPABILITY_STALE' :
        /did not establish.*loopback|mapped.*port/i.test(message) ? 'CLI_MAPPING_WAIT_TIMEOUT' :
        /bridge did not respond/i.test(message) ? 'REMOTE_COMMAND_TIMEOUT' :
        /invalid endpoint/i.test(message) ? 'INVALID_BROKER_DESCRIPTOR' :
        /companion unavailable/i.test(message) ? 'COMPANION_UNAVAILABLE' :
        /port mapping|native endpoint/i.test(message) ? 'NATIVE_MAPPING_TIMEOUT' :
        /log.in|logged in|authoriz|sign in/i.test(message) ? 'AUTH_OR_CLI' : 'OTHER_STARTUP_FAILURE');
      // Only a fixed diagnostic enum, never raw error text/URIs/capabilities.
      const safe = safeStartupFailureFields({...error, detail});
      diagnostic({error_code: classifyStreamFailure(error), ...safe});
      const code = classifyStreamFailure(error);
      send({type: 'failed', code, ...safe, seedInvalidated: error.seedInvalidated === true}); void stop();
    });
  } else if (message?.type === 'seed' && typeof message.id === 'string') {
    const state = forward?.routeSeedState();
    send({type: 'seed', id: message.id, seed: state?.seed, seedInvalidated: state?.seedInvalidated === true});
  } else if (message?.type === 'stop') void stop();
});
process.once('disconnect', () => {void stop();});
process.once('SIGTERM', () => {void stop();});
process.once('SIGINT', () => {void stop();});
