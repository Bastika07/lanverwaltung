'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isolated } = require('../test-support/isolated.cjs');

const register = (app, user, name) => app.request('/api/servers', { method: 'POST', user, body: { name, description: 'Synthetic', reverse: true } });
const publicNames = async (app) => (await app.request('/api/servers', { user: 'outsider' })).data.servers.map((s) => s.name).sort();
const zone = async (app) => (await app.request('/api/servers/export.txt', { admin: true })).text;
// Synthetischer IP-Bereich mit genug Adressen für mehrere Anmeldungen.
const roomy = (data) => { data.events.find((e) => e.id === 'first').serverConfig.ipTo = '10.10.50.30'; };
const block = (app, id, blocked) => app.request(`/api/servers/${id}/block`, { method: 'POST', admin: true, body: { blocked } });

test('guest servers: an admin block survives deleting and re-registering until the organizer lifts it', async (t) => {
  const app = await isolated(t, { prepare: roomy });
  const first = await register(app, 'buyer', 'lanparty');
  assert.equal(first.status, 201);
  assert.equal((await register(app, 'other', 'neighbour')).status, 201);
  assert.equal((await block(app, first.data.id, true)).status, 200);
  assert.deepEqual(await publicNames(app), ['neighbour']);

  const del = await app.request(`/api/servers/${first.data.id}`, { method: 'DELETE', user: 'buyer' });
  assert.equal(del.status, 403, 'operators cannot delete a blocked server');
  assert.match(del.data.error, /nur die Orga/);
  assert.equal((await register(app, 'buyer', 'lanparty')).status, 409, 'the blocked name stays taken');

  const again = await register(app, 'buyer', 'lanparty2');
  assert.equal(again.status, 201);
  assert.equal(again.data.blocked, true, 'new servers of a blocked operator wait for organizer review');
  assert.deepEqual(await publicNames(app), ['neighbour']);
  assert.doesNotMatch(await zone(app), /lanparty/);
  const csv = (await app.request('/api/servers/export.csv', { admin: true })).text;
  assert.match(csv, /lanparty2;[^;]*;[^;]*;ja;ja;;/, 'CSV marks held servers as blocked and not active');

  assert.equal((await register(app, 'other', 'neighbour2')).status, 201, 'unblocked operators register normally');
  assert.equal((await app.request('/api/servers', { user: 'other' })).data.mine.every((s) => !s.blocked), true);

  await block(app, first.data.id, false);
  await block(app, again.data.id, false);
  assert.deepEqual(await publicNames(app), ['lanparty', 'lanparty2', 'neighbour', 'neighbour2']);
  assert.match(await zone(app), /^lanparty\s+IN A\s+10\.10\.50\.10$/m);
  assert.equal((await app.request(`/api/servers/${again.data.id}`, { method: 'DELETE', user: 'buyer' })).status, 200, 'after unblocking the operator may delete');
  assert.match(app.logs(), /"guestserver_blocked"/);
});

test('guest servers: cancelling or unpaying the last eligible ticket removes the server from list and DNS export', async (t) => {
  const app = await isolated(t);
  assert.equal((await register(app, 'buyer', 'buyerbox')).status, 201);
  assert.equal((await register(app, 'other', 'otherbox')).status, 201);
  assert.deepEqual(await publicNames(app), ['buyerbox', 'otherbox']);

  // Zahlungsrücknahme: Server bleibt reserviert, ist aber nicht mehr aktiv; erneute Zahlung reaktiviert ihn.
  assert.equal((await app.request('/api/tickets/orders/first-other/paid', { method: 'POST', admin: true, body: { paid: false } })).status, 200);
  assert.deepEqual(await publicNames(app), ['buyerbox']);
  let text = await zone(app);
  assert.doesNotMatch(text, /otherbox/);
  assert.match(text, /^buyerbox\s+IN A\s+10\.10\.50\.10$/m, 'unrelated servers stay in the export');
  assert.match(text, /in-addr\.arpa\.\s+IN PTR\s+buyerbox\.guest\.invalid\.$/m);
  const mine = (await app.request('/api/servers', { user: 'other' })).data.mine;
  assert.deepEqual(mine.map((s) => [s.name, s.eligible, s.blocked]), [['otherbox', false, false]]);
  const admin = (await app.request('/api/servers/admin', { admin: true })).data.servers;
  assert.deepEqual(admin.map((s) => [s.name, s.eligible]), [['buyerbox', true], ['otherbox', false]]);
  assert.equal((await app.request('/api/tickets/orders/first-other/paid', { method: 'POST', admin: true, body: { paid: true } })).status, 200);
  assert.deepEqual(await publicNames(app), ['buyerbox', 'otherbox'], 'renewed eligibility reactivates the unblocked server');

  // Storno des letzten berechtigenden Tickets.
  assert.equal((await app.request('/api/tickets/orders/first-buyer/cancel', { method: 'POST', admin: true })).status, 200);
  assert.deepEqual(await publicNames(app), ['otherbox']);
  text = await zone(app);
  assert.doesNotMatch(text, /buyerbox/);
  assert.match(text, /^otherbox\s+IN A\s+10\.10\.50\.11$/m);
  assert.match((await app.request('/api/servers/export.csv', { admin: true })).text, /buyerbox;[^;]*;10\.10\.50\.10;ja;;ohne Ticket;/);
  assert.equal(app.snapshot().events.find((e) => e.id === 'first').guestServers.length, 2, 'the record and its IP stay reserved for the organizer');
});
