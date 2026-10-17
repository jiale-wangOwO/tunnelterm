import {listInstances, selectInstance, sendRequest, encodeRemoteUri} from '../src/client-core.mjs';
import {randomUUID} from 'node:crypto';
const target = process.argv[2];
const isolated = process.argv[3] === '--isolated';
if (!target || (process.argv[3] && !isolated)) throw new Error('Usage: node scripts/create-service-workspace.mjs EXISTING_WORKSPACE_TARGET [--isolated]');
const instance = selectInstance(await listInstances(), target);
const python = `from pathlib import Path
p=Path.home()/'.cache'/'tunnelterm'/'ssh-service'
${isolated ? `p=p/'isolated-${randomUUID()}'` : ''}
p.mkdir(mode=0o700,parents=True,exist_ok=True)
if any(p.iterdir()): raise RuntimeError('Service workspace is not empty; refusing to open possible work files')
print(str(p))
`;
const command = `python3 -c 'exec(__import__("base64").b64decode("${Buffer.from(python).toString('base64')}"))'`;
const response = await sendRequest(instance, {op: 'exec', command, timeout_seconds: 5}, 20_000);
if (response.exit_code !== 0) throw new Error('Could not prepare an empty private service workspace');
const remotePath = Buffer.from(response.stdout_base64 || '', 'base64').toString().trim();
console.log(encodeRemoteUri(instance.tunnel, remotePath));
