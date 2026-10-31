'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isolated } = require('../test-support/isolated.cjs');

const stamp = new Date().toISOString();
const SEAT = '1111111111';
const withSeats = (extra) => (data) => {
  data.seating.seats.push({ id: '2222222222', x: 1, y: 0, label: '2', locked: true });
  if (extra) extra(data);
};
const reserve = (app, user, ticketId) => app.request('/api/seats/reserve', { method: 'POST', user, body: { ticketId, seatId: SEAT } });
const cancel = (app) => app.request('/api/tickets/orders/first-buyer/cancel', { method: 'POST', admin: true });
const attendee = (app) => app.snapshot().events.find((e) => e.id === 'first').attendees.find((a) => a.personId === 'buyer');

test('Storno: Platz wird frei, Teilnahme ohne Orga-Freigabe entfällt', async (t) => {
  const app = await isolated(t, { prepare: withSeats() });
  assert.equal((await reserve(app, 'buyer', 'first-ticket-buyer')).status, 200);
  assert.equal((await cancel(app)).status, 200);
  assert.equal(attendee(app), undefined);
  assert.deepEqual((await app.request('/api/people', { user: 'other' })).data.people.map((p) => p.name), ['other']);
  assert.equal((await reserve(app, 'other', 'first-ticket-other')).status, 200, 'seat is free for others');
});

test('Zahlungsrücknahme gibt den Platz frei; erneute Zahlung stellt nur die Teilnahme wieder her', async (t) => {
  const app = await isolated(t, { prepare: withSeats() });
  assert.equal((await reserve(app, 'buyer', 'first-ticket-buyer')).status, 200);
  const unpaid = await app.request('/api/tickets/orders/first-buyer/paid', { method: 'POST', admin: true, body: { paid: false } });
  assert.equal(unpaid.status, 200, JSON.stringify(unpaid.data));
  assert.equal(attendee(app), undefined);
  const paid = await app.request('/api/tickets/orders/first-buyer/paid', { method: 'POST', admin: true, body: { paid: true } });
  assert.equal(paid.status, 200, JSON.stringify(paid.data));
  assert.equal(attendee(app).seat, null, 'participation restored, seat must be chosen again');
});

test('Orga-Freigabe, weiteres gültiges Ticket und gesperrte Orga-Plätze bleiben erhalten', async (t) => {
  const approved = await isolated(t, { prepare: withSeats((d) => { d.events[0].attendees[0].approved = true; }) });
  assert.equal((await reserve(approved, 'buyer', 'first-ticket-buyer')).status, 200);
  assert.equal((await cancel(approved)).status, 200);
  assert.equal(attendee(approved).seat, SEAT, 'approved attendee keeps seat');

  const second = await isolated(t, { prepare: withSeats((d) => d.events[0].orders.push({ id: 'first-second', ref: 'first-second', accountId: 'buyer', status: 'paid',
    createdAt: stamp, dueAt: stamp, total: 1000, tickets: [{ id: 'first-ticket-second', code: 'FIRST-SECOND-SYNTHETIC', typeId: 'normal', holder: 'buyer', personId: 'buyer', price: 1000 }] })) });
  assert.equal((await reserve(second, 'buyer', 'first-ticket-buyer')).status, 200);
  assert.equal((await cancel(second)).status, 200);
  assert.equal(attendee(second).seat, SEAT, 'another valid participant ticket keeps the seat');

  const locked = await isolated(t, { prepare: withSeats() });
  const placed = await locked.request('/api/people/buyer', { method: 'PUT', admin: true, body: { seat: '2222222222' } });
  assert.equal(placed.status, 200, JSON.stringify(placed.data));
  assert.equal((await cancel(locked)).status, 200);
  assert.equal(attendee(locked).seat, '2222222222', 'orga placement on a locked seat stays');
});
