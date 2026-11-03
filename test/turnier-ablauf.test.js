'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isolated } = require('../test-support/isolated.cjs');

// Synthetisches Turnier „match“ (buyer gegen other, beide gebunden) mit Bestätigung durch die Gegenseite.
// „outsider“ bekommt eine Person und wird Turnierleiter.
const prepare = (d) => {
  d.persons.push({ id: 'ref', name: 'Synthetic Ref', discordId: 'outsider' });
  const t = d.events[0].tournaments[0];
  Object.assign(t, { confirm: true, confirmMinutes: 10, playerIds: { buyer: 'buyer', other: 'other' } });
};
const tour = (app) => app.snapshot().events[0].tournaments.find((t) => t.id === 'match');
const url = '/api/tournaments/match/matches/r0m0';

test('Bestätigung: Meldung wartet, nur die Gegenseite bestätigt, Widerspruch geht an die Turnierleitung', async (t) => {
  const app = await isolated(t, { prepare });
  let r = await app.request(url, { method: 'POST', user: 'buyer', body: { a: 2, b: 1 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.mySides, { r0m0: 'a' });
  assert.equal(tour(app).results.r0m0, undefined, 'noch kein Ergebnis');
  assert.equal(tour(app).pending.r0m0.by, 'a');

  assert.equal((await app.request(url + '/confirm', { method: 'POST', user: 'buyer' })).status, 403, 'nicht die eigene Meldung bestätigen');
  assert.equal((await app.request(url + '/confirm', { method: 'POST', user: 'outsider' })).status, 403, 'Fremde (noch kein Turnierleiter)');
  r = await app.request(url + '/dispute', { method: 'POST', user: 'other' });
  assert.equal(r.status, 200);
  assert.equal(tour(app).pending.r0m0.disputed, true);
  assert.equal((await app.request(url, { method: 'POST', user: 'buyer', body: { a: 3, b: 0 } })).status, 409, 'strittig: Spieler melden nicht mehr');

  // Abweichende Gegenmeldung führt ebenfalls zum Streitfall; gleiche Meldung gilt sofort
  r = await app.request(url, { method: 'DELETE', admin: true });
  assert.equal(r.status, 400, 'noch kein Ergebnis zum Löschen');
  r = await app.request(url, { method: 'POST', admin: true, body: { a: 2, b: 1 } });
  assert.equal(r.status, 200);
  assert.deepEqual([tour(app).results.r0m0.a, tour(app).results.r0m0.b], [2, 1]);
  assert.equal(tour(app).pending.r0m0, undefined, 'Entscheidung der Orga ersetzt die Meldung');
  const log = tour(app).log.map((e) => e.text);
  assert.ok(log.some((x) => /wartet auf Bestätigung/.test(x)) && log.some((x) => /bestritten/.test(x)) && log.some((x) => /Eingetragen: 2:1/.test(x)), log.join(' | '));
});

test('Gleiche Meldung beider Seiten gilt sofort; abweichende ist strittig', async (t) => {
  const app = await isolated(t, { prepare });
  await app.request(url, { method: 'POST', user: 'buyer', body: { a: 1, b: 2 } });
  await app.request(url, { method: 'POST', user: 'other', body: { a: 1, b: 2 } });
  assert.deepEqual([tour(app).results.r0m0.a, tour(app).results.r0m0.b], [1, 2]);

  const app2 = await isolated(t, { prepare });
  await app2.request(url, { method: 'POST', user: 'buyer', body: { a: 1, b: 2 } });
  await app2.request(url, { method: 'POST', user: 'other', body: { a: 2, b: 1 } });
  assert.equal(tour(app2).results.r0m0, undefined);
  assert.deepEqual(tour(app2).pending.r0m0.counter, { a: 2, b: 1 });
  assert.equal(tour(app2).pending.r0m0.disputed, true);
  const ok = await app2.request(url + '/confirm', { method: 'POST', user: 'other' });
  assert.equal(ok.status, 409, 'strittige Meldung lässt sich nicht einfach bestätigen');
});

test('Turnierleiter: kampflos, Löschen, Disqualifikation und Protokoll – Spieler dürfen das nicht', async (t) => {
  const app = await isolated(t, { prepare });
  assert.equal((await app.request(url + '/forfeit', { method: 'POST', user: 'other', body: { side: 'a' } })).status, 401);
  assert.equal((await app.request('/api/tournaments/match/disqualify', { method: 'POST', user: 'buyer', body: { index: 1 } })).status, 403);
  const pub = await app.request('/api/tournaments/match', { user: 'buyer' });
  assert.equal(pub.data.log, undefined, 'Protokoll nicht öffentlich');
  assert.equal(pub.data.referees, undefined);

  const put = await app.request('/api/tournaments/match', { method: 'PUT', admin: true, body: { referees: ['ref'] } });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal((await app.request('/api/tournaments/match', { method: 'PUT', admin: true, body: { referees: ['nobody'] } })).status, 400);
  const asRef = await app.request('/api/tournaments/match', { user: 'outsider' });
  assert.equal(asRef.data.referee, true);
  assert.ok(Array.isArray(asRef.data.log));

  let r = await app.request(url + '/playing', { method: 'POST', user: 'buyer', body: {} });
  assert.equal(r.status, 200);
  assert.ok(tour(app).playing.r0m0);
  r = await app.request(url + '/forfeit', { method: 'POST', user: 'outsider', body: { side: 'a' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(tour(app).results.r0m0.wo, 'a');
  assert.equal(tour(app).playing.r0m0, undefined, 'Ergebnis beendet „läuft“');
  assert.ok(tour(app).log.some((e) => e.by === 'Synthetic Ref (Turnierleitung)' && /other gewinnt kampflos/.test(e.text)));
  r = await app.request(url, { method: 'DELETE', user: 'outsider' });
  assert.equal(r.status, 200);
  assert.equal(tour(app).results.r0m0, undefined);

  r = await app.request('/api/tournaments/match/disqualify', { method: 'POST', user: 'outsider', body: { index: 0 } });
  assert.equal(r.status, 200);
  assert.deepEqual(tour(app).disqualified, [0]);
  // Disqualifizierter verliert das offene Spiel; Ergebnisse dafür sind nicht mehr möglich
  assert.equal((await app.request(url, { method: 'POST', user: 'other', body: { a: 0, b: 3 } })).status, 409);
  r = await app.request('/api/tournaments/match/disqualify', { method: 'POST', admin: true, body: { index: 0, on: false } });
  assert.deepEqual(tour(app).disqualified, []);
  assert.equal((await app.request('/api/tournaments/match/disqualify', { method: 'POST', admin: true, body: { index: 7 } })).status, 400);
});

test('Ohne Bestätigung gilt die Meldung sofort (bisheriges Verhalten)', async (t) => {
  const app = await isolated(t, { prepare: (d) => { prepare(d); d.events[0].tournaments[0].confirm = false; } });
  const r = await app.request(url, { method: 'POST', user: 'buyer', body: { a: 2, b: 0 } });
  assert.equal(r.status, 200);
  assert.equal(tour(app).results.r0m0.a, 2);
});

test('Teams auslosen, Gruppenphase anlegen und mit festen Setzplätzen starten', async (t) => {
  const app = await isolated(t);
  const players = ['buyer', 'other', 'Synthetic C', 'Synthetic D', 'Synthetic E'];
  let r = await app.request('/api/tournaments', { method: 'POST', admin: true, body: { name: 'Mixed', participants: players, playerIds: { buyer: 'buyer', other: 'other' } } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const id = r.data.id;
  r = await app.request(`/api/tournaments/${id}/draw-teams`, { method: 'POST', admin: true, body: { size: 2, balanced: true } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.teamSize, 2);
  assert.deepEqual(r.data.participants, ['buyer', 'other & Synthetic E', 'Synthetic C & Synthetic D'], 'Schlangenmuster: der Stärkste im kleineren Team');
  assert.deepEqual([r.data.members.buyer, r.data.members['other & Synthetic E']], [['buyer'], ['other']], 'nur gebundene Personen werden Mitglieder');
  assert.equal((await app.request(`/api/tournaments/${id}/draw-teams`, { method: 'POST', admin: true, body: { size: 2 } })).status, 400, 'schon Teams');

  const names = Array.from({ length: 8 }, (_, i) => `Synthetic ${i}`);
  r = await app.request('/api/tournaments', { method: 'POST', admin: true, body: { name: 'Gruppen', type: 'groups', groups: { count: 4, advance: 2 }, participants: names.slice(0, 6), seeds: 2, prizes: ['Synthetic Preis', ''], coins: 3 } });
  assert.equal(r.status, 201);
  assert.deepEqual([r.data.type, r.data.groups, r.data.seeds, r.data.prizes, r.data.coins], ['groups', { count: 4, advance: 2 }, 2, ['Synthetic Preis'], 3]);
  const gid = r.data.id;
  r = await app.request(`/api/tournaments/${gid}/start`, { method: 'POST', admin: true, body: { shuffle: true } });
  assert.equal(r.status, 400, 'zu wenige Teilnehmer für 4 Gruppen');
  await app.request(`/api/tournaments/${gid}`, { method: 'PUT', admin: true, body: { participants: names } });
  r = await app.request(`/api/tournaments/${gid}/start`, { method: 'POST', admin: true, body: { shuffle: true } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.order.slice(0, 2), [0, 1], 'feste Setzplätze bleiben');
  assert.deepEqual([...r.data.order].sort(), [0, 1, 2, 3, 4, 5, 6, 7]);
  r = await app.request(`/api/tournaments/${gid}`, { method: 'PUT', admin: true, body: { roundTimes: { gd0: '2030-01-01T18:00:00Z', bogus: 'x', kr0: '' } } });
  assert.deepEqual(r.data.roundTimes, { gd0: '2030-01-01T18:00:00.000Z' });
  assert.equal((await app.request(`/api/tournaments/${gid}`, { method: 'PUT', admin: true, body: { roundTimes: { gd1: 'kein Datum' } } })).status, 400);
  r = await app.request(`/api/tournaments/${gid}/matches/G0g0m0`, { method: 'POST', admin: true, body: { a: 1, b: 1 } });
  assert.equal(r.status, 200, 'Unentschieden in der Gruppe erlaubt');
});

test('Ohne Einspruch gilt eine Meldung nach Ablauf automatisch', async (t) => {
  const old = new Date(Date.now() - 11 * 60000).toISOString();
  const app = await isolated(t, { prepare: (d) => { prepare(d); d.events[0].tournaments[0].pending = { r0m0: { a: 3, b: 1, pa: 0, pb: 1, by: 'a', at: old } }; } });
  for (let i = 0; i < 40 && !tour(app).results.r0m0; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual([tour(app).results.r0m0.a, tour(app).results.r0m0.b], [3, 1]);
  assert.ok(tour(app).log.some((e) => e.by === 'System' && /automatisch bestätigt/.test(e.text)));
});
