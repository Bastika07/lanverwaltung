'use strict';
// Konsistente Online-Sicherung oder expliziter JSON-Export (z. B. für einen kontrollierten Rollback).
const fs = require('node:fs');
const path = require('node:path');
const { readSnapshot, backupSnapshot } = require('./storage');

async function main() {
  const [command, output] = process.argv.slice(2);
  if (!['backup', 'export-json', 'check'].includes(command) || (command !== 'check' && !output)) throw new Error('Aufruf: node lib/database-cli.js backup|export-json <neue Zieldatei> oder check');
  const filename = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'db.sqlite');
  if (command === 'backup') await backupSnapshot(filename, output);
  else {
    const data = readSnapshot(filename);
    if (command === 'export-json') fs.writeFileSync(output, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  console.log(command === 'check' ? 'SQLite-Integrität und Schema: OK' : 'Konsistente Datenbanksicherung erstellt.');
}
main().catch((err) => { console.error(err.message); process.exitCode = 1; });
