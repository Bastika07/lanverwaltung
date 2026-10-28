'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { isolated } = require('../test-support/isolated.cjs');

const pause = () => new Promise((r) => setTimeout(r, 40));
const manual = async (app, event = 'first') => {
  const r = await app.request('/api/tickets/admin/orders', { method: 'POST', admin: true, headers: { 'X-Event': event },
    body: { buyerProfile: app.profile, paid: true, privacyConfirmed: true, items: [{ typeId: 'normal', holder: 'Walk-in holder' }] } });
  assert.equal(r.status, 201, r.text);
  return r.data;
};

const endpoint = (person = 'buyer') => `/api/persons/${person}/ticket-accounts`;
const digest = (account) => crypto.createHash('sha256').update(JSON.stringify([account.profile || null, account.consentAt || null])).digest('hex');
const targets = (app, person = 'buyer', options = {}) => app.request(endpoint(person), { admin: true, ...options });
const edit = (app, target, body, person = 'buyer', options = {}) => app.request(`${endpoint(person)}/${target.kind}/${target.id}`, { method: 'PUT', admin: true, body, ...options });

test('person ticket accounts: exact persisted associations deduplicate own accounts across events', async (t) => {
  const app = await isolated(t);
  const r = await targets(app);
  assert.equal(r.status, 200, r.text);
  const account = app.snapshot().accounts.find((a) => a.id === 'buyer');
  assert.deepEqual(r.data, { person: { id: 'buyer', name: 'buyer' }, targets: [{ kind: 'account', id: 'buyer', relationship: 'own', name: 'buyer', profile: app.profile, consentAt: account.consentAt, version: digest(account) }] });
  assert.deepEqual((await targets(app, 'buyer', { headers: { 'X-Event': 'second' } })).data, r.data);
  assert.equal((await targets(app, 'missing')).status, 404);
});

test('person ticket accounts: admin corrects only the associated account profile with strict optimistic locking', async (t) => {
  const app = await isolated(t);
  await app.request('/api/tickets/settings', { method: 'PUT', admin: true, body: { minAge: 99 } });
  const target = (await targets(app)).data.targets[0];
  const before = app.snapshot();
  const profile = { ...app.profile, firstName: 'Corrected', city: 'New city' };
  const r = await edit(app, target, { profile: { ...profile, ignored: 'discard' }, version: target.version, consentAt: 'forged', id: 'other' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.data, { ...target, profile, version: digest({ ...before.accounts[0], profile }) });
  assert.deepEqual(app.snapshot(), { ...before, accounts: before.accounts.map((a) => a.id === 'buyer' ? { ...a, profile } : a) });
  assert.deepEqual((await targets(app)).data.targets[0], r.data);
  const saved = app.snapshot();
  assert.equal((await edit(app, target, { profile: app.profile, version: target.version })).status, 409);
  for (const version of [undefined, 1, null, 'bad']) assert.equal((await edit(app, target, { profile, version })).status, 409);
  for (const profile of [null, [], {}, { ...app.profile, birthdate: '1990-02-31' }, { ...app.profile, email: 'bad' }, { ...app.profile, firstName: ['bad'] }]) {
    assert.equal((await edit(app, r.data, { profile, version: r.data.version })).status, 400);
  }
  assert.equal((await edit(app, { ...target, id: 'other' }, { profile, version: r.data.version })).status, 404);
  assert.deepEqual(app.snapshot(), saved);
});

test('person ticket accounts: manual order correction crosses events and shares the existing buyer version', async (t) => {
  const app = await isolated(t);
  const o = await manual(app, 'second');
  const pid = o.tickets[0].personId;
  const target = { kind: 'order', id: o.id, relationship: 'box_office', name: o.buyerName, profile: app.profile, version: 1, eventId: 'second', eventName: 'second', ref: o.ref };
  const r = await targets(app, pid);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.data.targets, [target]);
  const checkin = await app.request('/api/tickets/checkin/' + o.tickets[0].code, { method: 'POST', admin: true, body: {} });
  assert.equal(checkin.status, 200, checkin.text);
  await app.request('/api/tickets/settings', { method: 'PUT', admin: true, body: { minAge: 99 } });
  const before = app.snapshot();
  const profile = { ...app.profile, firstName: 'Corrected manual' };
  const updated = await edit(app, target, { profile, version: 1 }, pid);
  assert.equal(updated.status, 200, updated.text);
  assert.deepEqual(updated.data, { ...target, name: 'Corrected manual Test', profile, version: 2 });
  const expected = structuredClone(before);
  Object.assign(expected.events[1].orders.find((x) => x.id === o.id), { buyerProfile: profile, buyerName: 'Corrected manual Test', version: 2 });
  assert.deepEqual(app.snapshot(), expected);
  assert.equal((await edit(app, target, { profile, version: 1 }, pid)).status, 409);
  const path = '/api/tickets/orders/' + o.id + '/buyer';
  assert.equal((await app.request(path, { method: 'PUT', admin: true, headers: { 'X-Event': 'second' }, body: { buyerProfile: app.profile, version: 1 } })).status, 409);
  const legacy = await app.request(path, { method: 'PUT', admin: true, headers: { 'X-Event': 'second' }, body: { buyerProfile: app.profile, version: 2 } });
  assert.equal(legacy.status, 200, legacy.text);
  assert.equal((await edit(app, updated.data, { profile, version: 2 }, pid)).status, 409);
  const latest = (await targets(app, pid)).data.targets[0];
  assert.equal(latest.version, 3);
  const valid = app.snapshot();
  assert.equal((await edit(app, latest, { profile, version: '3' }, pid)).status, 409);
  assert.equal((await edit(app, latest, { profile: null, version: 3 }, pid)).status, 400);
  assert.deepEqual(app.snapshot(), valid);
  await app.request('/api/tickets/settings', { method: 'PUT', admin: true, headers: { 'X-Event': 'second' }, body: { minAge: 99 } });
  const saved = app.snapshot();
  assert.equal((await edit(app, latest, { profile, version: 3 }, pid)).status, 400);
  assert.deepEqual(app.snapshot(), saved);
});

