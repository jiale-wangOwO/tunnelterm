import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {listInstances, selectInstance, sendRequest} from '../src/client-core.mjs';

const args = process.argv.slice(2);
const install = args.includes('--install');
const target = args.find(value => !value.startsWith('--'));
const {version} = JSON.parse(await fs.readFile(new URL('../remote-stream/package.json', import.meta.url), 'utf8'));
if (!target || args.some(value => value.startsWith('--') && !['--install', '--inspect'].includes(value))) {
  throw new Error('Usage: node scripts/deploy-stream.mjs WORKSPACE_TARGET [--inspect|--install]');
}
const remotePrelude = `
import os, sys, json, platform, subprocess, hashlib, tempfile, base64, shutil
from pathlib import Path
h = Path.home()
patterns = [
    '.vscode/cli/servers/Stable-*/server/bin/remote-cli/code',
    '.vscode-cli/cli/servers/Stable-*/server/bin/remote-cli/code',
    '.vscode-server/bin/*/bin/remote-cli/code',
    '.vscode-server/cli/servers/Stable-*/server/bin/remote-cli/code',
]
candidates = sorted({p for pattern in patterns for p in h.glob(pattern)}, key=lambda p: p.stat().st_mtime, reverse=True)
def report_extensions():
    roots = {h / '.vscode-server' / 'extensions', h / '.vscode-cli' / 'extensions', h / '.vscode' / 'extensions',
        h / '.vscode' / 'cli' / 'serverextensions', h / '.vscode-cli' / 'serverextensions'}
    folder = os.environ.get('VSCODE_AGENT_FOLDER')
    if folder: roots.add(Path(folder) / 'extensions')
    found = []
    for root in roots:
        for directory in root.glob('tunnelterm.tunnelterm-stream-*'):
            manifest = directory / 'package.json'
            source = directory / 'extension.cjs'
            if manifest.is_file() and source.is_file():
                data = json.loads(manifest.read_text())
                found.append(dict(path=str(directory), version=data.get('version'),
                    extensionKind=data.get('extensionKind'),
                    sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest(),
                    brokerSha256=hashlib.sha256((directory / 'broker.cjs').read_bytes()).hexdigest()))
    return found
`;
let python = remotePrelude;
if (install) {
  const bytes = await fs.readFile(new URL(`../remote-stream/tunnelterm-stream-${version}.vsix`, import.meta.url));
  if (bytes.length > 80_000) throw new Error('VSIX is too large for this bounded bootstrap; use remote VSIX installation directly');
  const expected = createHash('sha256').update(bytes).digest('hex');
  const expectedSource = createHash('sha256').update(await fs.readFile(new URL('../remote-stream/extension.cjs', import.meta.url))).digest('hex');
  const expectedBroker = createHash('sha256').update(await fs.readFile(new URL('../remote-stream/broker.cjs', import.meta.url))).digest('hex');
  python += `
if not candidates: raise RuntimeError('No installed VS Code remote server CLI found')
remote_cli = candidates[0]
server_cli = remote_cli.parent.parent / 'code-server'
if os.environ.get('VSCODE_IPC_HOOK_CLI'): cli = remote_cli
elif server_cli.is_file(): cli = server_cli
else: raise RuntimeError('No usable remote extension installer found')
temporary = Path(tempfile.mkdtemp(prefix='tunnelterm-stream-install-'))
try:
    archive = temporary / 'tunnelterm-stream-${version}.vsix'
    payload = base64.b64decode('${bytes.toString('base64')}')
    if hashlib.sha256(payload).hexdigest() != '${expected}': raise RuntimeError('Archive checksum mismatch')
    archive.write_bytes(payload)
    archive.chmod(0o600)
    installed = subprocess.run([str(cli), '--install-extension', str(archive), '--force'],
        capture_output=True, text=True, timeout=40)
    print(json.dumps(dict(installer=str(cli), exit_code=installed.returncode,
        stdout=installed.stdout, stderr=installed.stderr)))
    if installed.returncode: sys.exit(installed.returncode)
    listed = subprocess.run([str(cli), '--list-extensions', '--show-versions'],
        capture_output=True, text=True, timeout=15)
    registered = [line for line in listed.stdout.splitlines() if 'tunnelterm.tunnelterm-stream' in line]
    files = report_extensions()
    verified = any(item['version'] == '${version}' and item['extensionKind'] == ['workspace'] and
        item['sourceSha256'] == '${expectedSource}' and item['brokerSha256'] == '${expectedBroker}' for item in files)
    print(json.dumps(dict(host=platform.node(), architecture=platform.machine(),
        registered=registered, files=files, installed_source_verified=verified)))
    if listed.returncode or not registered or not verified: raise RuntimeError('Remote extension registration/source verification failed')
finally:
    if temporary.parent == Path(tempfile.gettempdir()) and temporary.name.startswith('tunnelterm-stream-install-'):
        shutil.rmtree(temporary)
`;
} else {
  python += `
code = shutil.which('code')
help_text = subprocess.run([code, '--help'], capture_output=True, text=True, timeout=10) if code else None
print(json.dumps(dict(host=platform.node(), architecture=platform.machine(),
    code=code, code_help=help_text.stdout[:4000] if help_text else None,
    server_candidates=[str(p) for p in candidates], has_cli_ipc=bool(os.environ.get('VSCODE_IPC_HOOK_CLI')),
    files=report_extensions())))
`;
}
const command = `python3 -c 'exec(__import__("base64").b64decode("${Buffer.from(python).toString('base64')}"))'`;
if (Buffer.byteLength(command) > 120_000) throw new Error('Bootstrap exceeds the remote shell argument budget; use direct VSIX installation');
const instance = selectInstance(await listInstances(), target);
const response = await sendRequest(instance, {op: 'exec', command, timeout_seconds: install ? 65 : 20}, install ? 85000 : 40000);
const stdout = Buffer.from(response.stdout_base64 || '', 'base64').toString();
const stderr = Buffer.from(response.stderr_base64 || '', 'base64').toString();
console.log(JSON.stringify({exit_code: response.exit_code, timed_out: response.timed_out, stdout, stderr}));
process.exitCode = response.exit_code || 0;
