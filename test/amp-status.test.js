'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isolated } = require('../test-support/isolated.cjs');
const { fakeTmt, TMT_TOKEN } = require('../test-support/fake-tmt2.cjs');
const { createAgent, config } = require('../agent/tmt2-agent.js');

const AGENT_TOKEN = 'e'.repeat(40);
const quiet = { log() {}, error() {} };
const enable = (data) => { const e = data.events.find((x) => x.id === 'first'); e.modules = { ...e.modules, cs2: true }; };
const statusFile = (t, value) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-status-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'status.json');
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
};

test('AMP/Gameserver: LAN-Client meldet Status und Belegung, Admin-Seite zeigt Links und Server', async (t) => {
  const tmt = await fakeTmt(t);
  tmt.state.gameservers = [
    { ip: '10.0.0.5', port: 27015, canBeUsed: true, usedBy: null, rconPassword: 'SECRET_RCON' },
    { ip: '10.0.0.5', port: 27016, canBeUsed: true, usedBy: 'tmt-1', rconPassword: 'SECRET_RCON' },
    { ip: '10.0.0.9', port: 27030, canBeUsed: false, usedBy: null, rconPassword: 'SECRET_RCON' },
  ];
  const file = statusFile(t, {
    ampUrl: 'http://10.0.0.5:8080', tmt2Url: 'http://10.0.0.5:8088/',
    servers: [
      { name: 'Warserver#1', address: '10.0.0.5:27015', running: true },
      { name: 'Warserver#2', address: '10.0.0.5:27016', running: true },
      { name: '4 All', address: '10.0.0.5:27017', running: false },
      { name: '<script>', address: 'evil<b>:1', running: true }, // ungültige Adresse fällt weg
    ],
  });
  const app = await isolated(t, { prepare: enable, env: { TMT2_AGENT_TOKEN: AGENT_TOKEN } });
  const agent = createAgent({ lanUrl: app.base, agentToken: AGENT_TOKEN, tmtUrl: tmt.url, tmtToken: TMT_TOKEN, statusFile: file, log: quiet });
  const created = await app.request('/api/cs2/matches', { method: 'POST', admin: true, body: { teamA: 'Alpha', teamB: 'Bravo' } });
  assert.equal(created.status, 201);
  await agent.cycle();

  const d = (await app.request('/api/cs2', { admin: true })).data;
  assert.equal(d.ampUrl, 'http://10.0.0.5:8080');
  assert.equal(d.publicUrl, 'http://10.0.0.5:8088', 'TMT2-Link folgt der gemeldeten Adresse');
  assert.equal(d.matches[0].link, `http://10.0.0.5:8088/matches/${d.matches[0].tmtId}`);
  const by = Object.fromEntries(d.servers.map((s) => [s.address, s]));
  assert.deepEqual(Object.keys(by).sort(), ['10.0.0.5:27015', '10.0.0.5:27016', '10.0.0.5:27017', '10.0.0.9:27030']);
  assert.deepEqual([by['10.0.0.5:27015'].name, by['10.0.0.5:27015'].running, by['10.0.0.5:27015'].tmt2], ['Warserver#1', true, { enabled: true, used: null }]);
  assert.deepEqual([by['10.0.0.5:27016'].tmt2.used, by['10.0.0.5:27016'].match], ['tmt-1', 'Alpha vs Bravo']);
  assert.deepEqual([by['10.0.0.5:27017'].running, by['10.0.0.5:27017'].tmt2], [false, null], '4 All ist nicht in TMT2');
  assert.deepEqual([by['10.0.0.9:27030'].name, by['10.0.0.9:27030'].tmt2.enabled], [null, false], 'nur in TMT2 bekannt');
  assert.doesNotMatch(JSON.stringify([d, app.snapshot()]), /SECRET_RCON/, 'RCON-Passwörter verlassen das LAN nicht');

  // Nur für Admins
  for (const opts of [{ user: 'buyer' }, {}]) {
    const r = await app.request('/api/cs2', opts);
    assert.ok([401, 403].includes(r.status), `ohne Admin kein Zugriff (${r.status})`);
    assert.doesNotMatch(r.text, /10\.0\.0\.5/);
  }
});

test('AMP/Gameserver: nur sichere Links, feste Adressen aus der Umgebung haben Vorrang', async (t) => {
  const tmt = await fakeTmt(t);
  const file = statusFile(t, { ampUrl: 'javascript:alert(1)', tmt2Url: 'http://user:pw@10.0.0.5:8088', servers: 'kaputt' });
  const app = await isolated(t, { prepare: enable, env: { TMT2_AGENT_TOKEN: AGENT_TOKEN } });
  await createAgent({ lanUrl: app.base, agentToken: AGENT_TOKEN, tmtUrl: tmt.url, tmtToken: TMT_TOKEN, statusFile: file, log: quiet }).cycle();
  let d = (await app.request('/api/cs2', { admin: true })).data;
  assert.deepEqual([d.ampUrl, d.publicUrl, d.servers], [null, null, []]);

  // Fehlende Datei: der Client läuft weiter und meldet nur, was TMT2 kennt
  await createAgent({ lanUrl: app.base, agentToken: AGENT_TOKEN, tmtUrl: tmt.url, tmtToken: TMT_TOKEN, statusFile: `${file}.fehlt`, log: quiet }).cycle();

  const fixed = await isolated(t, { prepare: enable, env: { TMT2_AGENT_TOKEN: AGENT_TOKEN, AMP_PUBLIC_URL: 'https://amp.example.org/', TMT2_PUBLIC_URL: 'https://tmt.example.org' } });
  const ok = statusFile(t, { ampUrl: 'http://10.0.0.5:8080', tmt2Url: 'http://10.0.0.5:8088', servers: [] });
  await createAgent({ lanUrl: fixed.base, agentToken: AGENT_TOKEN, tmtUrl: tmt.url, tmtToken: TMT_TOKEN, statusFile: ok, log: quiet }).cycle();
  d = (await fixed.request('/api/cs2', { admin: true })).data;
  assert.deepEqual([d.ampUrl, d.publicUrl], ['https://amp.example.org', 'https://tmt.example.org']);

  assert.equal(config({ LAN_URL: 'https://lan.example.org', TMT2_AGENT_TOKEN: AGENT_TOKEN, TMT2_TOKEN: TMT_TOKEN, LAN_STATUS_FILE: '/run/lan-status/status.json' }).statusFile, '/run/lan-status/status.json');
});
