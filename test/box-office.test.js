'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isolated } = require('../test-support/isolated.cjs');

const endpoint = '/api/tickets/admin/orders';
const payload = (app, extra = {}) => ({ buyerProfile: app.profile, items: [{ typeId: 'normal', holder: 'Synthetic Holder' }], paid: false, privacyConfirmed: true, ...extra });
const create = (app, extra = {}, options = {}) => app.request(endpoint, { method: 'POST', admin: true, body: payload(app, extra), ...options });

test('box office: pending order stores a cleaned private buyer without a Discord account', async (t) => {
  const app = await isolated(t);
  const before = app.snapshot();
  const r = await create(app, { buyerProfile: { ...app.profile, firstName: '  Walk-in  ', ignored: 'discard' }, total: 1, ref: 'FORGED', accountId: 'buyer' });
  assert.equal(r.status, 201, r.text);
  const o = r.data;
  assert.equal(o.status, 'pending');
  assert.equal(o.source, 'box_office');
  assert.equal(o.accountId, null);
  assert.equal(o.paymentMethod, null);
  assert.equal(o.version, 1);
  assert.equal(o.total, 1000);
  assert.equal(o.buyerName, 'Walk-in Test');
  assert.deepEqual(o.buyer.profile, { ...app.profile, firstName: 'Walk-in' });
  assert.equal(o.buyer.age, new Date().getFullYear() - 1990);
  assert.match(o.ref, /^LAN-[A-Z2-9]{6}$/);
  assert.match(o.tickets[0].code, /^[A-F0-9]{32}$/);
  assert.equal(o.tickets[0].price, 1000);
  assert.ok(o.privacyConfirmedAt);
  assert.equal(o.tickets[0].personId, undefined);
  const stored = app.snapshot();
  assert.deepEqual(stored.accounts, before.accounts);
  assert.deepEqual(stored.persons, before.persons);
  assert.deepEqual(stored.events[0].orders.find((x) => x.id === o.id).buyerProfile, o.buyer.profile);
  assert.ok(!(await app.request('/api/tickets')).text.includes('Walk-in'));
  assert.ok(!(await app.request('/api/tickets/mine', { user: 'buyer' })).text.includes(o.id));
  assert.ok(!(await app.request('/api/tickets/mine', { user: 'other' })).text.includes(o.id));
});

test('box office: cash and free tickets are valid, uniquely owned, exported and usable at check-in', async (t) => {
  const app = await isolated(t);
  const r = await create(app, { paid: true }); assert.equal(r.status, 201, r.text);
  const o = r.data;
  assert.equal(o.status, 'paid'); assert.equal(o.paymentMethod, 'cash'); assert.ok(o.paidAt);
  assert.ok(o.tickets[0].personId);
  const person = app.snapshot().persons.find((p) => p.id === o.tickets[0].personId);
  assert.equal(person.ticketOwnerId, 'order:' + o.id); assert.equal(person.discordId || null, null);
  assert.equal((await app.request('/api/tickets/checkin/' + o.tickets[0].code, { method: 'POST', admin: true, body: {} })).status, 200);
  const csv = await app.request('/api/tickets/export.csv', { admin: true });
  assert.equal(csv.status, 200); assert.ok(csv.text.includes(app.profile.street)); assert.ok(csv.text.includes(o.tickets[0].code));
  assert.equal((await app.request('/api/tickets/orders/' + o.id + '/holders', { method: 'PUT', admin: true, body: { holders: { [o.tickets[0].id]: 'New holder' } } })).status, 200);
  assert.equal(app.snapshot().persons.find((p) => p.id === person.id).name, 'New holder');
  await app.request('/api/tickets/orders/' + o.id + '/paid', { method: 'POST', admin: true, body: { paid: false } });
  assert.equal(app.snapshot().events[0].orders.find((x) => x.id === o.id).paymentMethod, null);
  const type = await app.request('/api/tickets/types', { method: 'POST', admin: true, body: { name: 'Free', price: 0, quota: 3 } });
  assert.equal(type.status, 201, type.text);
  const free = await create(app, { items: [{ typeId: type.data.id, holder: 'Free holder' }], paid: true });
  assert.equal(free.status, 201, free.text); assert.equal(free.data.status, 'paid'); assert.equal(free.data.paymentMethod, null);
});

