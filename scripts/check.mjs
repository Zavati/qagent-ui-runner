import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = directory + '/' + entry.name;
    if (entry.isDirectory()) await visit(path);
    else if (/\.(?:mjs|js)$/.test(path)) { const run = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' }); if (run.status !== 0) process.exit(run.status ?? 1); }
  }
}
for (const dir of ['src', 'test', 'scripts', 'examples']) await visit(dir);
console.log('All JavaScript modules parsed successfully. Runtime contracts are covered by npm test.');
