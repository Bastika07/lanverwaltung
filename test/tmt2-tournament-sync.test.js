'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isolated } = require('../test-support/isolated.cjs');
const { fakeTmt, TMT_TOKEN } = require('../test-support/fake-tmt2.cjs');
const { createAgent } = require('../agent/tmt2-agent.js');
const Bracket = require('../public/bracket.js');

const AGENT_TOKEN = 'c'.repeat(40);
const quiet = { log() {}, error() {} };
const cupData = () => ({ id: 'cup', name: 'Cup', type: 'ko', status: 'running', participants: ['Alpha', 'Bravo', 'Charlie', 'Delta'], order: [0, 1, 2, 3],
  results: {}, members: {}, discordEnabled: false, cs2: { format: 'bo1', finalFormat: 'bo3' } });
const withCup = (extra) => (data) => {
  const e = data.events.find((x) => x.id === 'first');
  e.modules = { ...e.modules, cs2: true };
  e.tournaments.push(cupData());
  if (extra) extra(e);
};
const start = (t, prepare) => isolated(t, { prepare, env: { TMT2_AGENT_TOKEN: AGENT_TOKEN } });
const agentFor = (app, tmt) => createAgent({ lanUrl: app.base, agentToken: AGENT_TOKEN, tmtUrl: tmt.url, tmtToken: TMT_TOKEN, log: quiet });
const cs2 = async (app) => (await app.request('/api/cs2', { admin: true })).data;
const posts = (tmt) => tmt.calls.filter((x) => x.method === 'POST');
const finish = (m, a, b) => Object.assign(m, { state: 'FINISHED', matchMaps: [{ name: 'de_nuke', state: 'FINISHED', score: { teamA: a, teamB: b } }] });

test('CS2-Turnier: spielbereite Paarungen kommen automatisch zu TMT2, ohne Doppelte, Finale im eigenen Format', async (t) => {
  const tmt = await fakeTmt(t);
  const app = await start(t, withCup());
  const agent = agentFor(app, tmt);

  assert.ok(!(await cs2(app)).candidates.some((c) => c.tournamentId === 'cup'), 'Turniere mit Abgleich stehen nicht in der Handauswahl');
  await agent.cycle();
  assert.deepEqual(posts(tmt).map((x) => [x.body.teamA.name, x.body.teamB.name]).sort(), [['Alpha', 'Delta'], ['Bravo', 'Charlie']]);
  assert.ok(posts(tmt).every((x) => x.body.electionSteps.at(-1).map.mode === 'RANDOM_PICK' && x.body.electionSteps.filter((s) => s.map.mode === 'PICK').length === 0), 'BO1 ohne Picks');
  await agent.cycle();
  await agent.cycle();
  assert.equal(posts(tmt).length, 2, 'jede Paarung genau einmal');
  let d = await cs2(app);
  assert.deepEqual(d.matches.map((m) => [m.auto, m.format, m.state]), [[true, 'bo1', 'ELECTION'], [true, 'bo1', 'ELECTION']]);

  // Beide Halbfinals enden: Team A gewinnt jeweils. Danach entsteht das Finale als BO3.
  for (const m of tmt.matches.values()) finish(m, 13, 5);
  await agent.cycle();
  await agent.cycle();
  d = await cs2(app);
  const final = d.matches.find((m) => m.label === 'Finale');
  assert.ok(final, 'das Finale wird angelegt, sobald es spielbereit ist');
  assert.deepEqual([final.format, final.teamA, final.teamB, final.state], ['bo3', 'Alpha', 'Bravo', 'ELECTION']);
  assert.equal(posts(tmt).at(-1).body.electionSteps.filter((s) => s.map.mode === 'PICK').length, 2);
  assert.equal(d.matches.filter((m) => m.reported).length, 2);

  // Korrektur eines Halbfinals ändert die Finalpaarung: altes Finale wird in TMT2 beendet, ein neues angelegt
  const tour = (await app.request('/api/tournaments/cup', { admin: true })).data;
  const semi = Bracket.compute(tour).matches.find((m) => m.status === 'done' && m.a === 1);
  assert.equal((await app.request(`/api/tournaments/cup/matches/${semi.id}`, { method: 'POST', admin: true, body: { a: 0, b: 1 } })).status, 200);
  await agent.cycle();
  assert.equal(tmt.matches.get(final.tmtId).isStopped, true, 'das überholte Finale wird in TMT2 beendet');
  d = await cs2(app);
  const finals = d.matches.filter((m) => m.label === 'Finale');
  assert.deepEqual(finals.map((m) => [m.teamA, m.teamB, m.state]), [['Alpha', 'Charlie', 'ELECTION']]);
  await agent.cycle();
  assert.equal((await cs2(app)).matches.length, 3, 'keine weiteren Matches');

  // Ungültige Einstellung ändert nichts; Abschalten lässt das laufende Match weiterlaufen
  const bad = await app.request('/api/tournaments/cup', { method: 'PUT', admin: true, body: { name: 'Umbenannt', cs2: { format: 'bo7' } } });
  assert.equal(bad.status, 400);
  assert.equal((await app.request('/api/tournaments/cup', { admin: true })).data.name, 'Cup');
  assert.equal((await app.request('/api/tournaments/cup', { method: 'PUT', admin: true, body: { cs2: null } })).status, 200);
  await agent.cycle();
  d = await cs2(app);
  assert.deepEqual(d.matches.filter((m) => m.label === 'Finale').map((m) => m.state), ['ELECTION']);
  assert.ok(d.candidates.some((c) => c.tournamentId === 'cup') === false, 'die laufende Paarung wird nicht noch einmal angeboten');
});

