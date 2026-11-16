'use strict';
// Gameserver-Status (Issue #118): Ziele für den LAN-Client und Annahme seiner A2S-Ergebnisse. Nur synthetische Daten.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const GameserverStatus = require('../lib/gameserver-status.js');

const mordhau = { name: 'Mordhau', address: '192.0.2.27:7777', queryPort: 27015 };
const setup = (servers = [mordhau]) => {
  let clock = 1000000;
  const status = GameserverStatus({ servers: () => servers, now: () => clock });
  return { status, tick: (ms) => { clock += ms; } };
};
const online = (extra = {}) => ({ host: '192.0.2.27', port: 27015, ok: true,
  info: { name: 'Synthetic Mordhau', map: 'FFA_Camp', players: 5, maxPlayers: 16, bots: 1, password: true, ...extra } });

test('Ziele: nur Einträge mit Query-Port, Host aus der Adresse, ohne Dubletten', () => {
  const { status } = setup([mordhau, { ...mordhau, name: 'Doppelt' }, { name: 'Ohne Port', address: '192.0.2.28:27015' },
    { name: 'Nur Host', address: 'cs.lan', queryPort: 27016 }, { name: 'Ungültig', address: 'evil host!:1', queryPort: 27017 }]);
  assert.deepEqual(status.targets(), [{ host: '192.0.2.27', port: 27015 }, { host: 'cs.lan', port: 27016 }]);
});

test('Stand: Karte, Spieler ohne Bots, Slots und Passwort; ohne Antwort „nicht erreichbar“', () => {
  const { status } = setup();
  assert.deepEqual(status.statusOf(mordhau), { online: false }, 'nothing reported yet');
  status.apply([online()]);
  assert.deepEqual(status.statusOf(mordhau), { online: true, name: 'Synthetic Mordhau', map: 'FFA_Camp', players: 4, slots: 16, password: true });
  status.apply([{ host: '192.0.2.27', port: 27015, ok: false }]);
  assert.deepEqual(status.statusOf(mordhau), { online: false });
  assert.equal(status.statusOf({ name: 'Ohne Port', address: '192.0.2.28:27015' }), null, 'no query port: no status');
});

test('Bericht wird streng geprüft: nur angefragte Server, nur bekannte Felder, Länge und Zahlen begrenzt', () => {
  const { status } = setup();
  status.apply([
    { host: '198.51.100.9', port: 27015, ok: true, info: online().info }, // nie angefragt
    { host: '__proto__', port: 1, ok: true, info: online().info },
    null, 'kaputt', { host: '192.0.2.27', port: '27015', ok: true, info: online().info }, // Port als Text
  ]);
  assert.deepEqual(status.statusOf(mordhau), { online: false }, 'nothing from unknown or malformed entries');
  status.apply([online({ name: `<b>${'x'.repeat(200)}\u001b[2J\u0000`, map: { evil: 1 }, players: 9999, maxPlayers: -3, bots: 'viele', password: 'ja', rcon: 'SECRET' })]);
  const s = status.statusOf(mordhau);
  assert.deepEqual(Object.keys(s).sort(), ['map', 'name', 'online', 'password', 'players', 'slots']);
  assert.equal(s.name, `<b>${'x'.repeat(61)}`, 'control characters removed, cut to 64 (HTML is escaped on output)');
  assert.deepEqual([s.map, s.players, s.slots, s.password], ['', 255, 0, false]);
  assert.equal(status.apply('kein Array'), undefined);
  assert.equal(status.apply(Array(500).fill(online())), undefined, 'long lists do not throw');
});

test('Veralteter Stand (LAN-Client meldet nicht mehr) gilt als nicht erreichbar', () => {
  const { status, tick } = setup();
  status.apply([online()]);
  tick(59000);
  assert.equal(status.statusOf(mordhau).online, true);
  tick(2000);
  assert.deepEqual(status.statusOf(mordhau), { online: false });
});

test('Browser: Statuszeile maskiert Text vom Gameserver und zeigt „nicht erreichbar“', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const path = require('node:path');
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const info = fs.readFileSync(path.join(__dirname, '../public/info.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(`${app.split('\n').find((l) => l.startsWith('const esc ='))}\n${info.match(/function serverStatus[\s\S]*?\n\}/)[0]}`, context);
  const html = context.serverStatus({ status: { online: true, name: '<img src=x onerror=alert(1)>', map: '"><script>', players: 4, slots: 16, password: true } });
  assert.doesNotMatch(html, /<img|<script|"></);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /4\/16 Spieler · 🔒 Passwort/);
  assert.match(context.serverStatus({ status: { online: false } }), /nicht erreichbar/);
  assert.equal(context.serverStatus({ status: null }), '');
});
