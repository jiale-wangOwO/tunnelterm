import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
async function sources(directory) {
  const files = [];
  for (const entry of await fs.readdir(path.join(root, directory), {withFileTypes: true})) {
    if (entry.name === 'node_modules') continue;
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sources(relative));
    else if (/\.(?:mjs|cjs|js)$/.test(entry.name)) files.push(relative);
  }
  return files.sort();
}
function run(command, args) {
  const result = spawnSync(command, args, {cwd: root, stdio: 'inherit', windowsHide: true, timeout: 15000});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Syntax check failed (${result.status ?? result.signal})`);
}
const files = (await Promise.all(['bin', 'src', 'remote-stream', 'scripts', 'test'].map(sources))).flat();
for (const file of files) run(process.execPath, ['--check', file]);
run('python', ['-m', 'py_compile', 'remote/tunnelterm_agent.py']);
if (process.platform === 'win32') {
  // Parse only: never execute launchers, install tasks or touch live services.
  const script = "$ErrorActionPreference='Stop'; Get-ChildItem scripts,tools -Filter '*.ps1' -File | ForEach-Object { $parseTokens=$null; $parseErrors=$null; [System.Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$parseTokens,[ref]$parseErrors) | Out-Null; if($parseErrors.Count){$parseErrors | ForEach-Object {Write-Error $_.Message}} }";
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
}
console.log(`Syntax checked ${files.length} JavaScript files, the Python helper and available PowerShell launchers.`);
