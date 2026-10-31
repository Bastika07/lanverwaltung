'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { isolated } = require('../test-support/isolated.cjs');

// Lokale Discord-Attrappe für OAuth (Token, /users/@me) und die Bot-API (Gildenmitglieder).
async function discordMock(t) {
  const members = new Set(), broken = new Set(), calls = [];
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (b) => { body += b; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      calls.push(`${req.method} ${url.pathname}`);
      if (req.method === 'POST' && url.pathname === '/api/oauth2/token') return json(res, 200, { access_token: new URLSearchParams(body).get('code') });
      if (url.pathname === '/api/v10/users/@me') {
        const id = String(req.headers.authorization || '').replace(/^Bearer /, '');
        return json(res, 200, { id, username: id, global_name: id, verified: false });
      }
      const member = url.pathname.match(/^\/bot\/guilds\/synthetic-guild\/members\/([\w-]+)$/);
      if (member) {
        if (broken.has(member[1])) return json(res, 500, { message: 'Synthetic outage' });
        return members.has(member[1]) ? json(res, 200, { roles: [] }) : json(res, 404, { message: 'Unknown Member' });
      }
      return json(res, 404, { message: 'Not available in synthetic Discord' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { base: `http://127.0.0.1:${server.address().port}`, members, broken, calls };
}

const oauthEnv = (mock) => ({ DISCORD_CLIENT_ID: 'synthetic-client', DISCORD_CLIENT_SECRET: 'synthetic-secret', DISCORD_OAUTH_BASE: mock.base });
const botEnv = (mock) => ({ ...oauthEnv(mock), DISCORD_BOT_TOKEN: 'synthetic-token', DISCORD_GUILD_ID: 'synthetic-guild', DISCORD_API_BASE: `${mock.base}/bot` });
const requireMember = (value) => (data) => {
  data.meta.ticketSettings = { requireMember: value };
  data.events.find((e) => e.id === 'first').ticketTypes[0].quota = 50;
};

async function oauthLogin(app, code) {
  const start = await fetch(`${app.base}/api/auth/login`, { redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const callback = await fetch(`${app.base}/api/auth/callback?code=${code}&state=${state}`, { redirect: 'manual', headers: { Cookie: `lan_state=${state}` } });
  const session = callback.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => /^lan_user=[0-9a-f]{64}$/.test(c));
  return { session, location: decodeURIComponent(callback.headers.get('location') || '') };
}
const order = (app, cookie) => app.request('/api/tickets/orders', { method: 'POST', headers: { Cookie: cookie },
  body: { items: [{ typeId: 'normal', holder: 'Synthetic Holder' }] } });
const orderCount = (app, accountId) => app.snapshot().events.find((e) => e.id === 'first').orders.filter((o) => o.accountId === accountId).length;

test('Mitgliedspflicht: Austritt nach dem Login verhindert neue Bestellungen; Störungen schließen ab', async (t) => {
  const mock = await discordMock(t);
  const app = await isolated(t, { prepare: requireMember(true), env: botEnv(mock) });
  mock.members.add('outsider');
  const { session } = await oauthLogin(app, 'outsider');
  assert.ok(session, 'member login creates a session');

  assert.equal((await order(app, session)).status, 201, 'current members can order');
  assert.equal(orderCount(app, 'outsider'), 1);

  mock.members.delete('outsider');
  const left = await order(app, session);
  assert.equal(left.status, 403);
  assert.match(left.data.error, /Nur für Mitglieder/);
  assert.equal(orderCount(app, 'outsider'), 1, 'no order after leaving the guild');

  mock.members.add('outsider');
  mock.broken.add('outsider');
  const outage = await order(app, session);
  assert.equal(outage.status, 503);
  assert.match(outage.data.error, /nicht geprüft werden/);
  assert.equal(orderCount(app, 'outsider'), 1, 'no order while membership cannot be verified');

  mock.broken.delete('outsider');
  assert.equal((await order(app, session)).status, 201, 'valid membership orders again');
  assert.equal(mock.calls.filter((c) => c === 'GET /bot/guilds/synthetic-guild/members/outsider').length, 5, 'login plus every order checks Discord');

  const denied = await oauthLogin(app, 'stranger');
  assert.equal(denied.session, undefined);
  assert.match(denied.location, /Nur für Mitglieder/);
});

test('Mitgliedspflicht ohne Bot: OAuth allein genügt nicht und Betreiber sehen den Grund', async (t) => {
  const mock = await discordMock(t);
  const app = await isolated(t, { prepare: requireMember(true), env: oauthEnv(mock) });
  const denied = await oauthLogin(app, 'outsider');
  assert.equal(denied.session, undefined, 'no session without reliable guild check');
  assert.match(denied.location, /nicht geprüft werden/);

  const existing = await order(app, app.cookieFor('buyer'));
  assert.equal(existing.status, 403, 'existing sessions cannot order either');
  assert.match(existing.data.error, /Orga informieren/);
  assert.equal(orderCount(app, 'buyer'), 1);

  const admin = await app.request('/api/tickets/admin', { admin: true });
  assert.equal(admin.status, 200);
  assert.equal(admin.data.memberCheck, false);
  assert.equal(admin.data.settings.requireMember, true);
  assert.match(app.logs(), /"member_check_unavailable"/);
  assert.equal(mock.calls.some((c) => c.includes('/members/')), false, 'no bot calls without bot configuration');
});

test('ohne Mitgliedspflicht bleibt der OAuth-Betrieb ohne Bot möglich', async (t) => {
  const mock = await discordMock(t);
  const app = await isolated(t, { prepare: requireMember(false), env: oauthEnv(mock) });
  const { session } = await oauthLogin(app, 'outsider');
  assert.ok(session);
  assert.equal((await order(app, session)).status, 201);
  assert.equal((await order(app, app.cookieFor('buyer'))).status, 201);
});
