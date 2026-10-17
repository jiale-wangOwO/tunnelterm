'use strict';
const vscode = require('vscode');
const {startBroker} = require('./broker.cjs');
const LISTEN_PORT_KEY = 'tunnelterm.streamListenPort';

async function startWorkspaceBroker(workspaceState, getBootstrapPort = () => 0) {
  const savedPort = workspaceState.get(LISTEN_PORT_KEY);
  if (savedPort !== undefined && (!Number.isInteger(savedPort) || savedPort < 1 || savedPort > 65535)) {
    throw new Error('Saved TunnelTerm broker port is invalid; refusing to allocate a replacement port');
  }
  let listenPort = savedPort;
  if (listenPort === undefined) {
    listenPort = getBootstrapPort();
    if (!Number.isInteger(listenPort) || (listenPort !== 0 && (listenPort < 1024 || listenPort > 65535))) {
      throw new Error('TunnelTerm bootstrapPort must be 0 or an integer from 1024 to 65535; refusing to allocate a replacement port');
    }
  }
  // A new random listener on every extension-host restart leaves stale cloud
  // mappings behind. Reuse this workspace's port, but never take it from a
  // different listener or silently allocate another one if it is occupied.
  const active = await startBroker({listenPort});
  try {
    // Persist only the bound port. Authentication and generation remain fresh
    // in-memory values for each broker and must not enter workspace storage.
    await workspaceState.update(LISTEN_PORT_KEY, active.port);
  } catch (error) {
    try {await active.close();} catch (closeError) {
      throw new AggregateError([error, closeError], 'Could not save TunnelTerm broker port or close the owned broker');
    }
    throw new Error('Could not save TunnelTerm broker port; the owned broker was closed', {cause: error});
  }
  return active;
}

function activate(context) {
  let broker;
  let disposed = false;
  let mapping;
  let stop;
  const stopped = new Promise(resolve => {stop = resolve;});
  const stoppedError = stopped.then(() => {throw new Error('TunnelTerm SSH Stream is stopped');});
  void stoppedError.catch(() => {});
  context.subscriptions.push(vscode.commands.registerCommand('tunnelterm.streamEndpoint', async (options = {}) => {
    if (!vscode.workspace.isTrusted || vscode.env.remoteName !== 'tunnel') {
      throw new Error('TunnelTerm SSH Stream requires a trusted Remote Tunnel workspace');
    }
    if (disposed) throw new Error('TunnelTerm SSH Stream is stopped');
    // Share startup, but only a rejection of this specific startup may reset it.
    // URI resolution is per request; it does not own the shared broker/streams.
    const pending = broker ??= Promise.resolve().then(() => startWorkspaceBroker(context.workspaceState, () =>
      vscode.workspace.getConfiguration('tunneltermStream', vscode.workspace.workspaceFolders?.[0]?.uri).get('bootstrapPort', 0)));
    let active;
    try {
      active = await Promise.race([pending, stoppedError]);
    } catch (error) {
      if (broker === pending) broker = undefined;
      throw error;
    }
    if (disposed) throw new Error('TunnelTerm SSH Stream is stopped');
    // This must run in the remote workspace extension host. In a UI extension,
    // asExternalUri is a no-op and would incorrectly target local loopback.
    if (!mapping || mapping.generation !== active.generation) {
      const current = {generation: active.generation};
      const native = Promise.resolve().then(() => vscode.env.asExternalUri(vscode.Uri.parse(`http://127.0.0.1:${active.port}/ssh`)));
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('VS Code port mapping did not finish before its deadline; the same native mapping is still pending');
          error.name = 'TunnelTermMappingTimeout';
          error.code = 'MAPPING_TIMEOUT';
          reject(error);
        }, Math.max(10, Math.min(4000, Number(options.mapping_timeout_ms) || 3000)));
      });
      current.bounded = Promise.race([native, deadline, stoppedError]).finally(() => clearTimeout(timer));
      // A public API without cancellation may remain stuck after our deadline.
      // Retain that one operation so retries do not create additional native
      // waits. Once it settles, a later call resolves a fresh URI normally.
      void native.then(() => {if (mapping === current) mapping = undefined;},
        () => {if (mapping === current) mapping = undefined;});
      mapping = current;
    }
    const uri = await mapping.bounded;
    if (disposed) throw new Error('TunnelTerm SSH Stream is stopped');
    return {protocol: 1, uri: uri.toString(true), token: active.token, generation: active.generation,
      brokerPort: active.port, portPersistence: 'workspace'};
  }));
  context.subscriptions.push({dispose() {
    if (disposed) return;
    disposed = true;
    stop();
    const owned = broker;
    broker = undefined;
    if (owned) void owned.then(item => item.close()).catch(() => {});
  }});
}
module.exports = {activate, deactivate() {}};
