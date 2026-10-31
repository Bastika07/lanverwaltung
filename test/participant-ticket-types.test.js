'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Access = require('../lib/access');
const { isolated } = require('../test-support/isolated.cjs');

// buyer hat nur ein bezahltes Zuschauerticket, other ein normales Teilnehmerticket,
// outsider kein Ticket, aber eine ausdrückliche Orga-Freigabe im Event.
function spectatorOnly(data) {
  const event = data.events.find((e) => e.id === 'first');
  event.ticketTypes.push({ id: 'spectator', name: 'Zuschauer', active: true, price: 500, quota: 10, maxPerOrder: 5, participant: false });
  event.orders.find((o) => o.accountId === 'buyer').tickets.forEach((t) => { t.typeId = 'spectator'; });
  data.persons.push({ id: 'approved', name: 'approved', discordId: 'outsider' });
  event.attendees.push({ personId: 'approved', approved: true });
}

test('participant rights: a paid non-participant ticket opens no protected modules or guest servers', async (t) => {
  const app = await isolated(t, { prepare: spectatorOnly });
  assert.equal((await app.request('/api/info', { user: 'buyer' })).status, 403);
  const servers = await app.request('/api/servers', { user: 'buyer' });
  assert.equal(servers.status, 200);
  assert.equal(servers.data.member, false);
  const register = await app.request('/api/servers', { method: 'POST', user: 'buyer', body: { name: 'spectator', description: 'Synthetic' } });
  assert.equal(register.status, 403);
  assert.equal(app.snapshot().events.find((e) => e.id === 'first').guestServers.length, 0);
});

test('participant rights: participant tickets and explicit approvals keep their access', async (t) => {
  const app = await isolated(t, { prepare: spectatorOnly });
  for (const user of ['other', 'outsider']) {
    const info = await app.request('/api/info', { user });
    assert.equal(info.status, 200, user);
    assert.equal(info.data.wifi.password, 'SYNTHETIC_WIFI');
    const register = await app.request('/api/servers', { method: 'POST', user, body: { name: `ok-${user}`, description: 'Synthetic' } });
    assert.equal(register.status, 201, user);
  }
});

test('participant rights: membership follows the paid ticket type for buyers and linked holders', () => {
  const ticket = (typeId, personId) => ({ id: `t-${typeId}-${personId}`, typeId, personId });
  const event = { attendees: [], ticketTypes: [{ id: 'normal' }, { id: 'spectator', participant: false }, { id: 'legacy', participant: true }],
    orders: [{ status: 'paid', accountId: 'buyer', tickets: [ticket('spectator', 'pb')] }] };
  const db = { persons: [{ id: 'pb', discordId: 'holder' }] };
  assert.equal(Access.isMember(db, 'buyer', event), false);
  assert.equal(Access.isMember(db, 'holder', event), false);
  event.orders[0].tickets.push(ticket('normal', 'pb'));
  assert.equal(Access.isMember(db, 'buyer', event), true);
  assert.equal(Access.isMember(db, 'holder', event), true);
  event.orders[0].tickets = [ticket('deleted-type', 'pb')];
  assert.equal(Access.isMember(db, 'buyer', event), false, 'unknown ticket types fail closed');
  event.orders[0].status = 'cancelled';
  event.orders[0].tickets = [ticket('legacy', 'pb')];
  assert.equal(Access.isMember(db, 'holder', event), false);
});
