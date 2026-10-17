// Explicit, bounded migration of this application's service records only.
// Useful when a packaged host virtualizes AppData but an OS supervisor does not.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {atomicWrite, stateRoot} from '../src/client-core.mjs';
const profiles = process.argv.slice(2);
if (!profiles.length || profiles.some(value => !/^[a-zA-Z0-9_-]{1,48}$/.test(value))) throw new Error('Usage: migrate-service-state.mjs PROFILE...');
const oldRoot = path.join(stateRoot(), 'services');
const newRoot = path.join(os.homedir(), '.tunnelterm', 'services');
for (const profile of profiles) {
  for (const suffix of ['.json', '.route.json', '.runtime.json']) {
    const oldFile = path.join(oldRoot, profile + suffix);
    let record;
    try {record = JSON.parse((await fs.readFile(oldFile, 'utf8')).replace(/^\uFEFF/, ''));} catch (error) {if (error.code === 'ENOENT') continue; throw error;}
    const newFile = path.join(newRoot, profile + suffix);
    try {await fs.access(newFile); throw new Error('Destination already exists; refusing to overwrite service ownership');} catch (error) {if (error.code !== 'ENOENT') throw error;}
    await atomicWrite(newFile, record);
  }
  console.log(JSON.stringify({profile, service_directory: newRoot, account_credentials_read: false}));
}
