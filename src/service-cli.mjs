import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import net from 'node:net';
import os from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {atomicWrite, stateRoot, takeFlag, takeOption} from './client-core.mjs';
import {startManagedService, startServiceControl} from './managed-service.mjs';
import {safeStartupFailureFields} from './stream-errors.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const isReady = status => status?.phase === 'ready' && status.accepting_new === true;
export function serviceNextAction(status) {
  if (isReady(status)) return 'connect_ssh';
  // A deadline-limited CLI observation is not a request to restart an owner
  // which is still warming. Its eventual readiness must be checked separately.
  if (status?.updating === true) return 'wait_for_recovery_then_status';
  if (status?.phase === 'draining' || status?.phase === 'stopping') return 'wait_for_connections_to_drain';
  if (status?.phase === 'stopped') return status.configured ? 'recover_profile' : 'configure_profile';
  if (status?.phase === 'unreachable') return 'inspect_original_service_owner';
  const endpointAction = safeStartupFailureFields(status?.last_failure).next_action;
  if (endpointAction) return endpointAction;
  return ({AUTH_REQUIRED: 'human_official_login', CLI_UNAVAILABLE: 'install_official_cli',
    NETWORK_UNAVAILABLE: 'check_network_then_recover', CLI_FAILED: 'inspect_cli_diagnostics', BRIDGE_UNAVAILABLE: 'open_owned_service_window',
    MAPPING_UNAVAILABLE: 'check_owned_service_window', CANCELLED: 'retry_recover'}[status?.last_failure?.code] || 'inspect_status_and_owned_service_window');
}
const withAdvice = status => ({...status, recovery_pending: status?.updating === true, next_action: serviceNextAction(status)});
const publishStatus = (profile, status, operation) => {
  console.log(JSON.stringify({profile, ...withAdvice(status), operation,
    outcome: isReady(status) ? 'ready' : 'not_ready'}));
  if (!isReady(status)) process.exitCode = 1;
};

// Serializes maintenance by profile. A stale lock is never guessed away: its
// removal requires explicit operator review, not a reused-PID kill or timeout.
async function maintenanceLock(profile) {
  await fs.mkdir(directory(), {recursive: true, mode: 0o700});
  const file = path.join(directory(), `${profile}.maintenance.lock`);
  let handle;
  try {handle = await fs.open(file, 'wx', 0o600);} catch(error) {if(error.code === 'EEXIST') throw new Error('Profile maintenance already locked; inspect the owning CLI before removing a stale lock'); throw error;}
  const nonce = randomUUID();
  await handle.writeFile(JSON.stringify({pid: process.pid, nonce, created: new Date().toISOString()}));
  await handle.close();
  return async () => {const current = await readJson(file); if(current?.nonce === nonce) await fs.unlink(file);};
}

