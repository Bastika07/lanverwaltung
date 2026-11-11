'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Security = require('../lib/security');

// Isoliertes Datenverzeichnis je Test
function dataDir(t) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'lan-admin-password-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'admin-password.txt');
}

test('Notzugang: fehlende Datei wird einmalig mit Rechten 0600 angelegt', (t) => {
  const file = dataDir(t);
  assert.equal(Security.readOrCreateSecret(file, () => 'Synthetic-generated'), 'Synthetic-generated');
  assert.equal(fs.readFileSync(file, 'utf8'), 'Synthetic-generated\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('Notzugang: vorhandene Datei wird gelesen, nicht neu erzeugt', (t) => {
  const file = dataDir(t);
  fs.writeFileSync(file, 'Synthetic-existing\n', { mode: 0o600 });
  assert.equal(Security.readOrCreateSecret(file, () => assert.fail('must not generate')), 'Synthetic-existing');
  assert.equal(fs.readFileSync(file, 'utf8'), 'Synthetic-existing\n');
});

test('Notzugang: entsteht die Datei gleichzeitig, gilt sie und wird nicht überschrieben', (t) => {
  const file = dataDir(t);
  // Ein zweiter Start legt die Datei an, während dieser gerade ein Passwort erzeugt
  const generate = () => { fs.writeFileSync(file, 'Synthetic-other-start\n', { mode: 0o600 }); return 'Synthetic-generated'; };
  assert.equal(Security.readOrCreateSecret(file, generate), 'Synthetic-other-start');
  assert.equal(fs.readFileSync(file, 'utf8'), 'Synthetic-other-start\n');
});
