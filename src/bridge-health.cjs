'use strict';

// Health probes are read-only and local callers have a deadline. VS Code's
// filesystem API has no cancellation: retain the single underlying request
// after that deadline, rather than accumulating abandoned native operations.
const PROVIDER_STATES = Object.freeze(['unchecked', 'checking', 'ready', 'unavailable', 'timeout', 'untrusted', 'stopped']);
const HEALTH_CODES = Object.freeze(['PROVIDER_UNCHECKED', 'PROVIDER_CHECKING', 'PROVIDER_READY',
  'PROVIDER_UNAVAILABLE', 'WORKSPACE_UNAVAILABLE', 'PERMISSION_DENIED', 'PROVIDER_TIMEOUT',
  'CANCELLED', 'PROVIDER_FAILED', 'WORKSPACE_UNTRUSTED', 'BRIDGE_STOPPED', 'BRIDGE_IO_FAILED']);
const NEXT_ACTIONS = Object.freeze(['none', 'wait_for_probe', 'reconnect_remote_workspace',
  'check_workspace_path', 'check_workspace_permissions', 'trust_workspace', 'open_bridge', 'inspect_bridge']);
const details = Object.freeze({
  PROVIDER_UNCHECKED: ['unchecked', 'wait_for_probe', 'The selected remote workspace has not been checked.'],
  PROVIDER_CHECKING: ['checking', 'wait_for_probe', 'Checking the selected remote workspace.'],
  PROVIDER_READY: ['ready', 'none', 'The selected remote workspace filesystem is reachable.'],
  PROVIDER_UNAVAILABLE: ['unavailable', 'reconnect_remote_workspace', 'The remote filesystem provider is unavailable. Reconnect this Remote Tunnel window.'],
  WORKSPACE_UNAVAILABLE: ['unavailable', 'check_workspace_path', 'The selected remote workspace is unavailable. Check its path.'],
  PERMISSION_DENIED: ['unavailable', 'check_workspace_permissions', 'The selected remote workspace cannot be accessed with the current permissions.'],
  PROVIDER_TIMEOUT: ['timeout', 'reconnect_remote_workspace', 'The remote workspace probe exceeded its deadline. Reconnect this Remote Tunnel window.'],
  CANCELLED: ['unavailable', 'reconnect_remote_workspace', 'The remote workspace operation was cancelled. Recheck this Remote Tunnel window.'],
  PROVIDER_FAILED: ['unavailable', 'reconnect_remote_workspace', 'The remote workspace check failed. Inspect this Remote Tunnel window.'],
  WORKSPACE_UNTRUSTED: ['untrusted', 'trust_workspace', 'The selected workspace is not trusted.'],
  BRIDGE_STOPPED: ['stopped', 'open_bridge', 'The local bridge is stopped.'],
  BRIDGE_IO_FAILED: ['unavailable', 'inspect_bridge', 'The local bridge queue is unavailable.'],
});
// Fixed endpoint diagnostics cross a local queue boundary. Keep messages and
// actions here, rather than forwarding arbitrary properties of native errors.
const ENDPOINT_DETAILS = Object.freeze({
  MAPPING_TIMEOUT: ['reload_selected_workspace', 'VS Code port mapping did not finish before its deadline; the native endpoint command is still pending. After accounting for active connections, reload only the selected Remote Tunnel service window.'],
  COMPANION_UNAVAILABLE: ['check_companion', 'SSH stream companion command unavailable. Check that TunnelTerm SSH Stream is enabled in this remote workspace.'],
  MAPPING_UNAVAILABLE: ['reconnect_remote_workspace', 'The SSH stream port mapping is unavailable. Recheck this Remote Tunnel window.'],
  ENDPOINT_FAILED: ['inspect_bridge', 'The SSH stream endpoint request failed. Inspect this Remote Tunnel window.'],
  ...Object.fromEntries(['PROVIDER_UNAVAILABLE', 'WORKSPACE_UNAVAILABLE', 'PERMISSION_DENIED', 'PROVIDER_TIMEOUT', 'CANCELLED']
    .map(code => [code, [details[code][1], details[code][2]]])),
});

function publicStreamEndpointFailure(value) {
  if (typeof value?.code !== 'string' || !Object.hasOwn(ENDPOINT_DETAILS, value.code)) return {};
  const [nextAction, message] = ENDPOINT_DETAILS[value.code];
  return {code: value.code, next_action: nextAction, error: message};
}

function classifyProviderFailure(error) {
  const code = String(error?.code || '');
  const text = String(error?.message || '');
  if (code === 'ENOPRO' || /no file system provider|no filesystem provider/i.test(text)) return 'PROVIDER_UNAVAILABLE';
  if (['EACCES', 'EPERM', 'NoPermissions'].includes(code)) return 'PERMISSION_DENIED';
  if (['ENOENT', 'FileNotFound', 'FileNotADirectory', 'ENOTDIR'].includes(code)) return 'WORKSPACE_UNAVAILABLE';
  if (['ETIMEDOUT', 'PROVIDER_TIMEOUT'].includes(code)) return 'PROVIDER_TIMEOUT';
  if (['ABORT_ERR', 'Canceled', 'Cancelled'].includes(code) || ['AbortError', 'Canceled', 'Cancelled'].includes(error?.name)) return 'CANCELLED';
  return 'PROVIDER_FAILED';
}

