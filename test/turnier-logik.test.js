'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tournamentModule } = require('../test-support/tournaments.cjs');
const Bracket = require('../public/bracket.js');

const names = (n) => Array.from({ length: n }, (_, i) => `Synthetic ${i}`);
const tour = (type, n, extra = {}) => ({ type, participants: names(n), order: names(n).map((_, i) => i), results: {}, ...extra });
// Ergebnis für das aktuelle Spiel eintragen (Seite a gewinnt, außer winB)
function play(t, id, a = 1, b = 0) {
  const m = Bracket.compute(t).matches.find((x) => x.id === id);
  assert.equal(m.status, 'ready', `${id} spielbereit`);
  t.results[id] = { a, b, pa: m.a, pb: m.b };
}

test('Kampflos: Gegner kommt weiter, Ergebnis zeigt w.o. ohne Punkte', () => {
  const t = tour('ko', 4);
  const m = Bracket.compute(t).matches.find((x) => x.id === 'r0m0');
  t.results.r0m0 = { a: 0, b: 0, wo: 'a', pa: m.a, pb: m.b };
  const v = Bracket.compute(t);
  const done = v.matches.find((x) => x.id === 'r0m0');
  assert.deepEqual([done.status, done.wo, done.winner, done.score], ['done', 'a', m.b, null]);
  assert.equal(v.rounds[1][0].a, m.b, 'Sieger rückt ins Finale');
});

test('Disqualifikation: offene Spiele gehen kampflos an den Gegner, gespielte bleiben', () => {
  const t = tour('ko', 4);
  play(t, 'r0m0'); // Seed 1 schlägt Seed 4
  const before = Bracket.compute(t);
  const winner = before.matches.find((x) => x.id === 'r0m0').winner;
  t.disqualified = [winner];
  const v = Bracket.compute(t);
  assert.equal(v.matches.find((x) => x.id === 'r0m0').winner, winner, 'gespieltes Ergebnis bleibt');
  play(t, 'r0m1');
  const fin = Bracket.compute(t).rounds[1][0];
  assert.deepEqual([fin.status, fin.dq, fin.loser], ['done', true, winner]);
  assert.ok(Bracket.compute(t).finished);

  const rr = tour('rr', 4, { disqualified: [0] });
  const view = Bracket.compute(rr);
  assert.ok(view.matches.filter((m) => m.a === 0 || m.b === 0).every((m) => m.status === 'done' && m.wo));
  assert.equal(view.standings.at(-1).p, 0, 'Disqualifizierte stehen unten');
  assert.ok(view.standings.slice(0, 3).every((s) => s.pts === 3 && s.gf === 0), 'kampflos: 3 Punkte, keine Tore');
});

test('Offene Meldung und „läuft“ gelten nur für die unveränderte Paarung', () => {
  const t = tour('ko', 4);
  const m = Bracket.compute(t).matches[0];
  t.pending = { [m.id]: { a: 2, b: 1, pa: m.a, pb: m.b, by: 'a', at: 'x' } };
  t.playing = { [m.id]: { pa: m.a, pb: m.b, at: 'y' }, r0m1: { pa: 99, pb: 98, at: 'z' } };
  const v = Bracket.compute(t);
  assert.deepEqual(v.matches[0].pending, { a: 2, b: 1, by: 'a', at: 'x', disputed: false });
  assert.equal(v.matches[0].playing, true);
  assert.equal(v.matches[0].status, 'ready', 'Meldung ist noch kein Ergebnis');
  assert.equal(v.matches[1].playing, undefined, 'veraltete Paarung');
});

