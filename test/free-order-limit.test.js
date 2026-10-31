'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isolated } = require('../test-support/isolated.cjs');

const stamp = new Date().toISOString();
// Kostenlose, kontingentfreie Ticketart; „buyer“ hat davon bereits eins (gespeicherter Stand wie nach einem Neustart).
const prepare = (data) => {
  for (const e of data.events) e.ticketTypes.push({ id: 'free', name: 'Gratis', active: true, price: 0, quota: null, maxPerOrder: 3, participant: false });
  data.events[0].orders.push({ id: 'first-free', ref: 'first-free', accountId: 'buyer', status: 'paid', createdAt: stamp, dueAt: stamp, paidAt: stamp, total: 0,
    tickets: [{ id: 'first-free-ticket', code: 'FIRST-FREE-SYNTHETIC', typeId: 'free', holder: 'Synthetic Free', price: 0 }] });
};
const order = (app, user, n, event = 'first') => app.request('/api/tickets/orders', { method: 'POST', user, headers: { 'X-Event': event },
  body: { items: Array.from({ length: n }, (_, i) => ({ typeId: 'free', holder: `Synthetic ${i}` })) } });
const freeTickets = (app, user, event = 'first') => app.snapshot().events.find((e) => e.id === event).orders
  .filter((o) => o.accountId === user && o.status === 'paid').flatMap((o) => o.tickets).filter((t) => t.typeId === 'free').length;

test('Gratistickets: Grenze je Konto und Event gilt über mehrere Bestellungen und gespeicherte Bestellungen hinweg', async (t) => {
  const app = await isolated(t, { prepare });
  assert.equal((await order(app, 'buyer', 2)).status, 201, 'unter der Grenze');
  const over = await order(app, 'buyer', 1);
  assert.equal(over.status, 409);
  assert.match(over.data.error, /Höchstens 3 × „Gratis“ pro Konto – du hast schon 3/);
  assert.equal(freeTickets(app, 'buyer'), 3, 'bestehendes Ticket bleibt, nichts darüber hinaus');

  // Andere Konten und andere Events haben ein eigenes Budget; bezahlte Tickets bleiben unberührt
  assert.equal((await order(app, 'buyer', 3, 'second')).status, 201);
  assert.equal(app.snapshot().events[0].orders.find((o) => o.id === 'first-buyer').status, 'paid');

  // Parallele Einzelbestellungen überschreiten die Grenze nicht
  const burst = await Promise.all(Array.from({ length: 5 }, () => order(app, 'other', 1)));
  assert.deepEqual(burst.map((r) => r.status).sort(), [201, 201, 201, 409, 409]);
  assert.equal(freeTickets(app, 'other'), 3);
});

test('Gratistickets: stornierte Bestellungen geben das Budget wieder frei', async (t) => {
  const app = await isolated(t, { prepare });
  assert.equal((await order(app, 'buyer', 3)).status, 409, 'gespeichertes Ticket zählt mit');
  const cancel = await app.request('/api/tickets/orders/first-free/cancel', { method: 'POST', admin: true });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.data));
  assert.equal((await order(app, 'buyer', 3)).status, 201);
  assert.equal(freeTickets(app, 'buyer'), 3);
});
