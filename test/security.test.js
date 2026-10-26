'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const Access = require('../lib/access');
const { readSnapshot } = require('../lib/storage');
const root = path.resolve(__dirname, '..');
const stamp = new Date().toISOString();
const mods = Object.fromEntries(['details', 'tournaments', 'announcements', 'schedule', 'info', 'people', 'seating', 'beamer', 'tickets', 'servers'].map((k) => [k, true]));
function fixture() {
  const order = (id, accountId, personId, holder) => ({ id, accountId, ref: `LAN-${id}`, status: 'paid', createdAt: stamp, dueAt: stamp, tickets: [{ id: `t-${id}`, personId, holder, code: `${id}SECRET`, price: 1000, typeId: 'normal' }], total: 1000 });
  return { meta: { securityVersion: 1, settings: { modules: mods } }, persons: [
    { id: 'pa', name: 'Alice', discordId: 'buyer', ticketOwnerId: 'buyer', note: 'PRIVATE', clan: '' },
    { id: 'pb', name: 'Bob', discordId: 'victim', ticketOwnerId: 'victim', note: 'PRIVATE', clan: '' },
  ], events: [{ id: 'reviewevent', name: 'Test', start: null, end: null, active: false, modules: mods,
    sale: { saleOpen: true, payDays: 14, minAge: 0, seatSelection: true }, access: { info: 'tickets', seating: 'tickets' },
    info: { wifi: { ssid: 'Test', password: 'secret' }, servers: [], games: [] }, attendees: [{ personId: 'pa', seat: '1111111111' }, { personId: 'pb', seat: '2222222222' }],
    ticketTypes: [{ id: 'normal', name: 'Normal', active: true, price: 1000, quota: 100, maxPerOrder: 5, participant: true, seatCategories: [] }],
    orders: [order('buyerorder', 'buyer', 'pa', 'Alice'), order('victimorder', 'victim', 'pb', 'Bob')],
    tournaments: [{ id: 'race', name: 'Race', type: 'ko', status: 'running', participants: ['Alice', 'Bob'], order: [0, 1], results: {}, members: {}, discordEnabled: false, discord: { secret: true } }],
    serverConfig: { domain: 'guest.test', ipFrom: '10.10.50.10', ipTo: '10.10.50.12', open: true, maxPerAccount: 2 }, guestServers: [],
  }], seating: { cols: 12, rows: 8, categories: [], areas: [], seats: [1, 2, 3].map((n) => ({ id: String(n).repeat(10), x: n - 1, y: 0, label: String(n), locked: false, category: null })) },
  accounts: ['buyer', 'victim', 'outsider'].map((id) => ({ id, discordName: id, username: id, consentAt: stamp, profile: { firstName: id, lastName: 'Test', street: 'Test 1', zip: '12345', city: 'Test', email: 'test@example.invalid', birthdate: '1990-01-01' } })) };
}
function context(db) {
  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const ctx = { db, save() {}, broadcast() {}, HttpError, str: (v, n = 100) => String(v || '').trim().slice(0, n), settings: () => ({ modules: mods }), Discord: { enabled: false, md: String }, moduleOn: (k) => mods[k] };
  ctx.event = require('../lib/event')(ctx);
  ctx.people = require('../lib/people')(ctx);
  return ctx;
}
test('membership requires a live payment or explicit approval; teams require actual membership', () => {
  const db = fixture(), e = db.events[0];
  assert.equal(Access.isMember(db, 'buyer', e), true);
  e.orders[0].status = 'cancelled';
  assert.equal(Access.isMember(db, 'buyer', e), false);
  e.attendees[0].approved = true;
  assert.equal(Access.isMember(db, 'buyer', e), true);
  const t = { participants: ['Team A', 'Team B'], teamSize: 2, members: { 'Team A': ['pa'], 'Team B': ['pb'] } };
  assert.equal(Access.mayReport(db, 'buyer', t, { a: 0, b: 1 }), true);
  assert.equal(Access.mayReport(db, 'outsider', t, { a: 0, b: 1 }), false);
});
test('individual match identity cannot be acquired by choosing or renaming a display name', () => {
  const db = fixture(), t = db.events[0].tournaments[0];
  Access.bindPlayers(db, t);
  db.persons[0].name = 'Renamed';
  db.persons.push({ id: 'fake', name: 'Alice', discordId: 'outsider' });
  assert.equal(Access.mayReport(db, 'outsider', t, { a: 0, b: 1 }), false);
  assert.equal(Access.mayReport(db, 'buyer', t, { a: 0, b: 1 }), true);
  const unbound = { participants: ['Unknown'], members: {} };
  Access.bindPlayers(db, unbound);
  db.persons.push({ id: 'later', name: 'Unknown', discordId: 'attacker' });
  Access.bindPlayers(db, unbound);
  assert.equal(Access.mayReport(db, 'attacker', unbound, { a: 0, b: null }), false);
});
test('self-link cannot claim another person or grant approval; proof links paid tickets', () => {
  const db = fixture(), ctx = context(db), e = db.events[0];
  assert.throws(() => ctx.people.selfLink({ id: 'outsider', name: 'X' }, 'Bob'), { status: 403 });
  const p = ctx.people.selfLink({ id: 'outsider', name: 'X' }, 'New person');
  assert.equal(p.approved, false);
  assert.equal(Access.isMember(db, 'outsider', e), false);
  db.persons[0].discordId = null;
  ctx.people.selfLink({ id: 'buyer', name: 'Buyer' }, 'Alice');
  assert.equal(db.persons[0].discordId, 'buyer');
  db.persons[1].discordId = null;
  e.orders[1].tickets[0].code = 'ABC123';
  ctx.people.selfLink({ id: 'guest', name: 'Guest' }, 'Bob', 'abc123');
  assert.equal(db.persons[1].discordId, 'guest');
});
test('migration rotates secrets once, resets legacy claims and separates ambiguous ownership', () => {
  const db = fixture(); delete db.meta.securityVersion;
  db.events[0].orders[0].tickets[0].personId = 'pb';
  db.persons[1].note = 'Ticket victimorderSECRET';
  db.events[0].attendees[1].approved = true;
  const ctx = context(db), migrate = require('../lib/security-migration');
  migrate(ctx);
  assert.equal(db.meta.securityVersion, 1);
  assert.ok(db.persons.every((p) => !p.discordId));
  assert.ok(db.events[0].attendees.every((a) => a.approved !== true));
  const [a, b] = db.events[0].orders.map((o) => o.tickets[0]);
  assert.notEqual(a.personId, b.personId);
  assert.equal(b.personId, 'pb');
  assert.match(b.code, /^[A-F0-9]{32}$/);
  assert.equal(db.persons[1].note, '');
  assert.equal(db.events[0].attendees.find((a) => a.personId === 'pb').seat, '2222222222');
  const snapshot = JSON.stringify(db); migrate(ctx); assert.equal(JSON.stringify(db), snapshot);
});
test('HTTP security regressions', { timeout: 30000 }, async (t) => {
  const temp = fs.mkdtempSync(path.join(process.env.OPENCODE_TEST_TMP || os.tmpdir(), 'seniorenlan-test-'));
  const db = fixture(), tokens = Object.fromEntries(db.accounts.map((a) => [a.id, crypto.randomBytes(32).toString('hex')]));
  const expired = structuredClone(db.events[0].orders[0]);
  Object.assign(expired, { id: 'expired', accountId: 'outsider', status: 'pending', dueAt: '2000-01-01T00:00:00Z' });
  expired.tickets[0].id = 't-expired'; expired.tickets[0].code = 'expiredSECRET'; delete expired.tickets[0].personId;
  db.events[0].orders.push(expired);
  db.userSessions = Object.fromEntries(Object.entries(tokens).map(([uid, token]) => [crypto.createHash('sha256').update(token).digest('hex'), { uid, exp: Date.now() + 3600000 }]));
  fs.writeFileSync(path.join(temp, 'db.json'), JSON.stringify(db));
  const probe = net.createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise((r) => probe.close(r));
  const password = crypto.randomBytes(32).toString('hex');
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: temp, ADMIN_PASSWORD: password, ADMIN_PASSWORD_FILE: '', DISCORD_BOT_TOKEN: '', DISCORD_BOT_TOKEN_FILE: '', DISCORD_GUILD_ID: '', DISCORD_CLIENT_SECRET: '', DISCORD_CLIENT_SECRET_FILE: '', PUBLIC_URL: '', TRUST_PROXY: '0', TRUSTED_PROXIES: '', PROXY_ONLY: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', adminCookie;
  child.stdout.on('data', (b) => { logs += b; }); child.stderr.on('data', (b) => { logs += b; });
  const base = `http://127.0.0.1:${port}`;
  async function req(url, { method = 'GET', body, user, admin, headers = {} } = {}) {
    const r = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(user ? { Cookie: `lan_user=${tokens[user]}` } : {}), ...(admin ? { Cookie: adminCookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; } return { status: r.status, data, headers: r.headers };
  }
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on('data', () => { if (logs.includes('LAN-System läuft')) resolve(); });
      child.once('exit', () => reject(new Error(logs)));
    });
    const login = await req('/api/login', { method: 'POST', body: { password } }); assert.equal(login.status, 200); adminCookie = login.headers.get('set-cookie').split(';')[0];
    await t.test('admin protection and cross-origin protection remain active', async () => {
      assert.equal((await req('/api/settings')).status, 401);
      assert.equal((await req('/api/settings', { admin: true })).status, 200);
      assert.equal((await req('/api/settings', { method: 'PUT', admin: true, body: {}, headers: { Origin: 'https://foreign.invalid' } })).status, 403);
    });
    await t.test('public people excludes secrets and hidden seating', async () => {
      const r = await req('/api/people'); assert.equal(r.status, 200);
      assert.ok(r.data.people.every((p) => !Object.hasOwn(p, 'note') && !Object.hasOwn(p, 'discordId') && !p.seat));
      assert.deepEqual(r.data.seating.seats, []);
      assert.equal((await req('/api/seats/mine', { user: 'outsider' })).status, 403);
      assert.equal((await req('/api/seats/mine', { user: 'buyer' })).status, 200);
    });
    await t.test('website administration requires admin and same-origin while published texts stay public', async () => {
      assert.equal((await req('/api/website/admin')).status, 401);
      const draft = await req('/api/website/admin', { admin: true }); assert.equal(draft.status, 200);
      const body = draft.data;
      body.pages.impressum = { text: 'Test organisation', enabled: true };
      body.pages.datenschutz.text = 'SECRET LEGAL DRAFT';
      assert.equal((await req('/api/website/admin', { method: 'PUT', user: 'buyer', body })).status, 401);
      assert.equal((await req('/api/website/admin', { method: 'PUT', admin: true, body, headers: { Origin: 'https://foreign.invalid' } })).status, 403);
      assert.equal((await req('/api/website/admin', { method: 'PUT', admin: true, body })).status, 200);
      const published = await req('/api/website'); assert.equal(published.status, 200);
      assert.equal(published.data.pages.impressum.text, 'Test organisation');
      assert.ok(!JSON.stringify(published.data).includes('SECRET LEGAL DRAFT'));
      assert.equal((await req('/api/website/admin', { method: 'PUT', admin: true, body })).status, 409);
      const stored = readSnapshot(path.join(temp, 'db.sqlite'));
      assert.equal(stored.meta.website.pages.datenschutz.text, 'SECRET LEGAL DRAFT');
    });
    await t.test('forwarded headers are ignored without explicit trust', async () => {
      const r = await req('/api/accounts', { admin: true, headers: { 'X-Forwarded-Host': 'attacker.invalid', 'X-Forwarded-Proto': 'https' } });
      assert.equal(r.data.redirectUri, `${base}/api/auth/callback`);
    });
    await t.test('anonymous and unrelated accounts cannot report results', async () => {
      for (const user of [undefined, 'outsider']) {
        const r = await req('/api/tournaments/race/matches/r0m0', { method: 'POST', user, body: { a: 1, b: 0 } });
        assert.equal(r.status, user ? 403 : 401);
      }
      const r = await req('/api/tournaments/race', { user: 'buyer' });
      assert.deepEqual(r.data.reportableMatches, ['r0m0']); assert.equal(r.data.discord, undefined);
    });
    await t.test('staged concurrent results cannot overwrite a completed match', async () => {
      function staged(score) {
        let finish;
        const done = new Promise((resolve, reject) => {
          const r = http.request(base + '/api/tournaments/race/matches/r0m0', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `lan_user=${tokens.buyer}` } }, (res) => { let text = ''; res.on('data', (b) => { text += b; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) })); });
          r.on('error', reject); r.write('{'); finish = () => r.end(JSON.stringify(score).slice(1));
        }); return { done, finish: () => finish() };
      }
      const a = staged({ a: 2, b: 0 }), b = staged({ a: 0, b: 3 });
      a.finish(); const first = await a.done; b.finish(); const second = await b.done;
      assert.equal(first.status, 200); assert.equal(first.data.discord, undefined); assert.equal(second.status, 409);
    });
    await t.test('ticket display names never reassign another person', async () => {
      const r = await req('/api/tickets/orders/buyerorder/holders', { method: 'PUT', user: 'buyer', body: { holders: { 't-buyerorder': 'Bob' }, clans: { 't-buyerorder': 'Own clan' } } });
      assert.equal(r.status, 200); assert.equal(r.data.tickets[0].personId, 'pa');
      const mine = await req('/api/seats/mine', { user: 'victim' });
      assert.equal(mine.data.tickets[0].personId, 'pb'); assert.equal(mine.data.tickets[0].seat, '2222222222');
    });
    await t.test('cancellation revokes ticket-only membership', async () => {
      assert.equal((await req('/api/me', { user: 'buyer' })).data.member, true);
      assert.equal((await req('/api/tickets/orders/buyerorder/cancel', { method: 'POST', admin: true, body: {} })).status, 200);
      assert.equal((await req('/api/me', { user: 'buyer' })).data.member, false);
      assert.equal((await req('/api/info', { user: 'buyer' })).status, 403);
    });
    await t.test('malformed cookies and non-object JSON are client errors', async () => {
      assert.equal((await req('/api/me', { headers: { Cookie: 'session=%ZZ' } })).status, 400);
      for (const body of [null, [], 1]) assert.equal((await req('/api/account', { method: 'PUT', user: 'outsider', body })).status, 400);
      assert.equal((await req('/api/tickets/orders', { method: 'POST', user: 'outsider', body: { items: [null] } })).status, 400);
    });
    await t.test('cross-owner merges are rejected', async () => {
      assert.equal((await req('/api/persons/pa/merge', { method: 'POST', admin: true, body: { into: 'pb' } })).status, 409);
    });
    await t.test('expired reservations release quota and open orders are capped', async () => {
      const before = await req('/api/tickets'); assert.equal(before.data.types[0].available, 99);
      const orders = [];
      for (let i = 0; i < 3; i++) {
        const r = await req('/api/tickets/orders', { method: 'POST', user: 'outsider', body: { items: [{ typeId: 'normal', holder: `Guest ${i}` }] } });
        assert.equal(r.status, 201); assert.match(r.data.tickets[0].code, /^[A-F0-9]{32}$/); orders.push(r.data);
      }
      assert.equal((await req('/api/tickets/orders', { method: 'POST', user: 'outsider', body: { items: [{ typeId: 'normal', holder: 'Fourth' }] } })).status, 429);
      assert.equal((await req('/api/tickets/types/normal', { method: 'PUT', admin: true, body: { quota: 4 } })).status, 200);
      assert.equal((await req('/api/tickets/orders/expired/paid', { method: 'POST', admin: true, body: { paid: true } })).status, 409);
    });
    await t.test('account deletion revokes sessions and retains only pseudonymized ownership', async () => {
      assert.equal((await req('/api/tickets/types/normal', { method: 'PUT', admin: true, body: { quota: 100 } })).status, 200);
      function staged(url, method, body) {
        let finish;
        const started = new Promise((resolve, reject) => {
          const r = http.request(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: `lan_user=${tokens.victim}` } }, (res) => {
            let text = ''; res.on('data', (b) => { text += b; }); res.on('end', () => resolve({ status: res.statusCode, text }));
          });
          r.on('error', reject); r.write('{'); finish = () => r.end(JSON.stringify(body).slice(1));
        });
        return { done: started, finish: () => finish() };
      }
      const pending = [
        staged('/api/tickets/orders', 'POST', { items: [{ typeId: 'normal', holder: 'Stale holder' }] }),
        staged('/api/tickets/orders/victimorder/holders', 'PUT', { holders: { 't-victimorder': 'Stale name' }, clans: { 't-victimorder': 'Stale clan' } }),
        staged('/api/servers', 'POST', { name: 'stale-server', description: 'Stale description' }),
        staged('/api/seats/reserve', 'POST', { ticketId: 't-victimorder', seatId: '3333333333' }),
        staged('/api/account', 'PUT', { ...db.accounts.find((a) => a.id === 'victim').profile, consent: true }),
      ];
      // Let the server enter readBody while the requests deliberately remain incomplete.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const r = await req('/api/account', { method: 'DELETE', user: 'victim' }); assert.equal(r.status, 200);
      for (const request of pending) request.finish();
      for (const result of await Promise.all(pending.map((request) => request.done))) assert.equal(result.status, 401, result.text);
      assert.equal((await req('/api/account', { user: 'victim' })).data.account, null);
      assert.equal((await req('/api/tickets/mine', { user: 'victim' })).status, 401);
      const stored = readSnapshot(path.join(temp, 'db.sqlite'));
      assert.ok(!stored.accounts.some((a) => a.id === 'victim'));
      assert.ok(Object.values(stored.userSessions).every((s) => s.uid !== 'victim'));
      const order = stored.events[0].orders.find((o) => o.id === 'victimorder');
      assert.equal(order.status, 'paid'); assert.equal(order.accountId, null); assert.equal(order.buyerName, '(gelöscht)');
      assert.match(order.tickets[0].holder, /^Gelöscht-/); assert.equal(order.tickets[0].code, 'victimorderSECRET');
      assert.equal(stored.persons.find((p) => p.id === 'pb').discordId, null);
      assert.ok(stored.events[0].orders.every((o) => o.accountId !== 'victim'));
      assert.ok(stored.events[0].guestServers.every((s) => s.accountId !== 'victim'));
    });
    assert.ok(!logs.includes(password));
  } finally {
    const stopped = new Promise((r) => child.exitCode !== null ? r() : child.once('exit', r)); child.kill(); await stopped;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
