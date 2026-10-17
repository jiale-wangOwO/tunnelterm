import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {writeFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {serviceCommand, serviceNextAction} from '../src/service-cli.mjs';

test('advice distinguishes bounded pending recovery from permanent or human-action failures', () => {
  assert.equal(serviceNextAction({phase: 'starting', updating: true, last_failure: {code: 'CLI_FAILED'}}), 'wait_for_recovery_then_status');
  assert.equal(serviceNextAction({phase: 'ready', accepting_new: true, updating: true}), 'connect_ssh');
  assert.equal(serviceNextAction({phase: 'offline', updating: false, last_failure: {code: 'AUTH_REQUIRED'}}), 'human_official_login');
  assert.equal(serviceNextAction({phase: 'offline', last_failure: {code: 'CLI_FAILED'}}), 'inspect_cli_diagnostics');
  assert.equal(serviceNextAction({phase: 'unreachable'}), 'inspect_original_service_owner');
  assert.equal(serviceNextAction({phase: 'draining'}), 'wait_for_connections_to_drain');
  assert.equal(serviceNextAction({phase: 'offline', last_failure: {code: 'MAPPING_UNAVAILABLE', detail: 'MAPPING_TIMEOUT'}}), 'reload_selected_workspace');
  assert.equal(serviceNextAction({phase: 'offline', last_failure: {next_action: 'DO_NOT_TRUST_ME'}}), 'inspect_status_and_owned_service_window');
});

// Only temporary files and injected lifecycle controls: no CLI, daemon, socket,
// scheduled task, bridge, network, or remote session is started by these tests.
async function fixture(t, configPatch = {}, withRuntime = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tunnelterm-maintenance-fake-'));
  const previousHome = process.env.TUNNELTERM_SERVICE_HOME;
  const previousExitCode = process.exitCode;
  const previousLog = console.log;
  process.env.TUNNELTERM_SERVICE_HOME = root;
  process.exitCode = undefined;
  const output = [];
  console.log = value => output.push(JSON.parse(value));
  t.after(async () => {
    console.log = previousLog;
    process.exitCode = previousExitCode;
    if (previousHome === undefined) delete process.env.TUNNELTERM_SERVICE_HOME;
    else process.env.TUNNELTERM_SERVICE_HOME = previousHome;
    await fs.rm(root, {recursive: true, force: true});
  });
  const configFile = path.join(root, 'fixture.json');
  const runtimeFile = path.join(root, 'fixture.runtime.json');
  const lockFile = path.join(root, 'fixture.maintenance.lock');
  const config = {protocol: 1, profile: 'fixture', enabled: true, target: '/fixture', port: 22222,
    custom_preserved: {nested: 'setting'}, ...configPatch};
  const runtime = {protocol: 1, pid: 999999999, service_id: 'fake-owner', control_socket: 'FAKE_NEVER_USED', control_token: 'FAKE_NEVER_USED'};
  await fs.writeFile(configFile, JSON.stringify(config));
  if (withRuntime) await fs.writeFile(runtimeFile, JSON.stringify(runtime));
  return {root, config, configFile, runtime, runtimeFile, lockFile, output,
    command: (action, control, waitMs = 100) => serviceCommand([action, '--profile', 'fixture', '--wait-ms', String(waitMs)], {control})};
}

test('maintenance never re-enables an intentionally disabled profile, with or without an owner', async t => {
  const f = await fixture(t, {enabled: false}, false);
  let calls = 0;
  for (const action of ['recover', 'restart']) {
    await assert.rejects(f.command(action, async () => {calls++;}), /intentionally disabled/);
  }
  await fs.writeFile(f.runtimeFile, JSON.stringify(f.runtime));
  await assert.rejects(f.command('recover', async () => {calls++;}), /intentionally disabled/);
  assert.equal(calls, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(f.configFile)), f.config);
  assert.equal((await fs.readdir(f.root)).includes('fixture.maintenance.lock'), false);
});

