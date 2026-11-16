'use strict';
// Issue #118: Gameserver-Status auf Infos und Beamer. Echter Server, LAN-Client (agent/tmt2-agent.js), lokale
// TMT2-Attrappe und lokale A2S-Stubs per UDP; nur synthetische Daten, keine echten Gameserver.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isolated } = require('../test-support/isolated.cjs');
const { createAgent } = require('../agent/tmt2-agent.js');
const { fakeTmt, TMT_TOKEN } = require('../test-support/fake-tmt2.cjs');
const { infoPacket, stub } = require('../test-support/a2s-stub.cjs');

const AGENT_TOKEN = 'a'.repeat(40);
const quiet = { log() {}, error() {} };

test('Gameserver-Status: Orga trägt den Query-Port ein, der LAN-Client fragt ab, Infos zeigen den Stand', async (t) => {
  const tmt = await fakeTmt(t);
  const mordhau = await stub(t, () => infoPacket({ name: 'Synthetic Mordhau', map: 'FFA_Camp', game: 'Mordhau', players: 5, max: 16, bots: 1, password: 1 }));
  const silent = await stub(t, () => null);
  const app = await isolated(t, { env: { TMT2_AGENT_TOKEN: AGENT_TOKEN } });
  const servers = [
    { name: 'Mordhau', game: 'Mordhau', address: '127.0.0.1:7777', queryPort: String(mordhau.port) }, // wie aus dem Formular
    { name: 'Aus', address: '127.0.0.1', queryPort: silent.port },
    { name: 'Ohne Status', address: '127.0.0.1:27015', queryPort: '' },
  ];
  assert.equal((await app.request('/api/info', { method: 'PUT', admin: true, body: { servers: [{ name: 'X', queryPort: 'abc' }] } })).status, 400);
  assert.equal((await app.request('/api/info', { method: 'PUT', admin: true, body: { servers: [{ name: 'X', queryPort: 70000 }] } })).status, 400);
  const saved = await app.request('/api/info', { method: 'PUT', admin: true, body: { servers } });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.data.servers.map((s) => s.queryPort), [mordhau.port, silent.port, null]);

  let r = await app.request('/api/info', { user: 'buyer' }); // Infos: nur mit Ticket (Testdaten)
  assert.deepEqual(r.data.servers.map((s) => s.status), [{ online: false }, { online: false }, null], 'no report yet');
  assert.equal(mordhau.seen.length + silent.seen.length, 0, 'the server never queries game servers itself');

  await createAgent({ lanUrl: app.base, agentToken: AGENT_TOKEN, tmtUrl: tmt.url, tmtToken: TMT_TOKEN, log: quiet }).cycle();
  r = await app.request('/api/info', { user: 'buyer' }); // Infos: nur mit Ticket (Testdaten)
  assert.deepEqual(r.data.servers.map((s) => s.status), [
    { online: true, name: 'Synthetic Mordhau', map: 'FFA_Camp', players: 4, slots: 16, password: true },
    { online: false }, null]);
  assert.equal(mordhau.seen.length, 1);
});