function healthValue(code, bridgeAlive = true) {
  const safeCode = HEALTH_CODES.includes(code) ? code : 'PROVIDER_FAILED';
  const [providerState, nextAction] = details[safeCode];
  const remoteReady = bridgeAlive && safeCode === 'PROVIDER_READY';
  return {bridge_alive: bridgeAlive, remote_ready: remoteReady, ready: remoteReady,
    provider_state: providerState, health_code: safeCode, next_action: nextAction};
}

// Independently validate values at serialization boundaries. Never preserve a
// raw error, error code, URI or endpoint capability as a health diagnostic.
function publicHealth(value) {
  return {...(typeof value?.bridge_alive === 'boolean' ? {bridge_alive: value.bridge_alive} : {}),
    ...(typeof value?.remote_ready === 'boolean' ? {remote_ready: value.remote_ready} : {}),
    ...(PROVIDER_STATES.includes(value?.provider_state) ? {provider_state: value.provider_state} : {}),
    ...(HEALTH_CODES.includes(value?.health_code) ? {health_code: value.health_code} : {}),
    ...(NEXT_ACTIONS.includes(value?.next_action) ? {next_action: value.next_action} : {})};
}

function createRemoteHealthProbe({probe, isTrusted, isStopped = () => false, timeoutMs = 3000,
  setTimer = setTimeout, clearTimer = clearTimeout}) {
  if (typeof probe !== 'function' || typeof isTrusted !== 'function') throw new TypeError('Health probe callbacks are required');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new RangeError('Health deadline must be between 1 and 10000 milliseconds');
  let code = 'PROVIDER_UNCHECKED', inFlight, generation = 0, stopped = false;
  function unavailable() {
    const next = stopped || isStopped() ? 'BRIDGE_STOPPED' : !isTrusted() ? 'WORKSPACE_UNTRUSTED' : undefined;
    if (next && next !== code) {code = next; generation++;}
    return next;
  }
  function snapshot() {
    unavailable();
    return healthValue(code, code !== 'BRIDGE_STOPPED');
  }
  function check() {
    if (unavailable()) {
      if (inFlight) inFlight.complete(code);
      return Promise.resolve(snapshot());
    }
    if (inFlight) return inFlight.bounded;
    code = 'PROVIDER_CHECKING';
    const current = {generation: ++generation, done: false};
    current.bounded = new Promise(resolve => {
      current.complete = resultCode => {
        if (current.done) return;
        current.done = true;
        clearTimer(current.timer);
        if (!unavailable() && current.generation === generation) code = resultCode;
        resolve(snapshot());
      };
      current.timer = setTimer(() => current.complete('PROVIDER_TIMEOUT'), timeoutMs);
    });
    inFlight = current;
    const native = Promise.resolve().then(() => {
      if (unavailable()) return;
      return probe();
    });
    void native.then(() => current.complete('PROVIDER_READY'), error => current.complete(classifyProviderFailure(error)))
      .finally(() => {if (inFlight === current) inFlight = undefined;});
    return current.bounded;
  }
  function stop() {
    stopped = true;
    unavailable();
    if (inFlight) inFlight.complete('BRIDGE_STOPPED');
  }
  return {check, snapshot, stop};
}

function streamEndpointError(cause) {
  const text = String(cause?.message || '');
  let code;
  if (cause?.code === 'MAPPING_TIMEOUT' || cause?.name === 'TunnelTermMappingTimeout') {
    code = 'MAPPING_TIMEOUT';
  } else if (cause?.code === 'COMMAND_NOT_FOUND' || /command\s+['"]?tunnelterm\.streamEndpoint['"]?\s+(?:not found|does not exist)/i.test(text)) {
    code = 'COMPANION_UNAVAILABLE';
  } else {
    const providerCode = classifyProviderFailure(cause);
    if (providerCode !== 'PROVIDER_FAILED') code = providerCode;
    else if (/port mapping|native endpoint|temporary mapping/i.test(text)) {
      code = 'MAPPING_UNAVAILABLE';
    } else code = 'ENDPOINT_FAILED';
  }
  const safe = publicStreamEndpointFailure({code});
  return Object.assign(new Error(safe.error), {code: safe.code, next_action: safe.next_action});
}

exports.createRemoteHealthProbe = createRemoteHealthProbe;
exports.classifyProviderFailure = classifyProviderFailure;
exports.publicHealth = publicHealth;
exports.streamEndpointError = streamEndpointError;
exports.publicStreamEndpointFailure = publicStreamEndpointFailure;