test('person ticket accounts: unauthorized reads/writes, CSRF and revoked admin uploads are rejected', async (t) => {
  const app = await isolated(t);
  const target = (await targets(app)).data.targets[0];
  const before = app.snapshot();
  for (const options of [{ admin: false }, { admin: false, user: 'buyer' }, { admin: false, user: 'other' }]) {
    const r = await targets(app, 'buyer', options);
    assert.ok([401, 403].includes(r.status), r.text);
    assert.ok(!r.text.includes(app.profile.email));
    const w = await edit(app, target, { profile: app.profile, version: target.version }, 'buyer', options);
    assert.ok([401, 403].includes(w.status), w.text);
  }
  assert.equal((await edit(app, target, { profile: app.profile, version: target.version }, 'buyer', { headers: { Origin: 'https://evil.invalid' } })).status, 403);
  assert.deepEqual(app.snapshot(), before);
  const upload = app.staged(`${endpoint()}/account/buyer`, { method: 'PUT', admin: true, body: { profile: { ...app.profile, city: 'Forbidden' }, version: target.version } });
  await pause(); await app.request('/api/logout', { method: 'POST', admin: true }); upload.finish();
  assert.equal((await upload.done).status, 401);
  assert.deepEqual(app.snapshot().accounts, before.accounts);
});

test('person ticket accounts: self-service edits stale the digest and deletion removes targets', async (t) => {
  const app = await isolated(t);
  const target = (await targets(app)).data.targets[0];
  const self = await app.request('/api/account', { method: 'PUT', user: 'buyer', body: { ...app.profile, city: 'Self edited', consent: true } });
  assert.equal(self.status, 200, self.text);
  const before = app.snapshot();
  assert.equal((await edit(app, target, { profile: app.profile, version: target.version })).status, 409);
  assert.deepEqual(app.snapshot(), before);
  const upload = app.staged(`${endpoint()}/account/buyer`, { method: 'PUT', admin: true, body: { profile: app.profile, version: (await targets(app)).data.targets[0].version } });
  await pause();
  assert.equal((await app.request('/api/account', { method: 'DELETE', user: 'buyer' })).status, 200);
  const deleted = app.snapshot();
  upload.finish(); assert.equal((await upload.done).status, 404);
  assert.deepEqual((await targets(app)).data.targets, []);
  assert.equal((await edit(app, target, { profile: app.profile, version: target.version })).status, 404);
  assert.deepEqual(app.snapshot(), deleted);
});

