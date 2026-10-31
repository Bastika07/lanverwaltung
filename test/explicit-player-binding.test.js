'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Bracket = require('../public/bracket.js');
const { isolated } = require('../test-support/isolated.cjs');

// Orga-Turnier mit frei getippten, ungebundenen Namen
const prepare = (data) => data.events[0].tournaments.push({ id: 'cup', name: 'Cup', type: 'ko', status: 'draft', participants: ['Alice', 'Synthetic Bob'],
  order: [], results: {}, members: {}, playerIds: { Alice: null, 'Synthetic Bob': null }, discordEnabled: false });
const cup = (app) => app.snapshot().events[0].tournaments.find((t) => t.id === 'cup');
const renameTicket = (app) => app.request('/api/tickets/orders/first-other/holders', { method: 'PUT', user: 'other', body: { holders: { 'first-ticket-other': 'Alice' } } });
async function startAndReport(app) {
  assert.equal((await app.request('/api/tournaments/cup/start', { method: 'POST', admin: true, body: {} })).status, 200);
  const m = Bracket.compute(cup(app)).matches.find((x) => x.status === 'ready');
  return app.request(`/api/tournaments/cup/matches/${m.id}`, { method: 'POST', user: 'other', body: { a: 1, b: 0 } });
}

test('Umbenennen der eigenen Ticketperson auf einen ungebundenen Turniernamen bindet den Platz nicht', async (t) => {
  const app = await isolated(t, { prepare });
  assert.equal((await renameTicket(app)).status, 200);
  assert.equal(app.snapshot().persons.find((p) => p.id === 'other').name, 'Alice');
  const report = await startAndReport(app);
  assert.equal(report.status, 403, JSON.stringify(report.data));
  assert.equal(cup(app).playerIds.Alice, null);
  assert.deepEqual(cup(app).results, {});
});

test('ausdrückliche Personenauswahl der Orga bindet; abweichende Auswahl wird abgelehnt', async (t) => {
  const app = await isolated(t, { prepare });
  await renameTicket(app);
  const wrong = await app.request('/api/tournaments/cup', { method: 'PUT', admin: true, body: { participants: ['Alice', 'Synthetic Bob'], playerIds: { Alice: 'buyer' } } });
  assert.equal(wrong.status, 400);
  assert.equal(cup(app).playerIds.Alice, null, 'rejected selection changes nothing');
  const chosen = await app.request('/api/tournaments/cup', { method: 'PUT', admin: true, body: { participants: ['Alice', 'Synthetic Bob'], playerIds: { Alice: 'other' } } });
  assert.equal(chosen.status, 200, JSON.stringify(chosen.data));
  assert.equal(cup(app).playerIds.Alice, 'other');
  assert.equal((await startAndReport(app)).status, 200, 'explicitly bound player may report');
});

test('neue Turniere: frei getippte Namen bleiben trotz gleichnamiger Person ungebunden', async (t) => {
  const app = await isolated(t);
  const created = await app.request('/api/tournaments', { method: 'POST', admin: true, body: { name: 'Neu', type: 'ko', participants: ['buyer', 'other'], playerIds: { other: 'other' } } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.deepEqual(created.data.playerIds, { buyer: null, other: 'other' });
});
