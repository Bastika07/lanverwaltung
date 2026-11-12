'use strict';
// LAN-Board (agent/lan-board.js): Steam-Abfrage gegen einen lokalen UDP-Stub, Darstellung und Proxmox-Auswertung
// mit synthetischen Daten. Kein echter Gameserver, kein Proxmox.
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseInfo, queryInfo, mergeProxmox, renderFrame, loadConfig, visible } = require('../agent/lan-board.js');

function infoPacket({ name = 'Testserver', map = 'de_test', game = 'Counter-Strike 2', players = 3, max = 10, bots = 1, password = 0 } = {}) {
  const z = (s) => Buffer.from(`${s}\0`, 'utf8');
  return Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17]), z(name), z(map), z('csgo'), z(game),
    Buffer.from([0xda, 0x02, players, max, bots, 0x64, 0x6c, password, 1]), z('1.0.0')]);
}

// Stub: antwortet erst mit einer Challenge, dann (nur mit korrekter Challenge) mit dem Info-Paket
async function stub(t, respond) {
  const sock = dgram.createSocket('udp4');
  const seen = [];
  sock.on('message', (msg, peer) => { seen.push(msg); const r = respond(msg, seen.length); if (r) sock.send(r, peer.port, peer.address); });
  await new Promise((resolve) => sock.bind(0, '127.0.0.1', resolve));
  t.after(() => sock.close());
  return { port: sock.address().port, seen };
}

test('lan-board: A2S_INFO wird gelesen, auch mit Spielern, Bots und Passwort', () => {
  const info = parseInfo(infoPacket({ players: 5, max: 12, bots: 2, password: 1 }));
  assert.equal(info.name, 'Testserver');
  assert.equal(info.map, 'de_test');
  assert.equal(info.game, 'Counter-Strike 2');
  assert.deepEqual([info.players, info.maxPlayers, info.bots, info.password, info.vac], [5, 12, 2, true, true]);
  assert.throws(() => parseInfo(infoPacket().subarray(0, 20)), /zu kurz/);
  assert.throws(() => parseInfo(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x6d, 0])), /keine A2S_INFO/);
});

test('lan-board: Abfrage beantwortet die Challenge und misst den Ping', async (t) => {
  const challenge = Buffer.from([1, 2, 3, 4]);
  const s = await stub(t, (msg, n) => (n === 1 ? Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41]), challenge])
    : msg.subarray(-4).equals(challenge) ? infoPacket({ map: 'HRD_Camp', game: 'Mordhau' }) : null));
  const r = await queryInfo('127.0.0.1', s.port, { timeout: 1000 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.info.map, 'HRD_Camp');
  assert.equal(s.seen.length, 2);
  assert.ok(Number.isInteger(r.ping) && r.ping >= 0);
});

test('lan-board: keine oder kaputte Antwort ergibt einen Fehlerstatus statt einer Ausnahme', async (t) => {
  const silent = await stub(t, () => null);
  const r1 = await queryInfo('127.0.0.1', silent.port, { timeout: 150 });
  assert.deepEqual(r1, { ok: false, error: 'keine Antwort' });
  const garbage = await stub(t, () => Buffer.from('kein A2S'));
  const r2 = await queryInfo('127.0.0.1', garbage.port, { timeout: 500 });
  assert.equal(r2.ok, false);
  const cut = await stub(t, () => infoPacket().subarray(0, 12));
  assert.equal((await queryInfo('127.0.0.1', cut.port, { timeout: 500 })).ok, false);
});

test('lan-board: Text vom Gameserver kann das Terminal nicht steuern (ESC und Steuerzeichen entfernt)', () => {
  const info = parseInfo(infoPacket({ name: 'Böse\x1b[2J\x1b]0;Titel\x07Server', map: 'de_\x1b[31mrot\r\n' }));
  assert.doesNotMatch(info.name + info.map, /[\x00-\x1f\x7f]/);
  const frame = renderFrame({ interval: 2, nodes: [], servers: [{ name: 'x', host: 'h', port: 1, a2s: { ok: true, ping: 1, info } }] }, 80, { color: false });
  assert.doesNotMatch(frame.join('\n'), /\x1b/);
});

const server = (name, extra = {}) => ({ name, host: '192.0.2.10', port: 27015, vmid: 101, ...extra });

