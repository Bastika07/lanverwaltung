'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isolated } = require('../test-support/isolated.cjs');

const edit = (app, body, options = {}) => app.request('/api/tickets/orders/first-buyer/holders', {
  method: 'PUT', user: 'buyer', body, ...options
});

test('Ticketbearbeitung: Käufer ändert den Ticketnamen, aber nicht die globale Identität eines fremden Empfängers', async (t) => {
  const app = await isolated(t, { prepare(db) {
    db.persons.push({ id: 'recipient', name: 'Empfänger', discordId: 'outsider', ticketOwnerId: 'buyer', clan: 'Original', note: 'Privat' });
    db.events[0].orders[0].tickets[0].personId = 'recipient';
    db.events[0].attendees.push({ personId: 'recipient' });
  } });
  const before = app.snapshot();
  const r = await edit(app, { holders: { 'first-ticket-buyer': 'Neuer Ticketname' }, clans: { 'first-ticket-buyer': 'Fremder Clan' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.tickets[0].holder, 'Neuer Ticketname');
  assert.equal(r.data.tickets[0].clan, 'Original');
  const expected = structuredClone(before);
  expected.events[0].orders[0].tickets[0].holder = 'Neuer Ticketname';
  assert.deepEqual(app.snapshot(), expected, 'SQLite: Nur der Ticketname darf sich ändern, keine Person oder fremdes Event');
  const again = await edit(app, { clans: { 'first-ticket-buyer': 'Erneuter Versuch' } });
  assert.equal(again.status, 200, again.text);
  assert.deepEqual(app.snapshot(), expected);
});

test('Ticketbearbeitung: eigene und ungebundene eigene Personen sowie Adminänderungen funktionieren weiter', async (t) => {
  for (const [discordId, admin] of [['buyer', false], [null, false], ['outsider', true]]) {
    const app = await isolated(t, { prepare(db) { db.persons[0].discordId = discordId; } });
    const r = await edit(app, { holders: { 'first-ticket-buyer': 'Eigener Name' }, clans: { 'first-ticket-buyer': 'Eigener Clan' } }, { admin });
    assert.equal(r.status, 200, r.text);
    const p = app.snapshot().persons.find((p) => p.id === 'buyer');
    assert.equal(p.name, 'Eigener Name');
    assert.equal(p.clan, 'Eigener Clan');
    assert.equal(p.discordId, discordId);
    assert.equal(p.ticketOwnerId, 'buyer');
  }
});

test('Ticketbearbeitung: fremde Konten, CSRF und während des Uploads widerrufene Sitzungen bleiben gesperrt', async (t) => {
  const app = await isolated(t);
  const body = { holders: { 'first-ticket-buyer': 'Nicht erlaubt' }, clans: { 'first-ticket-buyer': 'Nicht erlaubt' } };
  const before = app.snapshot();
  assert.equal((await edit(app, body, { user: 'other' })).status, 403);
  assert.equal((await edit(app, body, { headers: { Origin: 'https://fremd.invalid' } })).status, 403);
  assert.deepEqual(app.snapshot(), before);
  const staged = app.staged('/api/tickets/orders/first-buyer/holders', { method: 'PUT', user: 'buyer', body });
  await app.request('/api/auth/logout', { method: 'POST', user: 'buyer', body: {} });
  const loggedOut = app.snapshot();
  staged.finish();
  assert.equal((await staged.done).status, 401);
  assert.deepEqual(app.snapshot(), loggedOut);
});