test('box office: manual buyer edits are versioned, event-bound and leave ticket state and online profiles unchanged', async (t) => {
  const app = await isolated(t); const o = (await create(app, { paid: true })).data;
  const path = '/api/tickets/orders/' + o.id + '/buyer';
  const buyerProfile = { ...app.profile, firstName: 'Corrected', city: 'New city' };
  const before = app.snapshot();
  assert.equal((await app.request(path, { method: 'PUT', admin: true, headers: { 'X-Event': 'second' }, body: { buyerProfile, version: 1 } })).status, 404);
  const edit = await app.request(path, { method: 'PUT', admin: true, body: { buyerProfile, version: 1 } });
  assert.equal(edit.status, 200, edit.text); assert.equal(edit.data.version, 2); assert.deepEqual(edit.data.buyer.profile, buyerProfile);
  assert.deepEqual(edit.data.tickets, o.tickets); assert.equal(edit.data.status, 'paid'); assert.equal(edit.data.total, o.total);
  assert.deepEqual(app.snapshot().accounts, before.accounts);
  assert.equal((await app.request(path, { method: 'PUT', admin: true, body: { buyerProfile: app.profile, version: 1 } })).status, 409);
  assert.equal((await app.request('/api/tickets/orders/first-buyer/buyer', { method: 'PUT', admin: true, body: { buyerProfile, version: 1 } })).status, 400);
  assert.equal(app.snapshot().events[0].orders.find((x) => x.id === o.id).buyerProfile.firstName, 'Corrected');
});

test('box office: rejects unauthorized writes, CSRF, invalid inputs and stale admin upload sessions without mutation', async (t) => {
  const app = await isolated(t); const before = app.snapshot();
  for (const options of [{ admin: false }, { admin: false, user: 'buyer' }, { headers: { Origin: 'https://evil.invalid' } }]) {
    const r = await create(app, {}, options); assert.ok([401, 403].includes(r.status), r.text);
  }
  for (const bad of [{ paid: 'true' }, { paid: null }, { privacyConfirmed: false }, { buyerProfile: null }, { buyerProfile: [] },
    { buyerProfile: { ...app.profile, firstName: ['Test'] } }, { buyerProfile: { ...app.profile, birthdate: '1990-02-31' } },
    { buyerProfile: { ...app.profile, email: 'bad' } }, { items: [] }, { items: [null] }, { items: [{ typeId: 'missing', holder: 'A' }] },
    { items: [{ typeId: 'normal', holder: '' }] }, { items: Array(51).fill({ typeId: 'normal', holder: 'A' }) }]) {
    const r = await create(app, bad); assert.equal(r.status, 400, JSON.stringify(bad) + ': ' + r.text);
  }
  assert.deepEqual(app.snapshot(), before);
  const staged = app.staged(endpoint, { admin: true, body: payload(app) });
  await new Promise((r) => setTimeout(r, 40)); await app.request('/api/logout', { method: 'POST', admin: true }); staged.finish();
  assert.equal((await staged.done).status, 401);
  await app.login(); const o = (await create(app)).data;
  const edit = app.staged('/api/tickets/orders/' + o.id + '/buyer', { method: 'PUT', admin: true, body: { buyerProfile: { ...app.profile, city: 'Forbidden' }, version: 1 } });
  await new Promise((r) => setTimeout(r, 40)); await app.request('/api/logout', { method: 'POST', admin: true }); edit.finish();
  assert.equal((await edit.done).status, 401);
  assert.equal(app.snapshot().events[0].orders.find((x) => x.id === o.id).buyerProfile.city, app.profile.city);
});

test('box office: bypasses only presale windows and never oversells quota under concurrent requests', async (t) => {
  const app = await isolated(t);
  await app.request('/api/tickets/settings', { method: 'PUT', admin: true, body: { saleOpen: false } });
  await app.request('/api/tickets/types/normal', { method: 'PUT', admin: true, body: { saleEnd: '2000-01-01' } });
  const results = await Promise.all([create(app, { paid: true }), create(app, { paid: true })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(app.snapshot().events[0].orders.length, 3);
  await app.request('/api/tickets/types/normal', { method: 'PUT', admin: true, body: { quota: 20, maxPerOrder: 1 } });
  assert.equal((await create(app, { items: [{ typeId: 'normal', holder: 'A' }, { typeId: 'normal', holder: 'B' }] })).status, 400);
  await app.request('/api/tickets/types/normal', { method: 'PUT', admin: true, body: { active: false } });
  assert.equal((await create(app)).status, 400);
  await app.request('/api/tickets/types/normal', { method: 'PUT', admin: true, body: { active: true } });
  await app.request('/api/tickets/settings', { method: 'PUT', admin: true, body: { minAge: 99 } });
  assert.equal((await create(app)).status, 400);
});

test('box office: delayed bookings use current age rules and reject an ended event', async (t) => {
  const app = await isolated(t);
  const pending = app.staged(endpoint, { admin: true, body: payload(app) });
  await new Promise((r) => setTimeout(r, 40));
  await app.request('/api/tickets/settings', { method: 'PUT', admin: true, body: { minAge: 99 } });
  pending.finish(); assert.equal((await pending.done).status, 400);
  await app.request('/api/tickets/settings', { method: 'PUT', admin: true, body: { minAge: 0 } });
  assert.equal((await app.request('/api/event/first/start', { method: 'POST', admin: true, body: {} })).status, 200);
  assert.equal((await app.request('/api/event/first/end', { method: 'POST', admin: true, body: {} })).status, 200);
  const before = app.snapshot();
  const r = await create(app); assert.equal(r.status, 400, r.text); assert.match(r.text, /beendet/);
  assert.deepEqual(app.snapshot(), before);
});
