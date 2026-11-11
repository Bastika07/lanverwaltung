'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isolated } = require('../test-support/isolated.cjs');

// Synthetische Person ohne Tickets: gebunden und Turnierleiterin im ersten Event, Teammitglied im zweiten
const prepare = (data) => {
  data.persons.push({ id: 'player', name: 'Synthetic Player' });
  const base = { type: 'ko', status: 'draft', order: [], results: {}, discordEnabled: false };
  data.events[0].tournaments.push({ ...base, id: 'cup', name: 'Cup', participants: ['Synthetic Player', 'buyer'],
    playerIds: { 'Synthetic Player': 'player', buyer: 'buyer' }, members: {}, referees: ['player'] });
  data.events[1].tournaments.push({ ...base, id: 'teams', name: 'Teams', teamSize: 2, participants: ['Team'],
    playerIds: { Team: null }, members: { Team: ['player', 'other'] } });
};
const tournament = (app, event, id) => app.snapshot().events[event].tournaments.find((t) => t.id === id);

test('Person löschen: gebundene Einträge, Teams und Turnierleitung in allen Events werden frei', async (t) => {
  const app = await isolated(t, { prepare });
  assert.equal((await app.request('/api/persons/player', { method: 'DELETE', admin: true })).status, 200);
  const cup = tournament(app, 0, 'cup');
  assert.deepEqual(cup.participants, ['Synthetic Player', 'buyer'], 'entry stays as a name');
  assert.deepEqual(cup.playerIds, { 'Synthetic Player': null, buyer: 'buyer' });
  assert.deepEqual(cup.referees, []);
  assert.deepEqual(tournament(app, 1, 'teams').members, { Team: ['other'] });
});

test('Personen zusammenführen: Zielperson übernimmt die Turnierleitung', async (t) => {
  const app = await isolated(t, { prepare });
  const merged = await app.request('/api/persons/player/merge', { method: 'POST', admin: true, body: { into: 'other' } });
  assert.equal(merged.status, 200, JSON.stringify(merged.data));
  assert.deepEqual(tournament(app, 0, 'cup').referees, ['other']);
  assert.deepEqual(tournament(app, 1, 'teams').members, { Team: ['other'] }, 'no duplicate member');
});