test('restart refuses active leases without stopping or changing configuration', async t => {
  const f = await fixture(t);
  const actions = [];
  await assert.rejects(f.command('restart', async (_runtime, action) => {
    actions.push(action);
    return {phase: 'recovering', active_connections: 1};
  }), /Restart refused/);
  assert.deepEqual(actions, ['status']);
  assert.deepEqual(JSON.parse(await fs.readFile(f.configFile)), f.config);
  await assert.rejects(fs.stat(f.lockFile), {code: 'ENOENT'});
});

test('restart refuses an unauthenticated owner and never acts on its recorded PID', async t => {
  const f = await fixture(t);
  const actions = [];
  await assert.rejects(f.command('restart', async (_runtime, action) => {
    actions.push(action); throw new Error('fixture authentication failed');
  }), /Cannot authenticate.*refusing to kill a PID/);
  assert.deepEqual(actions, ['status']);
  assert.deepEqual(JSON.parse(await fs.readFile(f.configFile)), f.config);
  await assert.rejects(fs.stat(f.lockFile), {code: 'ENOENT'});
});

test('restart restores exact configuration when the daemon rejects a new lease race', async t => {
  const f = await fixture(t);
  const actions = [];
  await assert.rejects(f.command('restart', async (_runtime, action) => {
    actions.push(action);
    if (action === 'status') return {phase: 'recovering', active_connections: 0};
    assert.equal(action, 'stop');
    assert.equal(JSON.parse(await fs.readFile(f.configFile)).enabled, false);
    throw new Error('Active SSH connections exist; use drain instead of stop');
  }), /Active SSH connections/);
  assert.deepEqual(actions, ['status', 'stop']);
  assert.deepEqual(JSON.parse(await fs.readFile(f.configFile)), f.config);
  await assert.rejects(fs.stat(f.lockFile), {code: 'ENOENT'});
});

test('restart preserves a replacement owner instead of stopping it after ownership changes', async t => {
  const f = await fixture(t);
  const actions = [];
  await assert.rejects(f.command('restart', async (_runtime, action) => {
    actions.push(action);
    if (action === 'status') return {phase: 'recovering', active_connections: 0};
    await fs.writeFile(f.runtimeFile, JSON.stringify({...f.runtime, service_id: 'new-owner'}));
    return {phase: 'stopped'};
  }), /ownership changed/);
  assert.deepEqual(actions, ['status', 'stop']);
  assert.equal(JSON.parse(await fs.readFile(f.runtimeFile)).service_id, 'new-owner');
  assert.deepEqual(JSON.parse(await fs.readFile(f.configFile)), f.config);
});

test('a pre-existing maintenance lock is neither bypassed nor removed', async t => {
  const f = await fixture(t);
  const lock = JSON.stringify({pid: 999999998, nonce: 'another-cli'});
  await fs.writeFile(f.lockFile, lock);
  let calls = 0;
  await assert.rejects(f.command('restart', async () => {calls++;}), /maintenance already locked/);
  assert.equal(calls, 0);
  assert.equal(await fs.readFile(f.lockFile, 'utf8'), lock);
  assert.deepEqual(JSON.parse(await fs.readFile(f.configFile)), f.config);
});

test('restart timeout restores configuration and never substitutes a forced PID kill', async t => {
  const f = await fixture(t);
  const actions = [];
  await assert.rejects(f.command('restart', async (_runtime, action) => {
    actions.push(action);
    return {phase: action === 'stop' ? 'stopped' : 'recovering', active_connections: 0};
  }, 20), /Clean shutdown did not finish.*no PID was force-killed/);
  assert.deepEqual(actions, ['status', 'stop']);
  assert.deepEqual(JSON.parse(await fs.readFile(f.runtimeFile)), f.runtime);
  assert.deepEqual(JSON.parse(await fs.readFile(f.configFile)), f.config);
  await assert.rejects(fs.stat(f.lockFile), {code: 'ENOENT'});
});