async function maintenance(action, profile, config, runtime, files, waitMs, {control, launch, wake, waitSupervisor, direct}) {
  if (!config) throw new Error('Profile is not configured; use service start with a workspace first');
  if (config.enabled === false) throw new Error('Profile is intentionally disabled; use start to explicitly enable it before maintenance');
  const unlock = await maintenanceLock(profile);
  const deadline = Date.now() + waitMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  const start = () => serviceCommand(['start', '--profile', profile, '--wait-ms', String(remaining()), ...(direct ? ['--direct'] : [])],
    {operation: action, control, launch, wake, waitSupervisor});
  let paused = false;
  try {
    if (!runtime) {await start(); return;}
    let before;
    try {before = await control(runtime, 'status', Math.min(1000, remaining()));}
    catch {throw new Error('Cannot authenticate the profile owner; refusing to kill a PID or replace an unreachable service');}
    if (action === 'recover') {
      let result;
      try {result = await control(runtime, 'check', remaining());} catch {}
      result ||= await control(runtime, 'status', Math.min(1000, remaining()));
      publishStatus(profile, result, action);
      return;
    }
    if (before.active_connections !== 0 || ['draining', 'stopping', 'starting'].includes(before.phase)) throw new Error('Restart refused: active connections or an in-progress lifecycle; disconnect displays or wait, then retry');
    // Prevent the independent watcher from racing intentional shutdown. The
    // authenticated daemon rechecks leases atomically inside stop as well.
    await atomicWrite(files.config, {...config, enabled: false});
    paused = true;
    try {await control(runtime, 'stop', remaining());}
    catch(error) {await atomicWrite(files.config, config); paused = false; throw error;}
    let gone = false;
    while (Date.now() < deadline) {
      const current = await readJson(files.runtime);
      if (!current) {gone = true; break;}
      if (current.service_id !== runtime.service_id) throw new Error('Profile ownership changed during restart; no new owner was stopped');
      await delay(100);
    }
    if (!gone) throw new Error('Clean shutdown did not finish within budget; no PID was force-killed');
    await waitSupervisor(profile, config, remaining());
    await atomicWrite(files.config, config);
    paused = false;
    if (Date.now() >= deadline) throw new Error('Restart preparation used its budget; service remains stopped, use recover');
    await start();
  } finally {
    try {
      if (paused && JSON.stringify(await readJson(files.config)) === JSON.stringify({...config, enabled: false})) await atomicWrite(files.config, config);
    } finally {await unlock();}
  }
}
async function waitSupervisorRelease(profile, config, timeout) {
  if (process.platform !== 'win32' || !config.scheduler_task) return;
  // The direct fallback also waits: no existing watcher may race shutdown.
  const task = config.scheduler_task;
  if (task !== `TunnelTerm-${profile}`) throw new Error('Unverified scheduled supervisor');
  const command = `$task=Get-ScheduledTask -TaskName '${task}' -ErrorAction Stop; if($task.Description -ne 'TunnelTerm managed service: ${profile}' -or $task.Principal.RunLevel -ne 'Limited'){throw 'Unverified supervisor'}; $limit=(Get-Date).AddMilliseconds(${Math.min(15000, timeout)}); while($task.State -eq 'Running' -and (Get-Date) -lt $limit){Start-Sleep -Milliseconds 200; $task=Get-ScheduledTask -TaskName '${task}'}; if($task.State -eq 'Running'){throw 'Supervisor is still releasing ownership'}`;
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', command], {windowsHide: true, timeout: Math.min(16000, timeout)});
}
async function wakeSupervisor(profile, config, timeout = 10000) {
  if (process.platform !== 'win32' || config.scheduler_task !== `TunnelTerm-${profile}`) return false;
  const command = `$task=Get-ScheduledTask -TaskName 'TunnelTerm-${profile}' -ErrorAction Stop; if($task.Description -ne 'TunnelTerm managed service: ${profile}' -or $task.Principal.RunLevel -ne 'Limited'){throw 'Unverified supervisor'}; Start-ScheduledTask -TaskName 'TunnelTerm-${profile}'`;
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', command], {windowsHide: true, timeout});
  return true;
}
const profileName = value => {
  if (!/^[a-zA-Z0-9_-]{1,48}$/.test(value) || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(value)) throw new Error('Invalid service profile name');
  return value;
};
const directory = () => process.env.TUNNELTERM_SERVICE_HOME ? path.resolve(process.env.TUNNELTERM_SERVICE_HOME) :
  process.platform === 'win32' && !process.env.TUNNELTERM_HOME ? path.join(os.homedir(), '.tunnelterm', 'services') : path.join(stateRoot(), 'services');
const filesFor = profile => ({config: path.join(directory(), `${profile}.json`), runtime: path.join(directory(), `${profile}.runtime.json`),
  route: path.join(directory(), `${profile}.route.json`), log: path.join(directory(), `${profile}.log`)});
