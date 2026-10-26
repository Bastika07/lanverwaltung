'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isolated } = require('../test-support/isolated.cjs');
const pause = () => new Promise((r) => setTimeout(r, 100));

test('assessment: role/ownership/event isolation and CSRF matrix', { timeout: 30000 }, async (t) => {
  const app = await isolated(t), req = app.request;
  let checks = 0;
  for (const user of [undefined, 'buyer', 'outsider']) {
    for (const url of ['/api/settings', '/api/accounts', '/api/tickets/admin', '/api/tickets/export.csv', '/api/servers/admin', '/api/website/admin']) {
      assert.equal((await req(url, { user })).status, 401, `${user}: ${url}`); checks++;
    }
    for (const url of ['/api/tickets/orders/first-other/holders', '/api/tickets/orders/second-other/holders']) {
      assert.equal((await req(url, { method: 'PUT', user, body: { holders: {} } })).status, user ? 403 : 401); checks++;
    }
    assert.equal((await req('/api/seats/reserve', { method: 'POST', user, body: { ticketId: 'first-ticket-other', seatId: '1111111111' } })).status, user ? 403 : 401); checks++;
  }
  for (const headers of [{ Origin: 'https://foreign.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'null' }]) {
    assert.equal((await req('/api/settings', { method: 'PUT', admin: true, body: {}, headers })).status, 403); checks++;
  }
  const mine = await req('/api/tickets/mine', { user: 'buyer' });
  assert.ok(!mine.text.includes('OTHER-SYNTHETIC')); checks++;
  assert.equal((await req('/api/info', { user: 'outsider' })).status, 403); checks++;
  t.diagnostic(`role/ownership/CSRF checks: ${checks}`);
});

test('assessment: bounded deterministic JSON/cookie/path mutation fuzzing', { timeout: 45000 }, async (t) => {
  const app = await isolated(t), req = app.request;
  const atoms = [null, false, 0, -1, 1.5, 1e100, '', 'x', '\u0000', '<img src=x onerror=alert(1)>', "' OR 1=1--", '../db.sqlite', [], {}, { toString: null }, { toString: {} }, { valueOf: null }, ['x'], { constructor: { prototype: { polluted: true } } }];
  let checks = 0;
  for (const value of atoms) {
    for (const [url, options] of [
      ['/api/account', { method: 'PUT', user: 'outsider', body: { ...app.profile, firstName: value, consent: true } }],
      ['/api/tickets/orders/first-buyer/holders', { method: 'PUT', user: 'buyer', body: { holders: { 'first-ticket-buyer': value } } }],
      ['/api/servers', { method: 'POST', user: 'buyer', body: { name: value, description: 'Synthetic' } }],
      ['/api/tournaments/match/matches/r0m0', { method: 'POST', user: 'outsider', body: { a: value, b: 0 } }],
      ['/api/seats/reserve', { method: 'POST', user: 'buyer', body: { ticketId: value, seatId: value } }],
    ]) {
      const r = await req(url, options);
      assert.ok(r.status < 500, `${url}: ${JSON.stringify(value)} -> ${r.status}`);
      assert.notEqual(r.status, 429, 'rate limit must not mask fuzz coverage');
      assert.ok(!/TypeError|at .*\.js:\d|SQLITE_CONSTRAINT/.test(r.text)); checks++;
    }
  }
  for (const raw of ['{', '{}{}', 'null', '[]', 'true', '1', '"text"', '{"__proto__":{"polluted":true}}', '{"a":1e9999}', '{"a":' + '['.repeat(100) + '0' + ']'.repeat(100) + '}']) {
    const r = await req('/api/tickets/orders/first-buyer/holders', { method: 'PUT', user: 'buyer', raw });
    assert.ok(r.status === 200 || r.status === 400); checks++;
  }
  for (const cookie of ['session=%', 'lan_user=%ZZ', 'session=%E0%A4%A', '__proto__=x', 'lan_user=constructor', 'session=toString']) {
    const r = await req('/api/me', { headers: { Cookie: cookie } }); assert.ok(r.status < 500); assert.notEqual(r.data.admin, true); checks++;
  }
  for (const url of ['/..%2fserver.js', '/%2e%2e%2f.env', '/%00', '/%ZZ', '/api/tournaments/__proto__', '/api/tournaments/constructor']) {
    const r = await req(url); assert.ok(r.status < 500, `${url}: ${r.status}`); assert.ok(!r.text.includes("require('./lib/storage.js')")); checks++;
  }
  assert.equal({}.polluted, undefined);
  assert.equal((await req('/api/health')).status, 200);
  t.diagnostic(`deterministic mutation requests: ${checks}; no crash/server error/stack disclosure`);
});

test('assessment: concurrent reservations cannot oversell quota or occupy a seat twice', { timeout: 20000 }, async (t) => {
  const app = await isolated(t), req = app.request;
  const orders = await Promise.all(['buyer', 'other'].map((user) => req('/api/tickets/orders', { method: 'POST', user, body: { items: [{ typeId: 'normal', holder: user }] } })));
  assert.deepEqual(orders.map((r) => r.status).sort(), [201, 400]); // second sees exhausted onSale
  const seats = await Promise.all(['buyer', 'other'].map((user) => req('/api/seats/reserve', { method: 'POST', user, body: { ticketId: `first-ticket-${user}`, seatId: '1111111111' } })));
  assert.deepEqual(seats.map((r) => r.status).sort(), [200, 409]);
  assert.equal(app.snapshot().events[0].attendees.filter((p) => p.seat === '1111111111').length, 1);
});

test('assessment: logout revokes an in-flight admin mutation', { timeout: 20000 }, async (t) => {
  const app = await isolated(t);
  const pending = app.staged('/api/settings', { method: 'PUT', admin: true, body: { eventName: 'REVOKED MUTATION' } });
  await pause();
  await app.request('/api/logout', { method: 'POST', admin: true });
  pending.finish();
  assert.equal((await pending.done).status, 401);
  assert.notEqual(app.snapshot().meta.settings.eventName, 'REVOKED MUTATION');
});

test('assessment: cancellation during check-in upload prevents stale check-in', { timeout: 20000 }, async (t) => {
  const app = await isolated(t);
  const pending = app.staged('/api/tickets/checkin/FIRST-BUYER-SYNTHETIC', { admin: true, body: {} });
  await pause();
  await app.request('/api/tickets/orders/first-buyer/cancel', { method: 'POST', admin: true });
  pending.finish();
  assert.equal((await pending.done).status, 400);
  assert.ok(!app.snapshot().events[0].orders[0].tickets[0].checkedInAt);
});

test('assessment: closing seating during upload prevents stale reservation', { timeout: 20000 }, async (t) => {
  const app = await isolated(t);
  const pending = app.staged('/api/seats/reserve', { user: 'buyer', body: { ticketId: 'first-ticket-buyer', seatId: '1111111111' } });
  await pause();
  await app.request('/api/tickets/settings', { method: 'PUT', admin: true, body: { seatSelection: false } });
  pending.finish();
  assert.equal((await pending.done).status, 400);
  assert.ok(!app.snapshot().events[0].attendees[0].seat);
});

test('assessment: current guest-server settings apply after a staged upload', { timeout: 20000 }, async (t) => {
  const app = await isolated(t);
  const pending = app.staged('/api/servers', { user: 'buyer', body: { name: 'closed', description: 'Synthetic' } });
  await pause();
  const r = await app.request('/api/servers/config', { method: 'PUT', admin: true, body: { domain: 'guest.invalid', ipFrom: '10.10.50.10', ipTo: '10.10.50.12', open: false, maxPerAccount: 2 } });
  assert.equal(r.status, 200);
  pending.finish();
  assert.equal((await pending.done).status, 400);
  assert.equal(app.snapshot().events[0].guestServers.length, 0);
});

test('assessment: ticket age requirements are refreshed after a staged upload', { timeout: 20000 }, async (t) => {
  const app = await isolated(t);
  const pending = app.staged('/api/tickets/orders', { user: 'buyer', body: { items: [{ typeId: 'normal', holder: 'Too young' }] } });
  await pause();
  assert.equal((await app.request('/api/tickets/settings', { method: 'PUT', admin: true, body: { minAge: 99 } })).status, 200);
  pending.finish();
  assert.equal((await pending.done).status, 400);
  assert.equal(app.snapshot().events[0].orders.length, 2);
});

test('assessment: authenticated score type mutations cannot store malformed scores', { timeout: 20000 }, async (t) => {
  const app = await isolated(t);
  for (const a of [null, false, [], {}, { toString: null }, { toString: {} }, [1], -1, 1.5, 1e100]) {
    const r = await app.request('/api/tournaments/match/matches/r0m0', { method: 'POST', user: 'buyer', body: { a, b: -1 } });
    assert.equal(r.status, 400, JSON.stringify(a));
  }
  assert.deepEqual(app.snapshot().events[0].tournaments[0].results, {});
});
