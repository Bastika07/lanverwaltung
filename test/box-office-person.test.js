'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isolated } = require('../test-support/isolated.cjs');

const endpoint = '/api/tickets/admin/orders';
const payload = (app, extra = {}) => ({ buyerProfile: app.profile, items: [{ typeId: 'normal', personId: 'buyer', holder: 'Forged name' }], paid: true, privacyConfirmed: true, ...extra });
const create = (app, extra = {}, options = {}) => app.request(endpoint, { method: 'POST', admin: true, body: payload(app, extra), ...options });
const storedOrder = (app, id) => app.snapshot().events.flatMap((e) => e.orders).find((o) => o.id === id);
const pay = (app, id, paid = true) => app.request('/api/tickets/orders/' + id + '/paid', { method: 'POST', admin: true, body: { paid } });

async function prepare(app) {
  assert.equal((await app.request('/api/tickets/types/normal', { method: 'PUT', admin: true, body: { quota: 30 } })).status, 200);
  assert.equal((await app.request('/api/persons/buyer', { method: 'PUT', admin: true, body: { steam: 'synthetic-steam', note: 'private note', clan: 'Synthetic clan' } })).status, 200);
  assert.equal((await app.request('/api/people/buyer', { method: 'PUT', admin: true, body: { seat: '1111111111', approved: true } })).status, 200);
}

test('selected cash ticket reuses the exact existing person and canonical name without changing identity or attendance', async (t) => {
  const app = await isolated(t); await prepare(app);
  const before = app.snapshot();
  const r = await create(app);
  assert.equal(r.status, 201, r.text);
  assert.equal(r.data.tickets[0].personId, 'buyer');
  assert.equal(r.data.tickets[0].personSelected, true);
  assert.equal(r.data.tickets[0].holder, 'buyer');
  assert.equal(r.data.paymentMethod, 'cash');
  assert.deepEqual(app.snapshot().persons, before.persons);
  assert.deepEqual(app.snapshot().events[0].attendees, before.events[0].attendees);
  assert.equal(storedOrder(app, r.data.id).tickets[0].personSelected, true);
});

test('pending selection joins only on payment and repeated sync never duplicates or changes ownership', async (t) => {
  const app = await isolated(t); await prepare(app);
  await app.request('/api/people/buyer', { method: 'DELETE', admin: true });
  const before = app.snapshot().persons;
  const r = await create(app, { paid: false }); assert.equal(r.status, 201, r.text);
  assert.equal(r.data.tickets[0].personId, 'buyer');
  assert.equal(app.snapshot().events[0].attendees.some((a) => a.personId === 'buyer'), false);
  assert.equal((await pay(app, r.data.id)).status, 200);
  assert.equal((await pay(app, r.data.id)).status, 200);
  assert.equal(app.snapshot().events[0].attendees.filter((a) => a.personId === 'buyer').length, 1);
  assert.deepEqual(app.snapshot().persons, before);
  const ticket = r.data.tickets[0];
  const edit = await app.request('/api/tickets/orders/' + r.data.id + '/holders', { method: 'PUT', admin: true, body: { holders: { [ticket.id]: 'Ticket display only' } } });
  assert.equal(edit.status, 200, edit.text); assert.equal(edit.data.tickets[0].personId, 'buyer');
  assert.deepEqual(app.snapshot().persons, before, 'ticket label cannot rename selected global identity');
});

test('invalid, duplicate and deleted selections fail atomically; deleted pending target cannot be paid', async (t) => {
  const app = await isolated(t); await prepare(app);
  const before = app.snapshot().events[0].orders.length;
  for (const personId of ['missing', '', null, {}, 123]) {
    const r = await create(app, { items: [{ typeId: 'normal', personId, holder: 'Ignored' }] });
    assert.ok([400, 404].includes(r.status), r.text);
    assert.equal(app.snapshot().events[0].orders.length, before);
  }
  const duplicate = await create(app, { items: [{ typeId: 'normal', personId: 'buyer' }, { typeId: 'normal', personId: 'buyer' }] });
  assert.equal(duplicate.status, 400);
  const r = await create(app, { paid: false }); assert.equal(r.status, 201, r.text);
  await app.request('/api/persons/buyer', { method: 'DELETE', admin: true });
  const current = storedOrder(app, r.data.id);
  assert.equal((await pay(app, r.data.id)).status, 409);
  assert.deepEqual(storedOrder(app, r.data.id), current, 'no payment mutation or replacement identity');
});

test('selected identity is resolved after upload and free tickets reuse it across events', async (t) => {
  const app = await isolated(t); await prepare(app);
  const staged = app.staged(endpoint, { admin: true, body: payload(app) });
  await app.request('/api/persons/buyer', { method: 'DELETE', admin: true });
  const before = app.snapshot().events[0].orders.length;
  staged.finish(); assert.equal((await staged.done).status, 404);
  assert.equal(app.snapshot().events[0].orders.length, before);
  const type = await app.request('/api/tickets/types/normal', { method: 'PUT', admin: true, headers: { 'X-Event': 'second' }, body: { price: 0, quota: 20 } });
  assert.equal(type.status, 200, type.text);
  const persons = app.snapshot().persons;
  const r = await create(app, { paid: false, items: [{ typeId: 'normal', personId: 'other' }] }, { headers: { 'X-Event': 'second' } });
  assert.equal(r.status, 201, r.text); assert.equal(r.data.status, 'paid'); assert.equal(r.data.paymentMethod, null);
  assert.equal(r.data.tickets[0].personId, 'other'); assert.deepEqual(app.snapshot().persons, persons);
});

test('admin candidate list is minimal and private; selection grants neither approval nor identity changes', async (t) => {
  const app = await isolated(t); await prepare(app);
  const r = await app.request('/api/tickets/admin', { admin: true });
  assert.equal(r.status, 200); assert.ok(r.data.persons.some((p) => p.id === 'buyer'));
  for (const p of r.data.persons) assert.deepEqual(Object.keys(p).sort(), ['discordId', 'discordName', 'id', 'name'].filter((k) => p[k] !== undefined).sort());
  assert.ok([401, 403].includes((await app.request('/api/tickets/admin', { user: 'other' })).status));
  const publicTickets = await app.request('/api/tickets'); assert.equal(publicTickets.data.persons, undefined);
  assert.ok([401, 403].includes((await create(app, {}, { admin: false, user: 'other' })).status));
  await app.request('/api/people/buyer', { method: 'DELETE', admin: true });
  const b = await create(app); assert.equal(b.status, 201);
  const attendee = app.snapshot().events[0].attendees.find((a) => a.personId === 'buyer');
  assert.equal(attendee.approved, false); assert.equal(attendee.seat, null);
});

test('public online orders cannot inject selected-person identity or the privileged marker', async (t) => {
  const app = await isolated(t); await prepare(app);
  const before = app.snapshot().persons;
  const r = await app.request('/api/tickets/orders', { method: 'POST', user: 'buyer', body: {
    items: [{ typeId: 'normal', holder: 'other', personId: 'other', personSelected: true }],
  } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.data.tickets[0].personSelected, undefined);
  assert.equal(r.data.tickets[0].personId, undefined);
  assert.equal((await pay(app, r.data.id)).status, 200);
  const ticket = storedOrder(app, r.data.id).tickets[0];
  assert.notEqual(ticket.personId, 'other');
  assert.equal(ticket.personSelected, undefined);
  for (const p of before) assert.deepEqual(app.snapshot().persons.find((x) => x.id === p.id), p);
});
