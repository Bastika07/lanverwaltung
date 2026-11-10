'use strict';
// Issue #97: Der Discord-Login übernimmt die Discord-ID in die Teilnehmerdaten – aber nur über das eigene
// bezahlte Ticket, nie über einen Namen allein. Nur synthetische Daten und eine lokale Discord-Attrappe.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { isolated } = require('../test-support/isolated.cjs');

async function discordMock(t) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (b) => { body += b; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.method === 'POST' && url.pathname === '/api/oauth2/token') return json(200, { access_token: new URLSearchParams(body).get('code') });
      if (url.pathname === '/api/v10/users/@me') {
        const id = String(req.headers.authorization || '').replace(/^Bearer /, '');
        return json(200, { id, username: id, global_name: id, verified: false });
      }
      return json(404, { message: 'Not available in synthetic Discord' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function oauthLogin(app, code) {
  const start = await fetch(`${app.base}/api/auth/login`, { redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const callback = await fetch(`${app.base}/api/auth/callback?code=${code}&state=${state}`, { redirect: 'manual', headers: { Cookie: `lan_state=${state}` } });
  assert.ok(callback.headers.getSetCookie().some((c) => /^lan_user=[0-9a-f]{64}/.test(c)), `login ${code} creates a session`);
}

const stamp = new Date().toISOString();
const person = (id, extra = {}) => ({ id, name: id, discordId: null, discordName: '', steam: '', note: '', clan: '', ...extra });
const order = (id, accountId, tickets, status = 'paid') => ({ id, ref: id, accountId, status, createdAt: stamp, dueAt: stamp, total: 0,
  tickets: tickets.map(([holder, personId], i) => ({ id: `${id}-${i}`, code: `${id}-${i}-SYNTHETIC`.toUpperCase(), typeId: 'normal', holder, personId, price: 0 })) });

function prepare(data) {
  data.persons.push(
    person('p-anna', { ticketOwnerId: 'anna' }), // eigenes Ticket, Name passt -> verknüpfen
    person('p-friend', { name: 'Freund', ticketOwnerId: 'ben' }), // ben kauft nur für jemand anderen
    person('carl'), // gleichnamige Person ohne eigenes Ticket
    person('p-carl', { name: 'carl (2)', ticketOwnerId: 'ben' }), // Ticket heißt carl, gekauft von ben
    person('p-dora1', { ticketOwnerId: 'dora' }), person('p-dora2', { name: 'dora (2)', ticketOwnerId: 'dora' }), // mehrdeutig
    person('p-eve', { discordId: '999999999', discordName: 'Andere', ticketOwnerId: 'eve' }), // schon fremd verknüpft
    person('p-finn', { ticketOwnerId: 'finn' }), // nur offene Bestellung
  );
  const e = data.events.find((x) => x.id === 'first');
  e.ticketTypes[0].quota = 50;
  e.orders.push(
    order('o-anna', 'anna', [['anna', 'p-anna']]),
    order('o-ben', 'ben', [['Freund', 'p-friend'], ['carl', 'p-carl']]),
    order('o-dora', 'dora', [['dora', 'p-dora1'], ['Dora', 'p-dora2']]),
    order('o-eve', 'eve', [['eve', 'p-eve']]),
    order('o-finn', 'finn', [['finn', 'p-finn']], 'pending'),
  );
}

test('Discord-Login verknüpft nur die eindeutig eigene Ticketperson', async (t) => {
  const base = await discordMock(t);
  const app = await isolated(t, { prepare, env: { DISCORD_CLIENT_ID: 'synthetic-client', DISCORD_CLIENT_SECRET: 'synthetic-secret', DISCORD_OAUTH_BASE: base } });
  for (const id of ['anna', 'ben', 'carl', 'dora', 'eve', 'finn']) await oauthLogin(app, id);
  const persons = Object.fromEntries(app.snapshot().persons.map((p) => [p.id, p]));

  assert.equal(persons['p-anna'].discordId, 'anna', 'own paid ticket with matching name links');
  assert.equal(persons['p-anna'].discordName, 'anna');
  assert.equal(persons['p-friend'].discordId, null, 'ticket bought for someone else is not linked to the buyer');
  assert.equal(persons.carl.discordId, null, 'same name without own ticket never links');
  assert.equal(persons['p-carl'].discordId, null, 'ticket name bought by another account never links');
  assert.equal(persons['p-dora1'].discordId, null, 'ambiguous: nothing linked');
  assert.equal(persons['p-dora2'].discordId, null, 'ambiguous: nothing linked');
  assert.equal(persons['p-eve'].discordId, '999999999', 'existing link of another account stays untouched');
  assert.equal(persons['p-finn'].discordId, null, 'unpaid orders are no proof');
  assert.equal(app.snapshot().persons.filter((p) => p.discordId === 'anna').length, 1);

  const sec = app.logs().split('\n').filter((l) => l.includes('"sec"')).map((l) => JSON.parse(l));
  assert.equal(sec.filter((l) => l.sec === 'discord_linked').length, 1);
  assert.equal(sec.filter((l) => l.sec === 'discord_link_skipped' && l.reason === 'ambiguous').length, 1);
  for (const l of sec.filter((x) => /^discord_link/.test(x.sec))) {
    assert.doesNotMatch(JSON.stringify(l), /anna|dora|p-/, 'security log carries no Discord IDs or names');
  }

  // Erneuter Login: bleibt verknüpft, keine zweite Verknüpfung
  await oauthLogin(app, 'anna');
  assert.equal(app.snapshot().persons.filter((p) => p.discordId === 'anna').length, 1);
  assert.equal(app.logs().split('\n').filter((l) => l.includes('"discord_linked"')).length, 1);
});

// Meist meldet man sich zuerst an und bestellt danach: dann verknüpft die bezahlte Bestellung.
test('Bestellung nach dem Login verknüpft, sobald sie bezahlt ist', async (t) => {
  const base = await discordMock(t);
  const app = await isolated(t, { prepare: (data) => {
    const e = data.events.find((x) => x.id === 'first');
    e.ticketTypes[0].quota = 50;
    e.ticketTypes.push({ id: 'free', name: 'Gratis', active: true, price: 0, quota: 50, maxPerOrder: 5, participant: true });
  }, env: { DISCORD_CLIENT_ID: 'synthetic-client', DISCORD_CLIENT_SECRET: 'synthetic-secret', DISCORD_OAUTH_BASE: base } });
  const session = async (code) => {
    const start = await fetch(`${app.base}/api/auth/login`, { redirect: 'manual' });
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const callback = await fetch(`${app.base}/api/auth/callback?code=${code}&state=${state}`, { redirect: 'manual', headers: { Cookie: `lan_state=${state}` } });
    return callback.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('lan_user='));
  };
  const profile = { ...app.profile, consent: true };
  const linkedTo = (id) => app.snapshot().persons.filter((p) => p.discordId === id);

  const gina = await session('gina');
  assert.equal((await app.request('/api/account', { method: 'PUT', headers: { Cookie: gina }, body: profile })).status, 200);
  assert.equal(linkedTo('gina').length, 0, 'login without ticket links nothing');
  const free = await app.request('/api/tickets/orders', { method: 'POST', headers: { Cookie: gina }, body: { items: [{ typeId: 'free', holder: 'Gina' }] } });
  assert.equal(free.status, 201, JSON.stringify(free.data));
  assert.equal(linkedTo('gina').length, 1, 'free ticket ordered after login links immediately');

  const hans = await session('hans');
  assert.equal((await app.request('/api/account', { method: 'PUT', headers: { Cookie: hans }, body: profile })).status, 200);
  const paid = await app.request('/api/tickets/orders', { method: 'POST', headers: { Cookie: hans }, body: { items: [{ typeId: 'normal', holder: 'hans' }] } });
  assert.equal(paid.status, 201, JSON.stringify(paid.data));
  assert.equal(linkedTo('hans').length, 0, 'unpaid order links nothing');
  assert.equal((await app.request(`/api/tickets/orders/${paid.data.id}/paid`, { method: 'POST', admin: true, body: { paid: true } })).status, 200);
  assert.equal(linkedTo('hans').length, 1, 'payment confirmation links the buyer');

  const sec = app.logs().split('\n').filter((l) => l.includes('"discord_linked"')).map((l) => JSON.parse(l));
  assert.deepEqual(sec.map((l) => l.via), ['paid_ticket', 'paid_ticket']);
  assert.doesNotMatch(JSON.stringify(sec), /gina|hans/i);
});
