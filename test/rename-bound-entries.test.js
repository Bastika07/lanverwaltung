'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isolated } = require('../test-support/isolated.cjs');

// In beiden Events: „Alice“ ungebunden (Orga-Eintrag), „buyer“ gebunden; im zweiten Event zusätzlich ein ungebundenes „buyer“.
const cup = (id, participants, playerIds) => ({ id, name: id, type: 'ko', status: 'draft', participants, order: [], results: {}, members: {}, playerIds, discordEnabled: false });
const prepare = (data) => {
  data.persons.push({ id: 'claimer', name: 'Alice', discordId: 'outsider', selfClaimed: true });
  data.events[0].attendees.push({ personId: 'claimer' });
  data.events[0].tournaments.push(cup('cup-first', ['Alice', 'buyer'], { Alice: null, buyer: 'buyer' }));
  data.events[1].tournaments.push(cup('cup-second', ['Alice', 'buyer'], { Alice: null, buyer: 'buyer' }));
  data.events[1].tournaments.push(cup('loose', ['buyer', 'Synthetic'], { buyer: null, Synthetic: null }));
};
const entries = (app) => Object.fromEntries(app.snapshot().events.flatMap((e) => e.tournaments).map((t) => [t.id, { participants: t.participants, playerIds: t.playerIds }]));

test('Kontolöschung: nur gebundene Einträge werden pseudonymisiert, gleichnamige fremde bleiben', async (t) => {
  const app = await isolated(t, { prepare });
  const deleted = await app.request('/api/account', { method: 'DELETE', user: 'outsider' });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  const after = entries(app);
  assert.deepEqual(after['cup-first'].participants, ['Alice', 'buyer']);
  assert.deepEqual(after['cup-second'].participants, ['Alice', 'buyer']);
  assert.match(app.snapshot().persons.find((p) => p.id === 'claimer').name, /^Gelöscht-/);
});

test('Ticket-Namensänderung: gebundene Einträge folgen in allen Events, ungebundene gleichnamige bleiben', async (t) => {
  const app = await isolated(t, { prepare });
  const r = await app.request('/api/tickets/orders/first-buyer/holders', { method: 'PUT', user: 'buyer', body: { holders: { 'first-ticket-buyer': 'Synthetic Neu' } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const after = entries(app);
  for (const id of ['cup-first', 'cup-second']) {
    assert.deepEqual(after[id].participants, ['Alice', 'Synthetic Neu'], id);
    assert.equal(after[id].playerIds['Synthetic Neu'], 'buyer');
  }
  assert.deepEqual(after.loose.participants, ['buyer', 'Synthetic'], 'unbound equal name stays');
  assert.equal(Object.hasOwn(after.loose.playerIds, 'Synthetic Neu'), false);
});
