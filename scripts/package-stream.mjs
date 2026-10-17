import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const cli = fileURLToPath(new URL('../node_modules/@vscode/vsce/vsce', import.meta.url));
const result = spawnSync(process.execPath, [cli, 'package', '--allow-missing-repository'], {
  cwd: fileURLToPath(new URL('../remote-stream', import.meta.url)), stdio: 'inherit', windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status || 0;