test('recover reports a bounded failed check as not ready and preserves its configuration', async t => {
  const f = await fixture(t);
  const actions = [];
  await f.command('recover', async (_runtime, action, timeout) => {
    actions.push(action);
    assert.ok(timeout > 0 && timeout <= 100);
    if (action === 'check') throw new Error('fixture timeout');
    return {phase: 'recovering', accepting_new: false, active_connections: 0, last_failure: {code: 'NETWORK_UNAVAILABLE'}};
  });
  assert.deepEqual(actions, ['status', 'check', 'status']);
  assert.equal(f.output.at(-1).outcome, 'not_ready');
  assert.equal(f.output.at(-1).next_action, 'check_network_then_recover');
  assert.equal(process.exitCode, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(f.configFile)), f.config);
});

test('ready phase without an accepting listener never recommends SSH or reports success', async t => {
  const f = await fixture(t);
  await f.command('recover', async () => ({phase: 'ready', accepting_new: false, active_connections: 0}));
  assert.equal(f.output.at(-1).outcome, 'not_ready');
  assert.notEqual(f.output.at(-1).next_action, 'connect_ssh');
  assert.equal(process.exitCode, 1);
});

test('start on an existing offline owner reports failure instead of success', async t => {
  const f = await fixture(t);
  await f.command('start', async () => ({phase: 'offline', accepting_new: false, target: '/fixture', port: 22222}));
  assert.equal(f.output.at(-1).outcome, 'not_ready');
  assert.notEqual(f.output.at(-1).next_action, 'connect_ssh');
  assert.equal(process.exitCode, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(f.configFile)), {...f.config, health_interval_ms: 30000});
});

function fakeDaemon(f, events) {
  const child = new EventEmitter();
  child.pid = 888888888; child.exitCode = null; child.unref = () => {};
  child.kill = () => {throw new Error('Fake daemon must never be force-killed');};
  return {child, launch: (_executable, args, options) => {
    events.push('direct_launch');
    assert.equal(options.windowsHide, true); assert.equal(options.detached, true);
    assert.equal(options.stdio[0], 'ignore');
    assert.equal(args.includes('--direct'), false, 'direct selects launch context, never changes the daemon CLI');
    writeFileSync(f.runtimeFile, JSON.stringify({...f.runtime, pid: child.pid, service_id: 'direct-owner'}));
    return child;
  }};
}

test('direct is valid only on start and restart, before any owner operation', async () => {
  for (const action of ['recover', 'run', 'status', 'check', 'refresh', 'stop', 'drain']) {
    await assert.rejects(serviceCommand([action, '--profile', 'fixture', '--direct'], {
      control: async () => {throw new Error('No owner must be contacted');},
      launch: () => {throw new Error('No daemon must be launched');},
      wake: async () => {throw new Error('No watcher must be woken');},
    }), /--direct is allowed only with start or restart/);
  }
});

test('direct start preserves scheduler configuration and wakes its watcher only after ready', async t => {
  const f = await fixture(t, {scheduler_task: 'TunnelTerm-fixture', health_interval_ms: 30000}, false);
  const original = await fs.readFile(f.configFile, 'utf8');
  const events = [], {launch, child} = fakeDaemon(f, events);
  await serviceCommand(['start', '--profile', 'fixture', '--direct', '--wait-ms', '1000'], {
    launch,
    control: async runtime => {
      assert.equal(runtime.pid, child.pid); events.push('direct_ready');
      return {phase: 'ready', accepting_new: true, pid: child.pid, target: f.config.target, port: f.config.port};
    },
    wake: async (_profile, config) => {
      events.push('adopt'); assert.deepEqual(config, f.config);
      assert.equal(JSON.parse(await fs.readFile(f.runtimeFile)).pid, child.pid);
      return true;
    },
  });
  assert.deepEqual(events, ['direct_launch', 'direct_ready', 'adopt']);
  assert.equal(await fs.readFile(f.configFile, 'utf8'), original);
  assert.equal(f.output.at(-1).outcome, 'ready');
  assert.equal(f.output.at(-1).supervisor, 'adopting');
  assert.equal(process.exitCode, undefined);
});

