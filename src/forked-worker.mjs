import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {STREAM_FAILURE_CODES, safeStartupFailureFields} from './stream-errors.mjs';

// Loading a backend in an owned child makes refresh use current on-disk code,
// while the stable listener and already-pinned workers continue uninterrupted.
export function createForkedWorker(options, {launch = fork} = {}) {
  return new Promise((resolve, reject) => {
    const child = launch(fileURLToPath(new URL('./service-worker.mjs', import.meta.url)), [],
      {execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
    child.stderr.resume();
    let online = false, closed, cachedSeed, cachedSeedInvalidated;
    const pending = new Map();
    const exited = new Promise(done => child.once('exit', done));
    const cachedState = () => ({seed: cachedSeed, seedInvalidated: cachedSeedInvalidated});
    const routeSeedState = () => {
      if (!child.connected) return Promise.resolve(cachedState());
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {pending.delete(id); resolve(cachedState());}, 1000);
        pending.set(id, {resolve: state => {
          clearTimeout(timer); cachedSeed = state.seed;
          if (typeof state.seedInvalidated === 'boolean') cachedSeedInvalidated = state.seedInvalidated;
          resolve(cachedState());
        }, reject: error => {clearTimeout(timer); reject(error);}});
        try {child.send({type: 'seed', id});}
        catch (error) {pending.delete(id); clearTimeout(timer); reject(error);}
      });
    };
    child.on('error', () => {if (!online) reject(new Error('Owned transport worker failed to start'));});
    child.on('exit', () => {
      if (!online) reject(new Error('Owned transport worker exited before readiness'));
      for (const {reject} of pending.values()) reject(new Error('Transport worker disconnected'));
      pending.clear();
    });
    child.on('message', message => {
      if (message?.type === 'online' && Number.isInteger(message.port) && message.port > 0 && !online) {
        online = true;
        resolve({port: message.port, pid: child.pid,
          routeSeed: async () => (await routeSeedState()).seed,
          routeSeedState,
          close: () => closed ??= (async () => {
            if (child.connected) child.send({type: 'stop'});
            await exited;
          })(),
        });
      } else if (message?.type === 'seed' && typeof message.id === 'string') {
        const request = pending.get(message.id); pending.delete(message.id);
        request?.resolve({seed: message.seed, seedInvalidated: typeof message.seedInvalidated === 'boolean' ? message.seedInvalidated : undefined});
      } else if (message?.type === 'failed' && !online) {
        const error = new Error('Transport dependency is unavailable');
        error.code = STREAM_FAILURE_CODES.includes(message.code) ? message.code : 'ROUTE_UNAVAILABLE';
        Object.assign(error, safeStartupFailureFields(message));
        error.seedInvalidated = message.seedInvalidated === true;
        reject(error);
      }
    });
    child.send({type: 'start', target: options.target, seed: options.seed});
  });
}