test('Gruppenphase: Schlangenmuster, Kreuz-Setzung, K.-o.-Runde erst nach den Gruppen', () => {
  assert.deepEqual(Bracket.groupSplit([0, 1, 2, 3, 4, 5, 6, 7], 2), [[0, 3, 4, 7], [1, 2, 5, 6]]);
  const t = tour('groups', 8, { groups: { count: 2, advance: 2 }, thirdPlace: true });
  let v = Bracket.compute(t);
  assert.equal(v.groups.length, 2);
  assert.deepEqual(v.ko.rounds[0].map((m) => [m.hintA, m.hintB]), [['1. Gruppe A', '2. Gruppe B'], ['1. Gruppe B', '2. Gruppe A']]);
  assert.equal(Bracket.playable(v).length, 4, 'erster Spieltag beider Gruppen');
  assert.ok(v.matches.some((m) => m.id.startsWith('G0g')) && v.matches.some((m) => m.id.startsWith('kr0')));
  // Gruppen durchspielen: kleinerer Index gewinnt
  for (let guard = 0; guard < 20; guard++) {
    const open = Bracket.playable(Bracket.compute(t)).filter((m) => m.id.startsWith('G'));
    if (!open.length) break;
    for (const m of open) t.results[m.id] = m.a < m.b ? { a: 2, b: 0, pa: m.a, pb: m.b } : { a: 0, b: 2, pa: m.a, pb: m.b };
  }
  v = Bracket.compute(t);
  assert.ok(v.groups.every((g) => g.finished));
  assert.deepEqual(v.ko.rounds[0].map((m) => [m.a, m.b]), [[0, 2], [1, 3]], 'A1–B2, B1–A2');
  for (const id of ['kr0m0', 'kr0m1', 'kr1m0', 'kp3']) play(t, id);
  v = Bracket.compute(t);
  assert.ok(v.finished);
  assert.equal(v.champion, 0);
  assert.deepEqual(v.ranking.map((r) => r.place), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(v.roundList.map((r) => r.key), ['gd0', 'gd1', 'gd2', 'kr0', 'kr1', 'kp3']);
});

test('Endstand: K.-o. teilt Plätze nach Ausscheiderunde, Double Elimination nach Verliererrunde', () => {
  const ko = tour('ko', 8);
  for (const id of ['r0m0', 'r0m1', 'r0m2', 'r0m3', 'r1m0', 'r1m1', 'r2m0']) play(ko, id);
  const v = Bracket.compute(ko);
  assert.deepEqual(v.ranking.map((r) => r.place), [1, 2, 3, 3, 5, 5, 5, 5]);

  const de = tour('de', 4, { gfReset: false });
  for (let guard = 0; guard < 10; guard++) {
    const open = Bracket.playable(Bracket.compute(de));
    if (!open.length) break;
    for (const m of open) de.results[m.id] = { a: 1, b: 0, pa: m.a, pb: m.b };
  }
  const d = Bracket.compute(de);
  assert.ok(d.finished);
  assert.deepEqual(d.ranking.map((r) => r.place), [1, 2, 3, 4]);
  assert.equal(new Set(d.ranking.map((r) => r.p)).size, 4);
});

test('Rundenschlüssel für Rundenzeiten', () => {
  assert.deepEqual(Bracket.compute(tour('ko', 4, { thirdPlace: true })).roundList.map((r) => r.key), ['r0', 'r1', 'p3']);
  assert.deepEqual(Bracket.compute(tour('de', 4)).roundList.map((r) => r.key), ['w0', 'w1', 'l0', 'l1', 'gf1', 'gf2']);
  assert.deepEqual(Bracket.compute(tour('rr', 3)).roundList.map((r) => r.key), ['g0', 'g1', 'g2']);
});

test('Coins und Teilnehmerlimit bei /anmelden und /team', () => {
  const persons = { u1: { id: 'p1', name: 'Synthetic One' }, u2: { id: 'p2', name: 'Synthetic Two' } };
  const free = { id: 'f', name: 'Fun Cup', status: 'draft', signup: true, participants: [], playerIds: {}, members: {}, coins: 0 };
  const prize1 = { id: 'a', name: 'Preis A', status: 'draft', signup: true, participants: [], playerIds: {}, members: {}, coins: 2 };
  const prize2 = { id: 'b', name: 'Preis B', status: 'draft', signup: true, participants: [], playerIds: {}, members: {}, coins: 2 };
  const full = { id: 'c', name: 'Voll', status: 'draft', signup: true, participants: ['Synthetic X'], playerIds: {}, members: {}, maxParticipants: 1 };
  const event = { id: 'e', tournaments: [free, prize1, prize2, full] };
  // Echtes Turniermodul (Coins, Teilnehmerlimit, Bindung), ohne Discord und ohne Speicher
  const { tournaments } = tournamentModule({ db: { persons: Object.values(persons) }, event, coinBudget: () => 3 });
  const commands = require('../lib/commands.js')({
    Discord: { md: String }, settings: () => ({ coinBudget: 3 }), moduleOn: () => true, mayViewDiscord: () => true,
    tournaments, event: { current: () => event }, schedule: {}, announcements: {},
    people: { byDiscord: (id) => persons[id], selfLink: () => null },
  });
  const run = (name, user, opts) => commands.find(name).run({ user: { id: user }, opts });
  assert.match(run('anmelden', 'u1', { turnier: 'f' }), /Angemeldet/);
  assert.match(run('anmelden', 'u1', { turnier: 'a' }), /Noch 1 von 3/);
  assert.throws(() => run('anmelden', 'u1', { turnier: 'b' }), /fehlen dir Coins.*noch 1 von 3/);
  assert.match(run('anmelden', 'u2', { turnier: 'b' }), /Angemeldet/);
  assert.throws(() => run('anmelden', 'u2', { turnier: 'c' }), /voll/);
  assert.match(run('coins', 'u1', {}), /noch \*\*1\*\* von 3[\s\S]*Preis A: 2/);
  run('abmelden', 'u1', { turnier: 'a' });
  assert.match(run('anmelden', 'u1', { turnier: 'b' }), /Angemeldet/, 'Abmelden gibt Coins zurück');
});
