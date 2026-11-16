'use strict';
// Issue #121: Login mit Rücksprung zu „Meine Turniere“ und Selbstanmeldung nur mit Ticket.
// Nur synthetische Daten und eine lokale Discord-Attrappe.
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

// Login über die Attrappe; liefert das Ziel der Weiterleitung nach dem Callback
async function landing(app, code, query = '') {
  const start = await fetch(`${app.base}/api/auth/login${query}`, { redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const callback = await fetch(`${app.base}/api/auth/callback?code=${code}&state=${state}`, { redirect: 'manual', headers: { Cookie: `lan_state=${state}` } });
  return callback.headers.get('location');
}

test('Login mit ziel=turniere springt zu „Meine Turniere“ zurück, andere Ziele nicht', async (t) => {
  const base = await discordMock(t);
  const app = await isolated(t, { env: { DISCORD_CLIENT_ID: 'synthetic-client', DISCORD_CLIENT_SECRET: 'synthetic-secret', DISCORD_OAUTH_BASE: base } });
  assert.equal(await landing(app, 'anna', '?ziel=turniere'), '/#/meine-turniere');
  assert.equal(await landing(app, 'ben'), '/#/tickets', 'without target: as before');
  assert.equal(await landing(app, 'carl', '?ziel=https%3A%2F%2Fevil.invalid%2F'), '/#/tickets', 'no free redirect');
  assert.equal(await landing(app, 'dora', '?ziel=__proto__'), '/#/tickets', 'only own keys count');
});

// Offenes Einzelturnier „solo“ im ersten Event; buyer hat ein Ticket, outsider nicht.
const solo = (d) => d.events[0].tournaments.push({ id: 'solo', name: 'Synthetic Solo', type: 'ko', status: 'draft', signup: true,
  participants: [], members: {}, playerIds: {}, order: [], results: {}, discordEnabled: false });
const join = (app, user) => app.request('/api/tournaments/solo/signup/join', { method: 'POST', user, body: {} });
const entrants = (app) => app.snapshot().events[0].tournaments.find((x) => x.id === 'solo').participants;

test('Einzelturnier im Web: Selbstanmeldung nur mit Ticket, sofern das Event Tickets verkauft', async (t) => {
  const app = await isolated(t, { prepare: solo });
  let r = await join(app, 'outsider');
  assert.equal(r.status, 403, JSON.stringify(r.data));
  assert.match(r.data.error, /Ticket/);
  assert.equal(r.data.code, 'no-ticket', 'web clients get the refusal code like Discord');
  assert.deepEqual(entrants(app), [], 'refused signup changes nothing');
  r = await join(app, 'buyer');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(entrants(app), ['buyer']);
});

test('Ohne Ticketmodul im Event dürfen sich alle angemeldeten Konten eintragen', async (t) => {
  const app = await isolated(t, { prepare: (d) => { solo(d); d.events[0].modules = { ...d.events[0].modules, tickets: false }; } });
  const r = await join(app, 'outsider');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(entrants(app), ['outsider']);
});
