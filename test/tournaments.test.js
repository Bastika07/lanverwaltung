'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Bracket = require('../public/bracket.js');
const { tournamentModule } = require('../test-support/tournaments.cjs');

const running = (extra = {}) => ({ id: 'cup', name: 'Cup', type: 'ko', status: 'running', participants: ['Synthetic A', 'Synthetic B', 'Synthetic C', 'Synthetic D'],
  order: [0, 1, 2, 3], results: {}, members: {}, playerIds: {}, ...extra });

test('Turniermodul: of(event) arbeitet nur auf den Turnieren dieses Events', () => {
  const draft = { id: 'd', status: 'draft', signup: true, participants: [] };
  const other = { id: 'o', status: 'draft', signup: true, participants: [] };
  const { tournaments } = tournamentModule({ event: { tournaments: [draft] } });
  assert.deepEqual(tournaments.of({ tournaments: [draft] }).openForSignup(), [draft]);
  assert.deepEqual(tournaments.of({ tournaments: [other] }).openForSignup(), [other]);
});

test('reportResult (TMT2): trägt ein offenes Spiel einmal ein, speichert einmal und meldet es dem notifier', () => {
  const t = running();
  const { of, saves, notes, broadcasts } = tournamentModule({ event: { tournaments: [t] } });
  const m = Bracket.playable(Bracket.compute(t))[0];
  assert.equal(of.reportResult(t, m.id, 2, 1, m.a, m.b), null);
  assert.deepEqual({ a: t.results[m.id].a, b: t.results[m.id].b }, { a: 2, b: 1 });
  assert.equal(saves.length, 1);
  assert.deepEqual(broadcasts, [['tournament', 'cup']]);
  assert.equal(notes.length, 1);
  const [name, tour, info] = notes[0];
  assert.equal(name, 'resultReported');
  assert.equal(tour, t);
  assert.equal(info.matchId, m.id);
  assert.equal(info.correction, false);
  assert.equal(info.wasFinished, false);
  assert.equal(of.reportResult(t, m.id, 2, 1, m.a, m.b), null, 'same result again is accepted without change');
  assert.equal(saves.length, 1);
});

test('reportResult (TMT2): abgelehnte Meldungen ändern nichts und speichern nicht', () => {
  const t = running();
  const { of, saves, notes } = tournamentModule({ event: { tournaments: [t] } });
  const m = Bracket.playable(Bracket.compute(t))[0];
  assert.match(of.reportResult(t, m.id, 1, 1, m.a, m.b), /Kein eindeutiger Sieger/);
  assert.match(of.reportResult(t, m.id, 2, 1, m.b, m.a), /Paarung hat sich geändert/);
  assert.match(of.reportResult(t, 'missing', 2, 1, m.a, m.b), /nicht mehr im Turnierbaum/);
  assert.match(of.reportResult({ ...t, status: 'draft' }, m.id, 2, 1, m.a, m.b), /läuft nicht/);
  of.reportResult(t, m.id, 2, 1, m.a, m.b);
  assert.match(of.reportResult(t, m.id, 0, 2, m.a, m.b), /schon ein anderes Ergebnis/, 'never a correction');
  assert.equal(t.results[m.id].a, 2);
  assert.equal(saves.length, 1);
  assert.equal(notes.length, 1);
});

test('setParticipants: prüft die Liste, bindet nur ausdrücklich und meldet die Änderung', () => {
  const t = { id: 'cup', name: 'Cup', type: 'ko', status: 'draft', signup: true, participants: ['Bob'], members: {}, playerIds: { Bob: 'bob' }, order: [], results: {} };
  const db = { persons: [{ id: 'bob', name: 'Bob' }, { id: 'alice', name: 'Alice' }] };
  const { of, saves, notes, HttpError } = tournamentModule({ db, event: { tournaments: [t] } });
  of.setParticipants(t, ['Bob', 'Alice', 'Carol'], { Alice: 'alice' });
  assert.deepEqual(t.playerIds, { Bob: 'bob', Alice: 'alice', Carol: null }, 'Carol is a typed name and stays unbound');
  assert.deepEqual(notes.map(([name]) => name), ['changed']);
  assert.equal(saves.length, 1);
  assert.throws(() => of.setParticipants(t, ['Bob', 'bob']), (err) => err instanceof HttpError && /doppelt/.test(err.message));
  assert.deepEqual(t.participants, ['Bob', 'Alice', 'Carol'], 'rejected list changes nothing');
  assert.equal(saves.length, 1);
});

test('autoConfirm: abgelaufene Meldungen gelten, bestrittene und veraltete nicht', () => {
  const t = running({ confirm: true, confirmMinutes: 10 });
  const { of, saves, notes } = tournamentModule({ event: { tournaments: [t] } });
  const [m1, m2] = Bracket.playable(Bracket.compute(t));
  const old = new Date(Date.now() - 11 * 60000).toISOString();
  t.pending = {
    [m1.id]: { a: 2, b: 0, pa: m1.a, pb: m1.b, by: 'a', at: old },
    [m2.id]: { a: 1, b: 2, pa: m2.a, pb: m2.b, by: 'a', at: old, disputed: true },
  };
  of.autoConfirm(Date.now() - 2 * 60000);
  assert.equal(saves.length, 0, 'not yet expired');
  of.autoConfirm();
  assert.equal(t.results[m1.id].a, 2);
  assert.equal(t.results[m2.id], undefined, 'disputed stays open for the referees');
  assert.equal(t.pending[m1.id], undefined);
  assert.ok(t.pending[m2.id]);
  assert.deepEqual(notes.map(([name]) => name), ['resultReported']);
  assert.equal(saves.length, 1);
  assert.match(t.log.at(-1).text, /automatisch bestätigt/);
});