test('lan-board: jede Zeile ist genau so breit wie das Terminal, auch mit Fehlern und ohne Proxmox', () => {
  const info = parseInfo(infoPacket({ name: 'S', map: 'ein_sehr_langer_kartenname_der_nicht_passt_und_gekuerzt_wird' }));
  const guest = { vmid: 101, cpu: 0.5, mem: 2e9, maxmem: 4e9, uptime: 3600, status: 'running', rxRate: 1e5, txRate: null };
  const state = { interval: 2, nodes: [{ name: 'pve', cpu: 0.3, mem: 1e10, maxmem: 6e10 }], pveError: null, servers: [
    server('Warserver #1 mit einem sehr langen Namen', { a2s: { ok: true, ping: 2, info }, guest }),
    server('Warserver #2', { a2s: { ok: false, error: 'keine Antwort' }, guest: null }),
    server('Mordhau', { vmid: null }),
  ] };
  for (const cols of [40, 79, 80, 120, 200]) {
    for (const color of [false, true]) {
      const frame = renderFrame(state, cols, { color });
      for (const line of frame) assert.equal(visible(line).length, cols, `${cols}/${color}: ${visible(line)}`);
    }
  }
  const text = renderFrame({ ...state, pveError: 'Proxmox antwortet 401' }, 120, { color: false }).join('\n');
  for (const s of ['1/3 online', 'keine Antwort', 'Proxmox antwortet 401', 'CT 101', 'Warserver #2']) assert.ok(text.includes(s), s);
});

test('lan-board: Netz-Raten aus der Differenz zum letzten geänderten Proxmox-Stand', () => {
  const ct = (netin, netout) => ({ type: 'lxc', vmid: 101, name: 'ct', status: 'running', cpu: 0.1, maxcpu: 2, mem: 1, maxmem: 2, netin, netout });
  const node = { type: 'node', node: 'pve', status: 'online', cpu: 0.2, mem: 5, maxmem: 10 };
  const a = mergeProxmox([node, ct(1000, 500), { type: 'storage', storage: 'local' }], {}, 0);
  assert.equal(a.guests[101].rxRate, null);
  assert.equal(a.nodes[0].name, 'pve');
  // Proxmox hat noch nicht aktualisiert: Rate bleibt, Bezugszeit auch
  const b = mergeProxmox([ct(1000, 500)], a.guests, 5000);
  assert.equal(b.guests[101].t, 0);
  const c = mergeProxmox([ct(11000, 2500)], b.guests, 10000);
  assert.equal(c.guests[101].rxRate, 1000);
  assert.equal(c.guests[101].txRate, 200);
  assert.equal(mergeProxmox([ct(11000, 2500)], c.guests, 12000).guests[101].rxRate, 1000);
});

test('lan-board: Konfiguration prüft Server und liest das Proxmox-Token aus einer Datei', (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'lan-board-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (cfg) => { const f = path.join(dir, 'c.json'); fs.writeFileSync(f, JSON.stringify(cfg)); return f; };
  fs.writeFileSync(path.join(dir, 'token'), 'geheim\n');
  const cfg = loadConfig(write({ interval: 0.1, servers: [{ name: 'A', host: '192.0.2.1', vmid: 101 }],
    proxmox: { url: 'https://192.0.2.2:8006', tokenId: 'board@pve!board', secretFile: path.join(dir, 'token') } }));
  assert.equal(cfg.interval, 1);
  assert.equal(cfg.servers[0].port, 27015);
  assert.equal(cfg.pve.secret, 'geheim');
  assert.throws(() => loadConfig(write({ servers: [] })), /keine servers/);
  assert.throws(() => loadConfig(write({ servers: [{ host: 'h', port: 70000 }] })), /ungültig/);
  assert.throws(() => loadConfig(write({ servers: [{ host: 'h' }], proxmox: { url: 'https://x', secret: 's' } })), /tokenId/);
});

test('lan-board: --once in eine Pipe gibt einen Rahmen ohne Farbcodes aus und endet', async (t) => {
  const s = await stub(t, () => infoPacket({ name: 'Stub', map: 'de_pipe' }));
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'lan-board-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'board.json');
  fs.writeFileSync(config, JSON.stringify({ servers: [{ name: 'Stub', host: '127.0.0.1', port: s.port }] }));
  const child = spawn(process.execPath, [path.join(__dirname, '../agent/lan-board.js'), '--config', config, '--once'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0);
  assert.doesNotMatch(out, /\x1b/);
  assert.match(out, /1\/1 online/);
  assert.match(out, /de_pipe/);
});