const socketFor = profile => {
  const namespace = createHash('sha256').update(`${path.resolve(directory()).toLowerCase()}|${profile.toLowerCase()}`).digest('hex').slice(0, 32);
  return process.platform === 'win32' ? `\\\\.\\pipe\\tunnelterm-${namespace}` : path.join(directory(), `control-${namespace}.sock`);
};
async function readJson(file) {try {return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));} catch (error) {if (error.code === 'ENOENT') return undefined; throw error;}}

export async function controlService(runtime, action = 'status', timeout = 45000) {
  if (!runtime || runtime.protocol !== 1 ||
      (!runtime.control_socket && (!Number.isInteger(runtime.control_port) || runtime.control_port < 1 || runtime.control_port > 65535)) ||
      typeof runtime.control_token !== 'string') throw new Error('Service is not running');
  const result = await new Promise((resolve, reject) => {
    const request = http.request({...runtime.control_socket ? {socketPath: runtime.control_socket} : {hostname: '127.0.0.1', port: runtime.control_port}, path: `/${action}`,
      method: action === 'status' ? 'GET' : 'POST', headers: {'x-tunnelterm-control': runtime.control_token}, agent: false}, response => {
      let body = '';
      response.on('data', chunk => {body += chunk; if (body.length > 65536) request.destroy(new Error('Invalid control response'));});
      response.on('end', () => {
        try {
          const value = JSON.parse(body);
          if (response.statusCode !== 200) throw new Error(value.error || 'Service control refused');
          resolve(value);
        } catch (error) {reject(error);}
      });
    });
    const deadline = setTimeout(() => request.destroy(new Error('Service control exceeded its total budget')), timeout);
    request.once('close', () => clearTimeout(deadline));
    request.once('error', reject); request.end();
  });
  if (result.service_id !== runtime.service_id || result.pid !== runtime.pid) throw new Error('Service control identity mismatch');
  return result;
}

async function run(profile, config, files, bootstrapRoute) {
  const serviceId = randomUUID();
  let service;
  const socketPath = socketFor(profile);
  await fs.mkdir(directory(), {recursive: true, mode: 0o700});
  if (process.platform !== 'win32') {
    // Reclaim only our exact stale IPC socket, and only ECONNREFUSED/ENOENT.
    // A timeout, authenticated error, or a live socket must never be removed.
    const stat = await fs.lstat(socketPath).catch(error => {if (error.code === 'ENOENT') return undefined; throw error;});
    if (stat) {
      if (!stat.isSocket()) throw new Error('Control path is not an owned IPC socket');
      const refused = await new Promise(resolve => {
        const socket = net.createConnection(socketPath);
        const timer = setTimeout(() => {socket.destroy(); resolve(false);}, 1000);
        socket.once('connect', () => {clearTimeout(timer); socket.destroy(); resolve(false);});
        socket.once('error', error => {clearTimeout(timer); resolve(['ECONNREFUSED', 'ENOENT'].includes(error.code));});
      });
      const latest = await fs.lstat(socketPath).catch(() => undefined);
      if (!refused || !latest || latest.ino !== stat.ino) throw new Error('Another service owns this profile control socket');
      await fs.unlink(socketPath);
    }
  }
  const starting = () => ({protocol: 1, service_id: serviceId, pid: process.pid, target: config.target, port: config.port, phase: 'starting'});
  const requireService = () => {if (!service) throw new Error('Service is starting'); return service;};
  // The fixed private IPC endpoint is also the exclusive profile owner. It is
  // claimed before configuration/runtime writes or opening the front door.
  const control = await startServiceControl({status: () => service?.status() || starting(),
    check: () => requireService().check(), refresh: () => requireService().refresh(),
    drain: () => requireService().drain(), stop: () => requireService().stop()}, {socketPath});
  const runtime = {protocol: 1, service_id: serviceId, pid: process.pid,
    started: new Date().toISOString(), control_socket: control.socketPath, control_token: control.token};
  let stopRequested = false;
  const shutdown = () => {stopRequested = true; if (service) void service.close();};
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown); process.once('SIGHUP', shutdown);
  try {
    await atomicWrite(files.runtime, runtime);
    if (bootstrapRoute) await atomicWrite(files.route, bootstrapRoute);
    const savedRoute = await readJson(files.route);
    service = await startManagedService({target: config.target, port: config.port, serviceId, seed: savedRoute?.target === config.target ? savedRoute.seed : undefined,
      saveSeed: seed => atomicWrite(files.route, {protocol: 1, target: config.target, verified: new Date().toISOString(), seed}),
      healthInterval: config.health_interval_ms, log: event => process.stderr.write(`${JSON.stringify(event)}\n`)});
    await atomicWrite(files.config, config);
    if (stopRequested) await service.close();
    await service.closed;
  }
  finally {
    if (service) await service.close();
    await control.close();
    const latest = await readJson(files.runtime);
    if (latest?.service_id === runtime.service_id) await fs.unlink(files.runtime).catch(() => {});
    process.off('SIGTERM', shutdown); process.off('SIGINT', shutdown); process.off('SIGHUP', shutdown);
  }
}

