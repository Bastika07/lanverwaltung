'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Bracket = require('../public/bracket.js');
const { isolated } = require('../test-support/isolated.cjs');

const env = { NODE_OPTIONS: `--require ${JSON.stringify(path.join(__dirname, '../test-support/count-calls.cjs'))}` };
const count = (app, what) => app.logs().split('\n').filter((l) => l === `[count] ${what}`).length;
const match = (app) => Bracket.compute(app.snapshot().events[0].tournaments.find((t) => t.id === 'match')).matches.find((m) => m.status === 'ready');

test('Match-Pfad: unzulässige und anonyme Anfragen berechnen keinen Spielplan', async (t) => {
  const app = await isolated(t, { env });
  const before = count(app, 'compute');
  for (let i = 0; i < 3; i++) {
    assert.equal((await app.request('/api/tournaments/match/matches/unknown')).status, 405);
    assert.equal((await app.request('/api/tournaments/match/matches/unknown', { method: 'POST', body: { a: 1, b: 0 } })).status, 401);
    assert.equal((await app.request('/api/tournaments/match/matches/unknown', { method: 'DELETE', user: 'buyer' })).status, 401);
  }
  assert.equal(count(app, 'compute'), before, 'no schedule computation before access checks');

  // Erlaubte Pfade funktionieren wie bisher
  assert.equal((await app.request('/api/tournaments/match/matches/unknown', { method: 'POST', user: 'buyer', body: { a: 1, b: 0 } })).status, 404);
  const m = match(app);
  const report = await app.request(`/api/tournaments/match/matches/${m.id}`, { method: 'POST', admin: true, body: { a: 2, b: 1 } });
  assert.equal(report.status, 200, JSON.stringify(report.data));
  const undo = await app.request(`/api/tournaments/match/matches/${m.id}`, { method: 'DELETE', admin: true });
  assert.equal(undo.status, 200, JSON.stringify(undo.data));
});

test('GET /api/seats/mine speichert nur, wenn tatsächlich eine Teilnahme nachgetragen wird', async (t) => {
  const app = await isolated(t, { env, prepare: (d) => { d.events[0].attendees = d.events[0].attendees.filter((a) => a.personId !== 'other'); } });
  const saves = () => count(app, 'save');
  const base = saves();
  for (let i = 0; i < 3; i++) assert.equal((await app.request('/api/seats/mine', { user: 'buyer' })).status, 200);
  assert.equal(saves(), base, 'existing participants: reading does not write');

  assert.equal((await app.request('/api/seats/mine', { user: 'other' })).status, 200);
  assert.equal(saves(), base + 1, 'missing attendance is restored once');
  assert.ok(app.snapshot().events[0].attendees.some((a) => a.personId === 'other'));
  await app.request('/api/seats/mine', { user: 'other' });
  assert.equal(saves(), base + 1);
});
