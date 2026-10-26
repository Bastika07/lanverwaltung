'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isolated } = require('../test-support/isolated.cjs');
const { openStore, readSnapshot } = require('../lib/storage');
const pause = () => new Promise((r) => setTimeout(r, 100));

async function setup(t) {
  const app = await isolated(t);
  assert.equal((await app.request('/api/settings', { method: 'PUT', admin: true, body: { modules: { catering: true } } })).status, 200);
  app.offer = async (body = {}) => {
    const response = await app.request('/api/catering/offers', { method: 'POST', admin: true, body: { title: 'Grillbuffet', price: 1250, ...body } });
    assert.equal(response.status, 201, response.text); return response.data;
  };
  app.signup = (offerId, guestKey, user = 'buyer', extra = {}) => app.request('/api/catering/entries', { method: 'POST', user, body: { offerId, guestKey, ...extra } });
  return app;
}

test('catering: self signup, admin assignment/payment, private lists and retained prices', async (t) => {
  const app = await setup(t), offer = await app.offer();
  const created = await app.signup(offer.id, 'person:buyer');
  assert.equal(created.status, 201); assert.equal(created.data.paidAt, null); assert.equal(created.data.price, 1250);
  assert.equal((await app.signup(offer.id, 'person:buyer')).status, 409);
  const assigned = await app.request('/api/catering/entries', { method: 'POST', admin: true, body: { offerId: offer.id, guestKey: 'person:other' } });
  assert.equal(assigned.status, 201);
  const paid = await app.request('/api/catering/entries/' + assigned.data.id, { method: 'PUT', admin: true, body: { paid: true, version: 1 } });
  assert.equal(paid.status, 200); assert.ok(paid.data.paidAt);
  const mine = await app.request('/api/catering', { user: 'buyer' });
  assert.equal(mine.data.entries.length, 1); assert.equal(mine.data.entries[0].name, 'buyer');
  assert.ok(!mine.text.includes(assigned.data.id)); assert.ok(!mine.text.includes('person:other'));
  const other = await app.request('/api/catering', { user: 'other' });
  assert.equal(other.data.entries[0].paidAt, paid.data.paidAt);
  const anonymous = await app.request('/api/catering');
  assert.deepEqual(anonymous.data.entries, []); assert.deepEqual(anonymous.data.guests, []);
  assert.equal(anonymous.data.offers[0].registered, 2);
  assert.equal((await app.request('/api/catering/offers/' + offer.id, { method: 'PUT', admin: true, body: { price: 2000, version: 1 } })).status, 200);
  const data = app.snapshot().events[0].catering;
  assert.equal(data.offers[0].price, 2000); assert.deepEqual(data.entries.map((e) => e.price), [1250, 1250]);
  assert.equal((await app.request('/api/catering/admin', { admin: true })).data.entries.length, 2);
});

test('catering: opted-in price updates reprice only unpaid entries of the selected offer', async (t) => {
  const app = await setup(t), offer = await app.offer(), other = await app.offer();
  const unpaid = (await app.signup(offer.id, 'person:buyer')).data;
  const paid = (await app.signup(offer.id, 'person:other', 'other')).data;
  const unrelated = (await app.signup(other.id, 'person:buyer')).data;
  const payment = await app.request('/api/catering/entries/' + paid.id, { method: 'PUT', admin: true, body: { paid: true, version: paid.version } });
  assert.equal(payment.status, 200);
  const update = await app.request('/api/catering/offers/' + offer.id, { method: 'PUT', admin: true,
    body: { price: 2000, version: offer.version, updateUnpaidPrices: true } });
  assert.equal(update.status, 200, update.text);
  const data = (await app.request('/api/catering/admin', { admin: true })).data;
  const revised = data.entries.find((e) => e.id === unpaid.id);
  assert.equal(revised.price, 2000);
  assert.equal(revised.version, unpaid.version + 1);
  assert.deepEqual(data.entries.find((e) => e.id === paid.id), payment.data);
  assert.deepEqual(data.entries.find((e) => e.id === unrelated.id), unrelated);
  assert.equal((await app.request('/api/catering', { user: 'buyer' })).data.entries.find((e) => e.id === unpaid.id).price, 2000);
  assert.equal(app.snapshot().events[0].catering.entries.find((e) => e.id === unpaid.id).price, 2000);
  assert.equal((await app.request('/api/catering/entries/' + unpaid.id, { method: 'PUT', admin: true,
    body: { paid: true, version: unpaid.version } })).status, 409);
  assert.equal((await app.request('/api/catering/entries/' + unpaid.id, { method: 'DELETE', user: 'buyer',
    body: { version: unpaid.version } })).status, 409);
});

