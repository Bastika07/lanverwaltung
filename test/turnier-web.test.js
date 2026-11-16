'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isolated } = require('../test-support/isolated.cjs');

// Teamturnier „team“ mit offener Anmeldung und Coins; buyer und other haben Tickets, outsider nicht.
const prepare = (d) => {
  d.meta.settings.coinBudget = 3;
  d.events[0].tournaments.push({ id: 'team', name: 'Synthetic Cup', type: 'ko', status: 'draft', signup: true, teamSize: 2, coins: 2,
    participants: [], members: {}, playerIds: {}, order: [], results: {}, discordEnabled: false });
};
const tour = (app) => app.snapshot().events[0].tournaments.find((t) => t.id === 'team');
const act = (app, user, action, body = {}) => app.request(`/api/tournaments/team/signup/${action}`, { method: 'POST', user, body });

test('Meine Turniere: gründen, anfragen, Captain bestätigt – nur mit Ticket', async (t) => {
  const app = await isolated(t, { prepare });
  let r = await app.request('/api/tournaments/signup');
  assert.equal(r.status, 200);
  assert.equal(r.data.loggedIn, false);
  assert.equal((await app.request('/api/tournaments/team/signup/found', { method: 'POST', body: { name: 'X' } })).status, 401, 'login required');

  r = await act(app, 'buyer', 'found', { name: 'Synthetic Team' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const mine = r.data.view.tournaments.find((x) => x.id === 'team');
  assert.equal(mine.team.captain, true);
  assert.equal(r.data.view.coins.left, 1, 'founder paid 2 of 3 coins');

  r = await act(app, 'outsider', 'request', { team: 'Synthetic Team' });
  assert.equal(r.status, 403, 'no ticket, no signup');
  assert.match(r.data.error, /Ticket/);

  r = await act(app, 'other', 'request', { team: 'Synthetic Team' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.view.tournaments.find((x) => x.id === 'team').request, 'Synthetic Team');
  assert.equal((await act(app, 'other', 'accept', { person: 'other' })).status, 403, 'only the captain answers');

  r = await app.request('/api/tournaments/signup', { user: 'buyer' });
  assert.deepEqual(r.data.tournaments.find((x) => x.id === 'team').team.requests.map((x) => x.id), ['other']);
  r = await act(app, 'buyer', 'accept', { person: 'other' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(tour(app).members['Synthetic Team'], ['buyer', 'other']);
  assert.deepEqual(tour(app).requests, []);
  assert.equal((await act(app, 'buyer', 'unknown')).status, 404);

  // Orga: Teams auch im laufenden Turnier; Besucher dürfen das nicht
  assert.equal((await app.request('/api/tournaments/team/team-admin', { method: 'POST', user: 'buyer', body: { team: 'Synthetic Team', action: 'remove', person: 'other' } })).status, 401);
  r = await app.request('/api/tournaments/team/team-admin', { method: 'POST', admin: true, body: { team: 'Synthetic Team', action: 'remove', person: 'other' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(tour(app).members['Synthetic Team'], ['buyer']);
});

test('Kontolöschung des Captains löst sein Team im offenen Turnier auf', async (t) => {
  const app = await isolated(t, { prepare });
  await act(app, 'buyer', 'found', { name: 'Synthetic Team' });
  await act(app, 'other', 'request', { team: 'Synthetic Team' });
  await act(app, 'buyer', 'accept', { person: 'other' });
  const r = await app.request('/api/account', { method: 'DELETE', user: 'buyer' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(tour(app).participants, []);
  assert.deepEqual(tour(app).members, {});
  const view = await app.request('/api/tournaments/signup', { user: 'other' });
  assert.equal(view.data.coins.left, 3, 'remaining member gets the coins back');
  // Laufendes Turnier behält den (pseudonymisierten) Eintrag
  assert.deepEqual(app.snapshot().events[0].tournaments.find((x) => x.id === 'match').participants.length, 2);
});

// HTTP-Seite (lib/tournament-http.js): Admin-Routen lehnen Besucher ab, bevor sie den Body lesen
test('Admin-Routen der Turniere prüfen den Zugang vor dem Body', async (t) => {
  const app = await isolated(t, { prepare });
  for (const [method, url] of [['POST', '/api/tournaments'], ['PUT', '/api/tournaments/team'], ['POST', '/api/tournaments/team/start'],
    ['POST', '/api/tournaments/team/draw-teams'], ['POST', '/api/tournaments/team/team-admin']]) {
    const r = await app.request(url, { method, user: 'buyer', raw: 'kein JSON' });
    assert.equal(r.status, 401, `${method} ${url}: ${JSON.stringify(r.data)}`);
  }
});
