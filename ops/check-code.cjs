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
    return entry.isDirectory() ? sources(file) : /\.(?:js|cjs|mjs|sh)$/.test(entry.name) ? [file] : [];
  });
}
let failed = 0;
const files = sources(root).sort();
const scripts = files.filter((file) => file.endsWith('.sh'));
for (const file of files) {
  // Shell-Skripte (u. a. Rollout als root) nur auf Syntax prüfen, nicht ausführen
  const result = file.endsWith('.sh') ? spawnSync('bash', ['-n', file], { stdio: 'inherit' })
    : spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) failed++;
}
JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
JSON.parse(fs.readFileSync(path.join(root, 'ops/assessment-api.json'), 'utf8'));
// Letzte Zeile = Ergebnis: Wer nur das Ende der Ausgabe liest, muss einen Fehler sehen.
if (failed) console.error(`FEHLER: Syntaxfehler in ${failed} von ${files.length} Dateien (Details oben).`);
else console.log(`Checked ${files.length - scripts.length} JavaScript files, ${scripts.length} shell scripts and project JSON; vendored upstream code excluded.`);
process.exitCode = failed ? 1 : 0;