test('direct restart retains authentication, old-watcher release and clean ownership handoff', async t => {
  const f = await fixture(t, {scheduler_task: 'TunnelTerm-fixture', health_interval_ms: 30000});
  const original = await fs.readFile(f.configFile, 'utf8');
  const events = [], {launch, child} = fakeDaemon(f, events);
  await serviceCommand(['restart', '--profile', 'fixture', '--direct', '--wait-ms', '1000'], {
    launch,
    control: async (runtime, action) => {
      if (runtime.pid === f.runtime.pid) {
        events.push(action);
        if (action === 'stop') {
          assert.equal(JSON.parse(await fs.readFile(f.configFile)).enabled, false);
          await fs.unlink(f.runtimeFile); return {phase: 'stopped'};
        }
        return {phase: 'recovering', active_connections: 0};
      }
      assert.equal(runtime.pid, child.pid); events.push('direct_ready');
      return {phase: 'ready', accepting_new: true, pid: child.pid, target: f.config.target, port: f.config.port};
    },
    waitSupervisor: async (_profile, config) => {
      events.push('watcher_release'); assert.deepEqual(config, f.config);
      assert.equal(JSON.parse(await fs.readFile(f.configFile)).enabled, false);
    },
    wake: async (_profile, config) => {events.push('adopt'); assert.deepEqual(config, f.config); return true;},
  });
  assert.deepEqual(events, ['status', 'stop', 'watcher_release', 'direct_launch', 'direct_ready', 'adopt']);
  assert.equal(await fs.readFile(f.configFile, 'utf8'), original);
  await assert.rejects(fs.stat(f.lockFile), {code: 'ENOENT'});
  assert.equal(f.output.at(-1).operation, 'restart');
  assert.equal(f.output.at(-1).outcome, 'ready');
});

test('default scheduler start still uses its existing watcher without a direct daemon', async t => {
  const f = await fixture(t, {scheduler_task: 'TunnelTerm-fixture', health_interval_ms: 30000}, false);
  const events = [];
  await serviceCommand(['start', '--profile', 'fixture', '--wait-ms', '1000'], {
    launch: () => {throw new Error('Default scheduler start must not spawn another daemon');},
    wake: async () => {events.push('wake'); await fs.writeFile(f.runtimeFile, JSON.stringify(f.runtime)); return true;},
    control: async () => {events.push('ready'); return {phase: 'ready', accepting_new: true};},
  });
  assert.deepEqual(events, ['wake', 'ready']);
  assert.deepEqual(JSON.parse(await fs.readFile(f.configFile)), f.config);
});

test('direct fallback remains honest on failure, with no watcher wake or force-kill', async t => {
  const f = await fixture(t, {scheduler_task: 'TunnelTerm-fixture', health_interval_ms: 30000}, false);
  const events = [], {launch} = fakeDaemon(f, events);
  await serviceCommand(['start', '--profile', 'fixture', '--direct', '--wait-ms', '20'], {
    launch,
    control: async () => ({phase: 'offline', accepting_new: false, last_failure: {code: 'CLI_FAILED'}}),
    wake: async () => {throw new Error('Offline fallback must not wake a supervisor');},
  });
  assert.deepEqual(events, ['direct_launch']);
  assert.equal(f.output.at(-1).outcome, 'not_ready');
  assert.equal(process.exitCode, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(f.configFile)), f.config);
});

test('direct cannot bypass active leases or an intentionally disabled restart', async t => {
  const f = await fixture(t);
  const events = [];
  const options = {
    control: async () => {events.push('status'); return {phase: 'recovering', active_connections: 1};},
    launch: () => {throw new Error('Unsafe launch');},
    wake: async () => {throw new Error('Unsafe watcher wake');},
  };
  await assert.rejects(serviceCommand(['restart', '--profile', 'fixture', '--direct'], options), /Restart refused/);
  assert.deepEqual(events, ['status']);
  await fs.writeFile(f.configFile, JSON.stringify({...f.config, enabled: false}));
  await assert.rejects(serviceCommand(['restart', '--profile', 'fixture', '--direct'], options), /intentionally disabled/);
  assert.deepEqual(events, ['status']);
});
