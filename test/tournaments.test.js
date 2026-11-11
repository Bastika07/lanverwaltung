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

const tmt2 = { tmt2: true };
const fromTmt = (of, t, m, a, b, pa = m.a, pb = m.b) => of.reportResult(tmt2, t, m.id, { a, b, pa, pb });

test('reportResult (TMT2): trägt ein offenes Spiel einmal ein, speichert einmal und meldet es dem notifier', () => {
  const t = running();
  const { of, saves, notes, broadcasts } = tournamentModule({ event: { tournaments: [t] } });
  const m = Bracket.playable(Bracket.compute(t))[0];
  fromTmt(of, t, m, 2, 1);
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
  assert.equal(info.after.matches.find((x) => x.id === m.id).status, 'done', 'notifier gets the view after the change');
  assert.match(t.log.at(-1).by, /TMT2/);
  fromTmt(of, t, m, 2, 1); // gleiches Ergebnis noch einmal: angenommen, ohne Änderung
  assert.equal(saves.length, 1);
});

test('reportResult (TMT2): abgelehnte Meldungen ändern nichts und speichern nicht', () => {
  const t = running();
  const { of, saves, notes } = tournamentModule({ event: { tournaments: [t] } });
  const m = Bracket.playable(Bracket.compute(t))[0];
  assert.throws(() => fromTmt(of, t, m, 1, 1), /Kein eindeutiger Sieger – Ergebnis bitte von Hand eintragen/);
  assert.throws(() => fromTmt(of, t, m, 2, 1, m.b, m.a), /Paarung hat sich geändert/);
  assert.throws(() => of.reportResult(tmt2, t, 'missing', { a: 2, b: 1, pa: m.a, pb: m.b }), /nicht mehr im Turnierbaum/);
  assert.throws(() => fromTmt(of, { ...t, status: 'draft' }, m, 2, 1), /läuft nicht/);
  fromTmt(of, t, m, 2, 1);
  assert.throws(() => fromTmt(of, t, m, 0, 2), /schon ein anderes Ergebnis/, 'never a correction');
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

// Zwei gebundene Spieler, ein Turnierleiter und ein Unbeteiligter (synthetische Discord-IDs)
function withPlayers(extra = {}) {
  const persons = [['pa', 'Synthetic A', '100000000000000001'], ['pb', 'Synthetic B', '100000000000000002'], ['pc', 'Synthetic C', '100000000000000003'],
    ['pd', 'Synthetic D', '100000000000000004'], ['ref', 'Synthetic Referee', '100000000000000009'], ['out', 'Synthetic Outsider', '100000000000000008']]
    .map(([id, name, discordId]) => ({ id, name, discordId }));
  const t = running({ playerIds: { 'Synthetic A': 'pa', 'Synthetic B': 'pb', 'Synthetic C': 'pc', 'Synthetic D': 'pd' }, referees: ['ref'], ...extra });
  const mod = tournamentModule({ db: { persons }, event: { tournaments: [t] } });
  const m = Bracket.playable(Bracket.compute(t))[0];
  // Rollen: Seite a und b dieses Spiels, ein Spieler eines anderen Spiels, Turnierleiter, Unbeteiligter
  const ids = { a: t.playerIds[t.participants[m.a]], b: t.playerIds[t.participants[m.b]], ref: 'ref', out: 'out',
    other: Object.values(t.playerIds).find((id) => ![t.participants[m.a], t.participants[m.b]].some((n) => t.playerIds[n] === id)) };
  const as = (role) => ({ discordId: persons.find((p) => p.id === ids[role]).discordId });
  return { t, m, as, ...mod };
}

test('Akteure: Spieler melden nur eigene Spiele, Leitung nur Turnierleitung, TMT2 nur Ergebnisse', () => {
  const { t, m, as, of, saves, HttpError } = withPlayers();
  const rejects = (fn, status) => assert.throws(fn, (err) => err instanceof HttpError && err.status === status);
  rejects(() => of.reportResult(as('out'), t, m.id, { a: 2, b: 0 }), 403);
  rejects(() => of.reportResult(as('other'), t, m.id, { a: 2, b: 0 }), 403);
  rejects(() => of.forfeit(as('a'), t, m.id, 'b'), 401);
  rejects(() => of.clearResult(as('a'), t, m.id), 401);
  for (const op of ['confirmResult', 'disputeResult', 'clearResult']) assert.throws(() => of[op](tmt2, t, m.id), HttpError, op);
  assert.throws(() => of.setPlaying(tmt2, t, m.id, true), HttpError);
  assert.throws(() => of.forfeit(tmt2, t, m.id, 'a'), HttpError);
  assert.equal(saves.length, 0, 'no rejected call saves');
  assert.deepEqual(t.results, {});

  of.forfeit(as('ref'), t, m.id, 'b');
  assert.equal(t.results[m.id].wo, 'b');
  assert.match(t.log.at(-1).by, /Synthetic Referee \(Turnierleitung\)/);
  of.clearResult({ admin: true }, t, m.id);
  assert.equal(t.results[m.id], undefined);
  assert.equal(t.log.at(-1).by, 'Orga');
});

test('Bestätigung: Meldung wartet, nur die Gegenseite bestätigt, abweichende Meldung ist strittig', () => {
  const { t, m, as, of, notes, HttpError } = withPlayers({ confirm: true });
  of.reportResult(as('a'), t, m.id, { a: 2, b: 1 });
  assert.equal(t.results[m.id], undefined, 'pending, not committed');
  assert.equal(t.pending[m.id].by, 'a');
  assert.throws(() => of.confirmResult(as('a'), t, m.id), (err) => err instanceof HttpError && err.status === 403);
  of.reportResult(as('b'), t, m.id, { a: 1, b: 2 });
  assert.equal(t.pending[m.id].disputed, true);
  assert.throws(() => of.confirmResult(as('b'), t, m.id), (err) => err instanceof HttpError && err.status === 409);
  of.confirmResult(as('ref'), t, m.id);
  assert.deepEqual({ a: t.results[m.id].a, b: t.results[m.id].b }, { a: 2, b: 1 });
  assert.deepEqual(notes.map(([name]) => name), ['resultPending', 'resultDisputed', 'resultReported']);
});

test('Ergebnis melden berechnet den Spielplan zweimal: vorher und nachher', (t) => {
  const compute = Bracket.compute;
  const { t: tour, m, of } = withPlayers();
  let calls = 0;
  Bracket.compute = (x) => { calls++; return compute(x); };
  t.after(() => { Bracket.compute = compute; });
  of.reportResult({ admin: true }, tour, m.id, { a: 2, b: 0 });
  assert.equal(calls, 2);
});

test('Verwalten: nur die Orga legt an, ändert, startet, setzt zurück, kopiert, lost aus und löscht', async () => {
  const { t, as, of, saves, HttpError } = withPlayers();
  const rejects = (fn) => assert.throws(fn, (err) => err instanceof HttpError && err.status === 401);
  for (const who of [as('a'), as('ref'), {}, tmt2]) {
    rejects(() => of.create(who, { name: 'Synthetic Cup' }));
    rejects(() => of.update(who, t, { name: 'Umbenannt' }));
    rejects(() => of.start(who, t, {}));
    rejects(() => of.reset(who, t));
    rejects(() => of.duplicate(who, t));
    rejects(() => of.drawTeams(who, t, { size: 2 }));
    rejects(() => of.remove(who, t));
    await assert.rejects(of.syncDiscord(who, t), (err) => err.status === 401);
  }
  assert.equal(saves.length, 0);
  assert.equal(t.name, 'Cup');

  const admin = { admin: true };
  const draft = of.create(admin, { name: 'Synthetic Cup', participants: ['X', 'Y', 'Z'], seeds: 1 });
  assert.equal(draft.status, 'draft');
  const copy = of.duplicate(admin, draft);
  assert.equal(copy.name, 'Synthetic Cup (Kopie)');
  of.start(admin, draft, { shuffle: true });
  assert.equal(draft.status, 'running');
  assert.equal(draft.order[0], 0, 'fixed seed stays first');
  of.reset(admin, draft);
  assert.equal(draft.status, 'draft');
  of.remove(admin, copy);
  assert.equal(of.list().includes(copy), false);
});

test('Disqualifizieren: Turnierleitung ja, Spieler nein', () => {
  const { t, as, of, notes, HttpError } = withPlayers();
  assert.throws(() => of.disqualify(as('a'), t, 1), (err) => err instanceof HttpError && err.status === 403);
  of.disqualify(as('ref'), t, 1);
  assert.deepEqual(t.disqualified, [1]);
  const [name, , info] = notes.at(-1);
  assert.equal(name, 'disqualified');
  assert.ok(info.before && info.after, 'notifier gets both views');
  of.disqualify({ admin: true }, t, 1, false);
  assert.deepEqual(t.disqualified, []);
});

test('Sichten: Entwürfe nur für die Orga, Protokoll nur für die Turnierleitung, Spieler sehen ihre Spiele', () => {
  const { t, m, as, of, HttpError } = withPlayers({ log: [{ text: 'Synthetic' }] });
  const anonymous = of.show({}, t);
  assert.equal(anonymous.log, undefined);
  assert.equal(anonymous.referees, undefined);
  assert.deepEqual(anonymous.reportableMatches, []);
  assert.deepEqual(of.show(as('ref'), t).log, [{ text: 'Synthetic' }]);
  const player = of.show(as('a'), t);
  assert.ok(player.reportableMatches.includes(m.id));
  assert.equal(player.mySides[m.id], 'a');
  t.status = 'draft';
  assert.throws(() => of.show(as('a'), t), (err) => err instanceof HttpError && err.status === 404);
  assert.equal(of.show({ admin: true }, t), t);
  assert.deepEqual(of.overview({}).map((x) => x.id), []);
  assert.deepEqual(of.overview({ admin: true }).map((x) => x.id), ['cup']);
});

// Offene Anmeldung (Entwurf) für Einzel- bzw. Teamturniere
function signup(extra = {}, coinBudget = () => 0) {
  const persons = [{ id: 'p1', name: 'Synthetic One', discordId: '100000000000000001' }, { id: 'p2', name: 'Synthetic Two', discordId: '100000000000000002' }];
  const t = { id: 'cup', name: 'Cup', type: 'ko', status: 'draft', signup: true, participants: [], members: {}, playerIds: {}, order: [], results: {}, ...extra };
  const mod = tournamentModule({ db: { persons }, event: { tournaments: [t] }, coinBudget });
  let created = 0;
  const as = (i) => ({ discordId: persons[i].discordId, person: () => { created++; return persons[i]; } });
  return { t, as, created: () => created, ...mod };
}

test('Anmeldung: bindet an die eigene Person, abmelden nur den eigenen Eintrag, geschlossen ohne Personenanlage', () => {
  const { t, as, of, created, saves } = signup();
  of.join(as(0), t);
  assert.deepEqual(t.participants, ['Synthetic One']);
  assert.equal(t.playerIds['Synthetic One'], 'p1');
  assert.equal(of.join(as(0), t).already, true);
  assert.equal(of.leave(as(1), t).notSignedUp, true, 'someone else cannot remove the entry');
  of.leave(as(0), t);
  assert.deepEqual(t.participants, []);
  const before = created();
  t.signup = false;
  assert.throws(() => of.join(as(1), t), (err) => err.code === 'closed');
  assert.equal(created(), before, 'no person is created for a closed signup');
  t.signup = true; t.teamSize = 2;
  assert.throws(() => of.join(as(1), t), (err) => err.code === 'team-tournament');
  assert.equal(saves.length, 2);
});

test('Teams: Gründen prüft vor dem Ändern, Beitreten und Verlassen gleichen Discord ab', () => {
  const { t, as, of, notes } = signup({ teamSize: 2 });
  assert.throws(() => of.foundTeam(as(0), t, 'X'.repeat(61)), /60 Zeichen/);
  assert.deepEqual(t.members, {}, 'rejected team leaves no members behind');
  assert.deepEqual(t.participants, []);
  of.foundTeam(as(0), t, '__proto__');
  assert.deepEqual(Object.keys(t.members), ['__proto__']);
  assert.throws(() => of.foundTeam(as(0), t, 'Other'), (err) => err.code === 'in-team' && err.data.team === '__proto__');
  notes.length = 0;
  of.joinTeam(as(1), t, '__PROTO__');
  assert.deepEqual(t.members.__proto__, ['p1', 'p2']);
  assert.deepEqual(notes.map(([name]) => name), ['changed'], 'joining a team syncs Discord');
  assert.throws(() => of.joinTeam(as(1), t, '__proto__'), (err) => err.code === 'in-team');
  of.leaveTeam(as(1), t);
  assert.deepEqual(t.members.__proto__, ['p1']);
  assert.equal(of.leaveTeam(as(0), t).emptied, true);
  assert.deepEqual(t.participants, []);
  assert.equal(Object.hasOwn(t.members, '__proto__'), false);
});

test('Coins und Teilnehmerlimit werden im Modul geprüft', () => {
  const prize = { id: 'prize', name: 'Prize', status: 'draft', signup: true, participants: [], members: {}, playerIds: {}, coins: 2 };
  const { t, as, of, event } = signup({ coins: 2, maxParticipants: 1 }, () => 3);
  event.tournaments.push(prize);
  of.join(as(0), t);
  assert.throws(() => of.join(as(1), t), (err) => err.code === 'full' && err.data.max === 1);
  assert.throws(() => of.join(as(0), prize), (err) => err.code === 'coins' && err.data.left === 1 && err.data.budget === 3);
  const coins = of.coins({ id: 'p1' });
  assert.deepEqual({ budget: coins.budget, used: coins.used, left: coins.left }, { budget: 3, used: 2, left: 1 });
  of.leave(as(0), t);
  of.join(as(0), prize);
  assert.equal(of.coins({ id: 'p1' }).left, 1, 'leaving returns the coins');
});

test('Personen: Umbenennen folgt nur gebundenen Einzeleinträgen, Zusammenführen übernimmt Einträge und Teams', () => {
  const single = { id: 's', participants: ['Alice', 'Alice2'], playerIds: { Alice: 'a', Alice2: null }, members: {} };
  const typed = { id: 'u', participants: ['Alice'], playerIds: { Alice: null }, members: {} };
  const team = { id: 't', teamSize: 2, participants: ['Team'], playerIds: {}, members: { Team: ['a', 'b'] } };
  const { of, notes } = tournamentModule({ event: { tournaments: [single, typed, team] } });
  of.renamePerson('a', 'Alice', 'Alicia');
  assert.deepEqual(single.participants, ['Alicia', 'Alice2']);
  assert.equal(single.playerIds.Alicia, 'a');
  assert.deepEqual(typed.participants, ['Alice'], 'unbound equal name stays');
  assert.deepEqual(notes, [['entryRenamed', single, 'Alice', 'Alicia']]);
  of.mergePersons('a', 'b');
  assert.equal(single.playerIds.Alicia, 'b');
  assert.deepEqual(team.members.Team, ['b'], 'no duplicate member');
});