test('catering: bulk price option rejects invalid values without changing any saved data', async (t) => {
  const app = await setup(t), offer = await app.offer();
  await app.signup(offer.id, 'person:buyer');
  const before = app.snapshot();
  for (const updateUnpaidPrices of ['true', 'false', 1, 0, null, {}, []]) {
    const response = await app.request('/api/catering/offers/' + offer.id, { method: 'PUT', admin: true,
      body: { price: 2000, version: offer.version, updateUnpaidPrices } });
    assert.equal(response.status, 400, JSON.stringify(updateUnpaidPrices));
    assert.deepEqual(app.snapshot(), before);
  }
});

test('catering: repricing is optional, supports free offers and invalidates only changed entries', async (t) => {
  const app = await setup(t), offer = await app.offer();
  const entry = (await app.signup(offer.id, 'person:buyer')).data;
  const url = '/api/catering/offers/' + offer.id;
  assert.equal((await app.request(url, { method: 'PUT', admin: true,
    body: { price: 2000, version: 1, updateUnpaidPrices: false } })).status, 200);
  assert.deepEqual((await app.request('/api/catering/admin', { admin: true })).data.entries[0], entry);
  assert.equal((await app.request(url, { method: 'PUT', admin: true,
    body: { price: 1250, version: 2, updateUnpaidPrices: true } })).status, 200);
  assert.deepEqual((await app.request('/api/catering/admin', { admin: true })).data.entries[0], entry);
  assert.equal((await app.request(url, { method: 'PUT', admin: true,
    body: { price: 0, version: 3, updateUnpaidPrices: true } })).status, 200);
  const revised = (await app.request('/api/catering/admin', { admin: true })).data.entries[0];
  assert.equal(revised.price, 0); assert.equal(revised.version, 2); assert.equal(revised.paidAt, null);
});

test('catering: staged repricing respects current payment state and event/admin boundaries', async (t) => {
  const app = await setup(t), offer = await app.offer();
  const entry = (await app.signup(offer.id, 'person:buyer')).data;
  const url = '/api/catering/offers/' + offer.id;
  const body = { price: 2000, version: 1, updateUnpaidPrices: true };
  for (const options of [{ user: 'buyer' }, { admin: true, headers: { Origin: 'https://foreign.invalid' } },
    { admin: true, headers: { 'X-Event': 'second' } }]) {
    const response = await app.request(url, { ...options, method: 'PUT', body });
    assert.equal(response.status, options.user ? 401 : options.headers.Origin ? 403 : 404);
  }
  const pending = app.staged(url, { method: 'PUT', admin: true, body });
  await pause();
  const payment = await app.request('/api/catering/entries/' + entry.id, { method: 'PUT', admin: true,
    body: { paid: true, version: 1 } });
  assert.equal(payment.status, 200);
  pending.finish(); assert.equal((await pending.done).status, 200);
  assert.deepEqual((await app.request('/api/catering/admin', { admin: true })).data.entries[0], payment.data);
  assert.equal((await app.request(url, { method: 'PUT', admin: true, body })).status, 409);
});

test('catering: anonymous/fremde guests cannot assign, pay or cancel; CSRF and payment spoofing rejected', async (t) => {
  const app = await setup(t), offer = await app.offer();
  const entry = (await app.signup(offer.id, 'person:buyer')).data;
  assert.equal((await app.signup(offer.id, 'person:other')).status, 403);
  assert.equal((await app.signup(offer.id, 'person:buyer', 'outsider')).status, 403);
  assert.equal((await app.request('/api/catering/entries', { method: 'POST', body: { offerId: offer.id, guestKey: 'person:buyer' } })).status, 401);
  for (const body of [{ paid: true }, { paidAt: '2026-01-01' }, { price: 0 }]) {
    assert.equal((await app.signup(offer.id, 'person:other', 'other', body)).status, 400);
  }
  for (const user of [undefined, 'buyer', 'outsider']) {
    assert.equal((await app.request('/api/catering/admin', { user })).status, 401);
    assert.equal((await app.request('/api/catering/offers', { method: 'POST', user, body: { title: 'Unauthorized' } })).status, 401);
    assert.equal((await app.request('/api/catering/entries/' + entry.id, { method: 'PUT', user, body: { paid: true, version: 1 } })).status, user === 'outsider' ? 403 : 401);
  }
  assert.equal((await app.request('/api/catering/entries/' + entry.id, { method: 'DELETE', user: 'other', body: { version: 1 } })).status, 403);
  assert.equal((await app.request('/api/catering/entries/' + entry.id, { method: 'PUT', admin: true, body: { paid: true, version: 1 }, headers: { Origin: 'https://foreign.invalid' } })).status, 403);
  assert.equal(app.snapshot().events[0].catering.entries[0].paidAt, null);
});

