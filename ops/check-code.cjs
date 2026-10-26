'use strict';
// Dependency-free syntax/config checks; do not execute application modules.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const excluded = new Set(['.git', 'node_modules', 'data', 'vendor']);
function sources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (excluded.has(entry.name) || entry.isSymbolicLink()) return [];
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(file) : /\.(?:js|cjs|mjs)$/.test(entry.name) ? [file] : [];
  });
}
let failed = false;
const files = sources(root).sort();
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) failed = true;
}
JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
JSON.parse(fs.readFileSync(path.join(root, 'ops/assessment-api.json'), 'utf8'));
console.log(`Checked ${files.length} JavaScript files and project JSON; vendored upstream code excluded.`);
process.exitCode = failed ? 1 : 0;