test('CS2-Turnier: nach einem Neustart vorhandene Matches zählen, Einstellungen werden geprüft und kopiert', async (t) => {
  const tmt = await fakeTmt(t);
  const semi = Bracket.playable(Bracket.compute(cupData()))[0];
  const app = await start(t, withCup((e) => {
    e.cs2 = { mapPool: ['de_nuke', 'de_mirage', 'de_inferno'], stops: [], matches: [{ id: 'persisted', tmtId: 'tmt-old', format: 'bo1', mapPool: ['de_nuke'], state: 'ELECTION',
      maps: [], wonA: 0, wonB: 0, reported: false, note: '', auto: true, tournamentId: 'cup', matchId: semi.id, pa: semi.a, pb: semi.b, label: semi.label,
      teamA: 'Alpha', teamB: 'Delta', createdAt: new Date().toISOString(), updatedAt: null }] };
  }));
  tmt.matches.set('tmt-old', { id: 'tmt-old', passthrough: 'persisted', state: 'ELECTION', isStopped: false, matchMaps: [] });
  await agentFor(app, tmt).cycle();
  assert.equal(posts(tmt).length, 1, 'nur die Paarung ohne Match wird angelegt');
  assert.equal(posts(tmt)[0].body.teamA.name, 'Bravo');

  const bad = await app.request('/api/tournaments', { method: 'POST', admin: true, body: { name: 'X', participants: ['a', 'b'], cs2: { format: 'bo2' } } });
  assert.equal(bad.status, 400);
  assert.equal((await app.request('/api/tournaments', { method: 'POST', admin: true, body: { name: 'Y', participants: ['a', 'b'], cs2: 'ja' } })).status, 400);
  const ok = await app.request('/api/tournaments', { method: 'POST', admin: true, body: { name: 'Z', participants: ['a', 'b'], cs2: { format: 'bo3' } } });
  assert.equal(ok.status, 201, ok.text);
  assert.deepEqual(ok.data.cs2, { format: 'bo3', finalFormat: 'bo3' });
  const copy = await app.request(`/api/tournaments/${ok.data.id}/duplicate`, { method: 'POST', admin: true });
  assert.deepEqual(copy.data.cs2, { format: 'bo3', finalFormat: 'bo3' });
  assert.equal((await app.request('/api/tournaments', { method: 'POST', admin: true, body: { name: 'W', participants: ['a', 'b'] } })).data.cs2, null);
});

test('CS2-Turnier: zu kleiner Mappool wird als Fehler angezeigt, ausgeschaltetes Modul legt nichts an', async (t) => {
  const tmt = await fakeTmt(t);
  const app = await start(t, withCup((e) => { e.cs2 = { mapPool: ['de_nuke', 'de_mirage'], matches: [], stops: [] }; e.tournaments.at(-1).cs2 = { format: 'bo3', finalFormat: 'bo3' }; }));
  await agentFor(app, tmt).cycle();
  assert.equal(posts(tmt).length, 0);
  const d = await cs2(app);
  assert.deepEqual(d.matches.map((m) => [m.state, /mindestens 3 Maps/.test(m.note)]), [['ERROR', true], ['ERROR', true]]);

  const off = await start(t, withCup((e) => { e.modules = { ...e.modules, cs2: false }; }));
  await agentFor(off, tmt).cycle();
  assert.equal(posts(tmt).length, 0, 'ohne eingeschaltetes Modul kein Abgleich');
});