export async function serviceCommand(args, {operation, control = controlService, launch = spawn, wake = wakeSupervisor, waitSupervisor = waitSupervisorRelease} = {}) {
  const action = args.shift();
  operation ||= action;
  const profile = profileName(takeOption(args, '--profile') || 'default');
  const target = takeOption(args, '--target', '-t');
  const requestedPort = takeOption(args, '--port', '-p');
  const fromProfile = takeOption(args, '--from-profile');
  const direct = takeFlag(args, '--direct');
  const waitOption = takeOption(args, '--wait-ms');
  const waitMs = waitOption === undefined ? 45000 : Number(waitOption);
  if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > 60000 || (waitOption && !['start', 'recover', 'restart'].includes(action))) throw new Error('Invalid --wait-ms (1..60000, start/recover/restart only)');
  if (direct && !['start', 'restart'].includes(action)) throw new Error('--direct is allowed only with start or restart');
  if (args.length || !['start', 'run', 'status', 'check', 'refresh', 'drain', 'stop', 'recover', 'restart'].includes(action)) throw new Error('Usage: tunnelterm service start|status|recover|restart|check|refresh|drain|stop --profile NAME [-t WORKSPACE] [--port PORT] [--direct (start/restart only)]');
  if (!['start', 'run'].includes(action) && (target || requestedPort || fromProfile)) throw new Error('Control operations do not change targets or ports');
  const files = filesFor(profile);
  let config = await readJson(files.config);
  let runtime = await readJson(files.runtime);
  if (['recover', 'restart'].includes(action)) {await maintenance(action, profile, config, runtime, files, waitMs, {control, launch, wake, waitSupervisor, direct}); return;}
  if (action === 'status') {
    if (!runtime) {console.log(JSON.stringify({profile, ...withAdvice({phase: 'stopped', configured: !!config})})); return;}
    try {console.log(JSON.stringify({profile, ...withAdvice(await control(runtime))}));}
    catch {console.log(JSON.stringify({profile, ...withAdvice({phase: 'unreachable', configured: !!config})})); process.exitCode = 1;}
    return;
  }
  if (!['start', 'run'].includes(action)) {
    if (['stop', 'drain'].includes(action) && config) {
      await atomicWrite(files.config, {...config, enabled: false});
      try {console.log(JSON.stringify({profile, ...await control(runtime, action)}));}
      catch (error) {await atomicWrite(files.config, config); throw error;}
    } else console.log(JSON.stringify({profile, ...await control(runtime, action)}));
    return;
  }
  const sourceConfig = fromProfile ? await readJson(filesFor(profileName(fromProfile)).config) : undefined;
  const port = requestedPort === undefined ? (config?.port ?? 22222) : Number(requestedPort);
  const sourceRoute = fromProfile ? await readJson(filesFor(profileName(fromProfile)).route) : undefined;
  const desired = {...config, protocol: 1, profile, target: target || config?.target || sourceConfig?.target, port, enabled: true, health_interval_ms: config?.health_interval_ms ?? 30000};
  if (config && config.target !== desired.target) {delete desired.owned_workspace_uri; delete desired.vscode_cli;}
  if (!desired.target || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Service start requires a workspace target and valid port');
  if (runtime) {
    let existing;
    try {existing = await control(runtime, 'status', 1000);} catch {}
    if (existing) {
      if (action === 'run') throw new Error('This service profile is already running');
      if (existing.target !== desired.target || existing.port !== desired.port) throw new Error('Running profile differs; drain it before changing its persistent configuration');
      if (['draining', 'stopping', 'stopped'].includes(existing.phase)) throw new Error('This profile is still draining; wait for clean shutdown');
      await atomicWrite(files.config, desired);
      if (!direct) await wake(profile, desired);
      else if (isReady(existing) && desired.scheduler_task) {
        try {existing = {...existing, supervisor: await wake(profile, desired, Math.min(10000, waitMs)) ? 'adopting' : 'not_configured'};}
        catch {existing = {...existing, supervisor: 'unavailable'};}
      }
      publishStatus(profile, existing, operation); return;
    }
  }
  if (fromProfile) {
    if (!sourceRoute || sourceRoute.target !== desired.target || sourceConfig?.target !== desired.target) throw new Error('Bootstrap route must belong to the exact same configured workspace');
  }
  if (action === 'run') {
    await run(profile, desired, files, sourceRoute); return;
  }
  await fs.mkdir(directory(), {recursive: true, mode: 0o700});
  if (desired.scheduler_task && !direct) {
    await atomicWrite(files.config, desired);
    if (sourceRoute) await atomicWrite(files.route, sourceRoute);
    if (await wake(profile, desired)) {
      const deadline = Date.now() + waitMs;
      let status;
      while (Date.now() < deadline) {
        try {status = await control(await readJson(files.runtime), 'status', 1000);} catch {}
        if (isReady(status)) {publishStatus(profile, status, operation); return;}
        await delay(250);
      }
      publishStatus(profile, status || {phase: 'starting'}, operation); process.exitCode = 1; return;
    }
  }
  const logFile = await fs.open(files.log, 'a', 0o600);
  const cli = fileURLToPath(new URL('../bin/tunnelterm.mjs', import.meta.url));
  let child;
  const launchArgs = [cli, 'service', 'run', '--profile', profile, '--target', desired.target, '--port', String(desired.port)];
  if (fromProfile) launchArgs.push('--from-profile', fromProfile);
  try {child = launch(process.execPath, launchArgs, {windowsHide: true, detached: true, stdio: ['ignore', logFile.fd, logFile.fd]});}
  finally {await logFile.close();}
  child.unref();
  let launchError;
  child.once('error', error => {launchError = error;});
  const deadline = Date.now() + waitMs;
  let lastStatus;
  while (Date.now() < deadline) {
    if (launchError || child.exitCode !== null) throw new Error(`Service failed to start; inspect ${files.log}`);
    const found = await readJson(files.runtime);
    if (found?.pid === child.pid) {
      try {lastStatus = await control(found, 'status', 1000);} catch {}
      if (isReady(lastStatus)) {
        if (direct && desired.scheduler_task) {
          // A ready direct daemon already owns the profile. Wake only the
          // verified watcher to observe/adopt it, not to launch another daemon.
          try {lastStatus = {...lastStatus, supervisor: await wake(profile, desired, Math.max(1, Math.min(10000, deadline - Date.now()))) ? 'adopting' : 'not_configured'};}
          catch {lastStatus = {...lastStatus, supervisor: 'unavailable'};}
        }
        publishStatus(profile, lastStatus, operation); return;
      }
    }
    await delay(250);
  }
  // An offline service intentionally remains alive to recover; never kill it
  // merely because one dependency did not become ready in the startup budget.
  publishStatus(profile, {...(lastStatus || {phase: 'starting', pid: child.pid}), log: files.log}, operation);
  process.exitCode = 1;
}