test('catering: logged-in guest without a ticket can enroll self but gains no membership', async (t) => {
  const app = await setup(t), offer = await app.offer();
  const response = await app.signup(offer.id, 'account:outsider', 'outsider');
  assert.equal(response.status, 201);
  assert.deepEqual((await app.request('/api/catering', { user: 'outsider' })).data.entries.map((e) => e.id), [response.data.id]);
  assert.equal((await app.request('/api/info', { user: 'outsider' })).status, 403);
  assert.equal((await app.request('/api/me', { user: 'outsider' })).data.member, false);
  await app.request('/api/settings', { method: 'PUT', admin: true, body: { access: { catering: 'tickets' } } });
  assert.equal((await app.request('/api/catering', { user: 'outsider' })).status, 403);
  assert.equal((await app.signup(offer.id, 'account:outsider', 'outsider')).status, 403);
  assert.equal((await app.request('/api/catering', { user: 'buyer' })).status, 200);
});

test('catering: capacities and duplicate signup are atomic under concurrent requests', async (t) => {
  const app = await setup(t), offer = await app.offer({ capacity: 1 });
  const responses = await Promise.all(['buyer', 'other'].map((u) => app.signup(offer.id, 'person:' + u, u)));
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  assert.equal((await app.request('/api/catering/entries', { method: 'POST', admin: true, body: { offerId: offer.id, guestKey: 'account:outsider' } })).status, 409);
  const second = await app.offer();
  const duplicates = await Promise.all([app.signup(second.id, 'person:buyer'), app.signup(second.id, 'person:buyer')]);
  assert.deepEqual(duplicates.map((r) => r.status).sort(), [201, 409]);
});

test('catering: paid history is protected; cancellation and stale payment versions cannot erase it', async (t) => {
  const app = await setup(t), offer = await app.offer();
  const entry = (await app.signup(offer.id, 'person:buyer')).data, url = '/api/catering/entries/' + entry.id;
  assert.equal((await app.request(url, { method: 'PUT', admin: true, body: { paid: true, version: 1 } })).status, 200);
  assert.equal((await app.request(url, { method: 'PUT', admin: true, body: { paid: false, version: 1 } })).status, 409);
  for (const options of [{ user: 'buyer' }, { admin: true }]) assert.equal((await app.request(url, { ...options, method: 'DELETE', body: { version: 2 } })).status, 409);
  assert.equal((await app.request('/api/catering/offers/' + offer.id, { method: 'DELETE', admin: true, body: { version: 1 } })).status, 409);
  assert.equal((await app.request('/api/event/first', { method: 'DELETE', admin: true })).status, 400);
  assert.equal((await app.request(url, { method: 'PUT', admin: true, body: { paid: false, version: 2 } })).status, 200);
  assert.equal((await app.request(url, { method: 'DELETE', user: 'buyer', body: { version: 3 } })).status, 200);
  assert.equal((await app.request('/api/catering/offers/' + offer.id, { method: 'DELETE', admin: true, body: { version: 1 } })).status, 200);
});

test('catering: deadlines, closed offers, disabled modules and event boundaries are enforced', async (t) => {
  const app = await setup(t), closed = await app.offer({ open: false }), expired = await app.offer({ deadline: '2000-01-01T00:00:00Z' });
  assert.equal((await app.signup(closed.id, 'person:buyer')).status, 400);
  assert.equal((await app.signup(expired.id, 'person:buyer')).status, 400);
  const assigned = await app.request('/api/catering/entries', { method: 'POST', admin: true, body: { offerId: closed.id, guestKey: 'person:buyer' } });
  assert.equal(assigned.status, 201);
  assert.equal((await app.request('/api/catering/entries/' + assigned.data.id, { method: 'DELETE', user: 'buyer', body: { version: 1 } })).status, 400);
  const second = await app.request('/api/catering/admin', { admin: true, headers: { 'X-Event': 'second' } });
  assert.deepEqual(second.data.offers, []); assert.deepEqual(second.data.entries, []);
  assert.equal((await app.request('/api/catering/entries/' + assigned.data.id, { method: 'PUT', admin: true, headers: { 'X-Event': 'second' }, body: { paid: true, version: 1 } })).status, 404);
  // Visitors cannot use X-Event to read a different event's catering; current event stays authoritative.
  assert.equal((await app.request('/api/catering', { user: 'buyer', headers: { 'X-Event': 'second' } })).data.offers.length, 2);
  await app.request('/api/settings', { method: 'PUT', admin: true, body: { modules: { catering: false } } });
  assert.equal((await app.request('/api/catering', { user: 'buyer' })).status, 404);
  assert.equal((await app.signup(closed.id, 'person:buyer')).status, 404);
  assert.equal((await app.request('/api/catering/admin', { admin: true })).status, 200);
});