test('person ticket accounts: delayed correction resolves deleted persons and severed ticket links afresh', async (t) => {
  const app = await isolated(t);
  const target = (await targets(app)).data.targets[0];
  const upload = app.staged(`${endpoint()}/account/buyer`, { method: 'PUT', admin: true, body: { profile: app.profile, version: target.version } });
  await pause();
  assert.equal((await app.request('/api/persons/buyer', { method: 'DELETE', admin: true })).status, 200);
  const before = app.snapshot();
  upload.finish(); assert.equal((await upload.done).status, 404);
  assert.deepEqual(app.snapshot(), before);
  const o = await manual(app);
  const pid = o.tickets[0].personId;
  const pending = app.staged(`${endpoint(pid)}/order/${o.id}`, { method: 'PUT', admin: true, body: { profile: app.profile, version: 1 } });
  await pause();
  assert.equal((await app.request('/api/persons/' + pid, { method: 'DELETE', admin: true })).status, 200);
  assert.equal((await app.request('/api/tickets/orders/' + o.id + '/holders', { method: 'PUT', admin: true, body: { holders: {} } })).status, 200);
  const relinked = app.snapshot();
  pending.finish(); assert.equal((await pending.done).status, 404);
  assert.deepEqual(app.snapshot(), relinked);
});

test('person ticket accounts: no name autoassociation and public views never expose corrected private data', async (t) => {
  const app = await isolated(t);
  const created = await app.request('/api/people', { method: 'POST', admin: true, body: { name: 'Synthetic Test' } });
  assert.equal(created.status, 201, created.text);
  assert.deepEqual((await targets(app, created.data.id)).data.targets, []);
  const target = (await targets(app)).data.targets[0];
  assert.equal((await edit(app, target, { profile: { ...app.profile, email: 'private-correction@example.invalid' }, version: target.version })).status, 200);
  const o = await manual(app);
  const pid = o.tickets[0].personId;
  const orderTarget = (await targets(app, pid)).data.targets[0];
  assert.equal((await edit(app, orderTarget, { profile: { ...app.profile, street: 'PRIVATE MANUAL ADDRESS' }, version: 1 }, pid)).status, 200);
  for (const url of ['/api/people', '/api/tickets', '/api/me', '/api/tickets/mine']) {
    const r = await app.request(url, { user: 'other' });
    assert.equal(r.status, 200, r.text);
    assert.ok(!r.text.includes('private-correction@example.invalid'));
    assert.ok(!r.text.includes('PRIVATE MANUAL ADDRESS'));
    assert.ok(!r.text.includes('ticket-accounts'));
  }
  assert.ok(!app.logs().includes('private-correction@example.invalid'));
  assert.ok(!app.logs().includes('PRIVATE MANUAL ADDRESS'));
});

// The HTTP fixture has non-numeric account IDs that the admin Discord-link editor
// cannot assign. Exercise this pre-existing data shape directly through real routes.
test('person ticket accounts: own and third-party buyer stay explicit; stale owner keys grant no association', async () => {
  const db = { persons: [{ id: 'person', name: 'Same name', discordId: 'own', ticketOwnerId: 'unrelated' },
    { id: 'unlinked', name: 'Buyer', ticketOwnerId: 'buyer' }, { id: 'missing-account', name: 'Missing', discordId: 'gone' }],
  accounts: [{ id: 'own', discordName: 'Same name' }, { id: 'buyer', discordName: 'Buyer' }, { id: 'unrelated', discordName: 'Same name' }] };
  const events = [{ id: 'first', orders: [{ accountId: 'buyer', tickets: [{ personId: 'person' }, { personId: 'person' }] }] },
    { id: 'second', orders: [{ accountId: 'buyer', tickets: [{ personId: 'person' }] }, { accountId: 'own', tickets: [{ personId: 'person' }] }] }];
  let result;
  const people = require('../lib/people')({ db, event: { all: () => events }, accounts: { find: (id) => db.accounts.find((a) => a.id === id) },
    requireAdmin: () => {}, send: (_res, status, data) => { assert.equal(status, 200); result = data; } });
  await people.routes({}, {}, ['persons', 'person', 'ticket-accounts'], 'GET');
  assert.deepEqual(result.targets, [{ kind: 'account', id: 'own', relationship: 'own', name: 'Same name', profile: null, consentAt: null, version: digest(db.accounts[0]) },
    { kind: 'account', id: 'buyer', relationship: 'buyer', name: 'Buyer', profile: null, consentAt: null, version: digest(db.accounts[1]) }]);
  for (const id of ['unlinked', 'missing-account']) {
    await people.routes({}, {}, ['persons', id, 'ticket-accounts'], 'GET');
    assert.deepEqual(result.targets, []);
  }
});