test('CS2-Turnier: Bo1 trägt den Rundenstand ein, Bo3 die gewonnenen Maps mit Rundenständen je Map', async (t) => {
  const tmt = await fakeTmt(t);
  const app = await start(t, withCup());
  const agent = agentFor(app, tmt);
  await agent.cycle();
  const [first, second] = [...tmt.matches.values()];
  finish(first, 13, 9);
  finish(second, 7, 13);
  await agent.cycle();
  await agent.cycle(); // Finale anlegen
  let tour = (await app.request('/api/tournaments/cup', { admin: true })).data;
  const semis = Object.values(tour.results);
  assert.deepEqual(semis.map((r) => [r.a, r.b, r.maps]).sort(), [[13, 9, [{ name: 'de_nuke', a: 13, b: 9 }]], [7, 13, [{ name: 'de_nuke', a: 7, b: 13 }]]].sort());

  // Bo3-Finale: Team A gewinnt 2:1 Maps, obwohl Team B mehr Runden hat – maßgeblich sind die Maps
  const final = [...tmt.matches.values()].find((m) => !m.isStopped && m.matchMaps.length === 0);
  Object.assign(final, { state: 'FINISHED', matchMaps: [
    { name: 'de_nuke', state: 'FINISHED', score: { teamA: 13, teamB: 11 } },
    { name: 'de_mirage', state: 'FINISHED', score: { teamA: 0, teamB: 13 } },
    { name: 'de_inferno', state: 'FINISHED', score: { teamA: 13, teamB: 11 } }] });
  await agent.cycle();
  tour = (await app.request('/api/tournaments/cup', { admin: true })).data;
  const view = Bracket.compute(tour);
  const fm = view.matches.find((m) => m.label === 'Finale');
  assert.deepEqual([fm.score, fm.winner], [{ a: 2, b: 1 }, fm.a]);
  assert.deepEqual(fm.maps.map((m) => `${m.name} ${m.a}:${m.b}`), ['de_nuke 13:11', 'de_mirage 0:13', 'de_inferno 13:11']);
  assert.equal(view.finished, true, 'das Turnier ist entschieden');
  // Öffentliche Ansicht zeigt die Rundenstände mit
  const pub = (await app.request('/api/tournaments/cup')).data;
  assert.ok(Object.values(pub.results).some((r) => Array.isArray(r.maps) && r.maps.length === 3));
});

test('CS2-Turnier: Unentschieden wartet auf ein Ergebnis von Hand, danach wird das TMT2-Match beendet', async (t) => {
  const tmt = await fakeTmt(t);
  const app = await start(t, withCup());
  const agent = agentFor(app, tmt);
  await agent.cycle();
  const [first, second] = [...tmt.matches.values()];
  finish(first, 12, 12); // ohne Verlängerung möglich
  finish(second, 13, 4);
  await agent.cycle();
  let d = await cs2(app);
  const draw = d.matches.find((m) => m.tmtId === first.id);
  assert.deepEqual([draw.state, draw.reported, /Kein eindeutiger Sieger/.test(draw.note)], ['FINISHED', false, true]);
  // TMT2 lädt die Map nach dem Unentschieden neu und hält den Server; ohne Ergebnis bleibt alles stehen
  Object.assign(first, { state: 'MATCH_MAP', matchMaps: [{ name: 'de_nuke', state: 'WARMUP', score: { teamA: 0, teamB: 0 } }] });
  await agent.cycle();
  assert.equal(first.isStopped, false);
  assert.equal((await cs2(app)).matches.find((m) => m.id === draw.id).state, 'FINISHED', 'der neue Stand überschreibt das Unentschieden nicht');

  const names = cupData().participants;
  const bm = Bracket.playable(Bracket.compute(cupData())).find((x) => names[x.a] === draw.teamA);
  const r = await app.request(`/api/tournaments/cup/matches/${bm.id}`, { method: 'POST', admin: true, body: { a: 13, b: 12 } });
  assert.equal(r.status, 200, r.text);
  await agent.cycle(); // beendet das TMT2-Match und legt das Finale an
  assert.equal(first.isStopped, true, 'Gameserver wird freigegeben');
  d = await cs2(app);
  assert.equal(d.matches.some((m) => m.id === draw.id), false);
  assert.ok(d.matches.some((m) => m.label === 'Finale' && m.state === 'ELECTION'));
});

test('CS2-Turnier: wegen belegtem Gameserver als Fehler markierte Matches werden wieder angelegt', async (t) => {
  const tmt = await fakeTmt(t);
  const semi = Bracket.playable(Bracket.compute(cupData()))[0];
  const app = await start(t, withCup((e) => {
    e.cs2 = { mapPool: ['de_nuke', 'de_mirage', 'de_inferno'], stops: [], matches: [{ id: 'held', tmtId: null, format: 'bo1', mapPool: ['de_nuke'], state: 'ERROR',
      maps: [], wonA: 0, wonB: 0, reported: false, note: 'TMT2: 500: game server already in use by abc', auto: true, tournamentId: 'cup', matchId: semi.id,
      pa: semi.a, pb: semi.b, label: semi.label, teamA: 'Alpha', teamB: 'Delta', createdAt: new Date().toISOString(), updatedAt: null }] };
  }));
  await agentFor(app, tmt).cycle();
  const m = (await cs2(app)).matches.find((x) => x.id === 'held');
  assert.equal(m.state, 'ELECTION');
  assert.equal(posts(tmt).filter((x) => x.body.teamA.name === 'Alpha').length, 1);
});