test('catering: in-flight upload rechecks offer/module policy, account session and admin logout', async (t) => {
  const app = await setup(t), offer = await app.offer();
  const pending = app.staged('/api/catering/entries', { user: 'buyer', body: { offerId: offer.id, guestKey: 'person:buyer' } });
  await pause();
  await app.request('/api/catering/offers/' + offer.id, { method: 'PUT', admin: true, body: { open: false, version: 1 } });
  pending.finish(); assert.equal((await pending.done).status, 400);
  const open = await app.offer();
  const blocked = app.staged('/api/catering/entries', { user: 'buyer', body: { offerId: open.id, guestKey: 'person:buyer' } });
  await pause(); await app.request('/api/settings', { method: 'PUT', admin: true, body: { modules: { catering: false } } });
  blocked.finish(); assert.equal((await blocked.done).status, 404);
  await app.request('/api/settings', { method: 'PUT', admin: true, body: { modules: { catering: true } } });
  const loggedOut = app.staged('/api/catering/entries', { user: 'outsider', body: { offerId: open.id, guestKey: 'account:outsider' } });
  await pause(); await app.request('/api/auth/logout', { method: 'POST', user: 'outsider' });
  loggedOut.finish(); assert.equal((await loggedOut.done).status, 401);
  const admin = app.staged('/api/catering/offers', { admin: true, body: { title: 'Revoked' } });
  await pause(); await app.request('/api/logout', { method: 'POST', admin: true });
  admin.finish(); assert.equal((await admin.done).status, 401);
  assert.equal(app.snapshot().events[0].catering.entries.length, 0);
});

test('catering: bounded malformed values return client errors and do not mutate saved state', async (t) => {
  const app = await setup(t), offer = await app.offer();
  for (const [field, values] of Object.entries({ title: [{ toString: null }, []], price: [-1, 1.5, {}, '100', 1000001], capacity: [-1, 1.5, {}, 10001], open: ['false', 0, {}], deadline: [42, {}, 'not-a-date'] })) {
    for (const value of values) {
      const response = await app.request('/api/catering/offers', { method: 'POST', admin: true, body: { title: 'Test', [field]: value } });
      assert.equal(response.status, 400, `${field}: ${JSON.stringify(value)} ${response.text}`);
    }
  }
  assert.equal((await app.request('/api/catering/offers/' + offer.id, { method: 'PUT', admin: true, body: { version: 99, price: 0 } })).status, 409);
  const data = app.snapshot().events[0].catering;
  assert.equal(data.offers.length, 1); assert.equal(data.offers[0].price, 1250); assert.equal(data.entries.length, 0);
});

test('catering: account erasure removes associations while paid entries remain pseudonymous', async (t) => {
  const app = await setup(t), offer = await app.offer();
  const own = (await app.signup(offer.id, 'account:outsider', 'outsider')).data;
  await app.request('/api/catering/entries/' + own.id, { method: 'PUT', admin: true, body: { paid: true, version: 1 } });
  assert.equal((await app.request('/api/account', { method: 'DELETE', user: 'outsider' })).status, 200);
  const saved = app.snapshot().events[0].catering.entries[0];
  assert.equal(saved.accountId, null); assert.equal(saved.personId, null); assert.ok(saved.paidAt);
  assert.ok(!JSON.stringify(saved).includes('outsider'));
  assert.equal((await app.request('/api/catering/admin', { admin: true })).data.entries[0].name, 'Gelöschtes Konto');
});

test('catering: SQLite event payload round-trip preserves catering and unrelated legacy data without schema change', (t) => {
  const directory = fs.mkdtempSync(path.join(process.env.OPENCODE_TEST_TMP || os.tmpdir(), 'catering-storage-'));
  let store;
  t.after(() => { if (store) store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const state = { events: [{ id: 'event', extra: { legacy: true }, catering: { offers: [{ id: 'offer', price: 1234 }], entries: [{ id: 'entry', offerId: 'offer', personId: 'person', paidAt: '2026-10-24T00:00:00Z' }] } }], untouched: ['legacy', { value: 42 }] };
  fs.writeFileSync(path.join(directory, 'db.json'), JSON.stringify(state));
  store = openStore(directory); assert.deepEqual(store.data, state);
  store.save(store.data); store.close(); store = null;
  assert.deepEqual(readSnapshot(path.join(directory, 'db.sqlite')), state);
  store = openStore(directory); assert.deepEqual(store.data, state);
});

test('catering: person merges preserve assignments and reject duplicate offer registrations atomically', async (t) => {
  const app = await setup(t), offer = await app.offer();
  const add = async (name) => (await app.request('/api/people', { method: 'POST', admin: true, body: { name } })).data;
  const first = await add('Catering A'), second = await add('Catering B'), third = await add('Catering C');
  for (const p of [first, second]) assert.equal((await app.request('/api/catering/entries', { method: 'POST', admin: true, body: { offerId: offer.id, guestKey: 'person:' + p.id } })).status, 201);
  assert.equal((await app.request('/api/persons/' + first.id + '/merge', { method: 'POST', admin: true, body: { into: second.id } })).status, 409);
  assert.equal(app.snapshot().events[0].catering.entries[0].personId, first.id);
  assert.equal((await app.request('/api/persons/' + first.id + '/merge', { method: 'POST', admin: true, body: { into: third.id } })).status, 200);
  assert.equal(app.snapshot().events[0].catering.entries[0].personId, third.id);
  assert.equal((await app.request('/api/catering/admin', { admin: true })).data.entries[0].name, 'Catering C');
});

test('catering: copying an event copies closed offers, never registrations or payments', async (t) => {
  const app = await setup(t), offer = await app.offer({ deadline: '2099-01-01T00:00:00Z' });
  await app.signup(offer.id, 'person:buyer');
  const copied = await app.request('/api/event', { method: 'POST', admin: true, body: { name: 'Copy', copyFrom: 'first' } });
  assert.equal(copied.status, 201);
  const event = app.snapshot().events.find((e) => e.id === copied.data.id);
  assert.equal(event.catering.offers.length, 1); assert.equal(event.catering.entries.length, 0);
  assert.notEqual(event.catering.offers[0].id, offer.id); assert.equal(event.catering.offers[0].open, false);
  assert.equal(event.catering.offers[0].deadline, null);
  assert.equal((await app.request('/api/catering/entries', { method: 'POST', admin: true, headers: { 'X-Event': event.id },
    body: { offerId: event.catering.offers[0].id, guestKey: 'account:outsider' } })).status, 201);
  const deleted = await app.request('/api/event/' + event.id, { method: 'DELETE', admin: true });
  assert.equal(deleted.status, 400); assert.match(deleted.data.error, /Catering/);
});

test('catering: payment during a pending cancellation cannot be erased; ended event rejects self signup', async (t) => {
  const app = await setup(t), offer = await app.offer();
  const entry = (await app.signup(offer.id, 'person:buyer')).data;
  const pending = app.staged('/api/catering/entries/' + entry.id, { method: 'DELETE', user: 'buyer', body: { version: 1 } });
  await pause();
  assert.equal((await app.request('/api/catering/entries/' + entry.id, { method: 'PUT', admin: true, body: { paid: true, version: 1 } })).status, 200);
  pending.finish(); assert.equal((await pending.done).status, 409);
  await app.request('/api/event/first', { method: 'PUT', admin: true, body: { end: '2000-01-01T00:00:00Z' } });
  await app.request('/api/event/second', { method: 'PUT', admin: true, body: { end: '2000-01-01T00:00:00Z' } });
  // With both events ended, the most recently ended one is current for visitors.
  await app.request('/api/event/first/start', { method: 'POST', admin: true });
  await app.request('/api/event/first/end', { method: 'POST', admin: true });
  const archived = await app.request('/api/catering/admin', { admin: true });
  assert.equal(archived.data.over, true); assert.equal(archived.data.offers[0].available, false);
  assert.equal((await app.signup(offer.id, 'person:other', 'other')).status, 400);
  assert.ok(app.snapshot().events[0].catering.entries[0].paidAt);
});
