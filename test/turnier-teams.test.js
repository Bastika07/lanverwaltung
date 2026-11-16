'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tournamentModule, discordSide } = require('../test-support/tournaments.cjs');
const { testCtx } = require('../test-support/ctx.cjs');

// Teamturnier mit offener Anmeldung und vier synthetischen Personen; p4 hat kein Ticket (mayEnter).
function setup(extra = {}, { coinBudget = () => 0, persons: more = [] } = {}) {
  const persons = [1, 2, 3, 4].map((n) => ({ id: `p${n}`, name: `Synthetic ${n}`, discordId: `10000000000000000${n}` })).concat(more);
  const t = { id: 'cup', name: 'Cup', type: 'ko', status: 'draft', signup: true, teamSize: 3, participants: [], members: {}, playerIds: {}, order: [], results: {}, ...extra };
  const event = { id: 'e', tournaments: [t] };
  // mayEnter wie in server.js; hier hat p4 kein Ticket
  const mod = tournamentModule({ db: { persons }, event, coinBudget, mayEnter: (e, id) => id !== '100000000000000004' });
  const of = mod.of;
  const as = (i) => ({ discordId: persons[i].discordId, person: () => persons[i] });
  return { t, of, as, persons, event, notes: mod.notes, saves: mod.saves };
}

test('Captain: Gründer wird gespeichert, Beitritt nur per Anfrage, Captain entscheidet', () => {
  const { t, of, as, notes } = setup();
  of.foundTeam(as(0), t, 'Alpha');
  assert.deepEqual(t.captains, { Alpha: 'p1' });
  assert.equal(of.requestJoin(as(1), t, 'alpha').team, 'Alpha');
  assert.deepEqual(t.members.Alpha, ['p1']);
  assert.deepEqual(t.requests.map((r) => [r.person, r.team]), [['p2', 'Alpha']]);
  assert.ok(notes.some(([name, , team, p, captain]) => name === 'joinRequested' && team === 'Alpha' && p.id === 'p2' && captain.id === 'p1'), 'captain is notified');
  assert.equal(of.requestJoin(as(1), t, 'Alpha').already, true, 'same request twice');
  of.requestJoin(as(2), t, 'Alpha');
  assert.throws(() => of.answerRequest(as(1), t, 'p3', true), (err) => err.code === 'not-captain', 'requester cannot answer');
  of.answerRequest(as(0), t, 'p2', true);
  of.answerRequest(as(0), t, 'p3', false);
  assert.deepEqual(t.members.Alpha, ['p1', 'p2']);
  assert.deepEqual(t.requests, []);
  assert.ok(notes.some(([name, , , p, ok]) => name === 'joinAnswered' && p.id === 'p3' && ok === false));
  assert.throws(() => of.answerRequest(as(0), t, 'p3', true), (err) => err.code === 'no-request');
});

test('Anfrage: eine je Person, neue ersetzt alte, Gründen zieht sie zurück, Zurückziehen geht', () => {
  const { t, of, as } = setup();
  of.foundTeam(as(0), t, 'Alpha');
  of.foundTeam(as(1), t, 'Beta');
  assert.equal(of.requestJoin(as(2), t, 'Alpha').replaced, null);
  assert.equal(of.requestJoin(as(2), t, 'Beta').replaced, 'Alpha');
  assert.deepEqual(t.requests.map((r) => r.team), ['Beta']);
  assert.equal(of.cancelRequest(as(2), t).team, 'Beta');
  assert.deepEqual(t.requests, []);
  of.requestJoin(as(2), t, 'Alpha');
  of.foundTeam(as(2), t, 'Gamma');
  assert.deepEqual(t.requests, [], 'founding an own team withdraws the request');
});

test('Nur Teilnehmer mit Ticket: Gründen und Anfragen abgelehnt, Annahme prüft erneut', () => {
  const { t, of, as } = setup();
  assert.throws(() => of.foundTeam(as(3), t, 'Delta'), (err) => err.code === 'no-ticket' && err.status === 403);
  of.foundTeam(as(0), t, 'Alpha');
  assert.throws(() => of.requestJoin(as(3), t, 'Alpha'), (err) => err.code === 'no-ticket');
  t.requests = [{ person: 'p4', team: 'Alpha', at: new Date().toISOString() }]; // z. B. Ticket inzwischen storniert
  assert.throws(() => of.answerRequest(as(0), t, 'p4', true), (err) => err.code === 'no-ticket');
  assert.deepEqual(t.members.Alpha, ['p1']);
});

test('Coins: Prüfung bei der Anfrage, Verbrauch erst mit der Bestätigung, Rückgabe beim Auflösen', () => {
  const prize = { id: 'prize', name: 'Prize', status: 'draft', signup: true, participants: ['Solo'], playerIds: { Solo: 'p2' }, members: {}, coins: 2 };
  const { t, of, as, event } = setup({ coins: 2 }, { coinBudget: () => 3 });
  event.tournaments.push(prize);
  of.foundTeam(as(0), t, 'Alpha');
  assert.equal(of.coins({ id: 'p1' }).left, 1, 'founder pays');
  assert.throws(() => of.requestJoin(as(1), t, 'Alpha'), (err) => err.code === 'coins' && /fehlen dir Coins/.test(err.message), 'p2 has only 1 coin left');
  of.requestJoin(as(2), t, 'Alpha');
  assert.equal(of.coins({ id: 'p3' }).left, 3, 'a request costs nothing yet');
  of.answerRequest(as(0), t, 'p3', true);
  assert.equal(of.coins({ id: 'p3' }).left, 1, 'confirmed member pays');
  // Coins inzwischen woanders verbraucht: Bestätigung scheitert
  t.requests = [{ person: 'p2', team: 'Alpha', at: new Date().toISOString() }];
  assert.throws(() => of.answerRequest(as(0), t, 'p2', true), (err) => err.code === 'coins');
  const r = of.leaveTeam(as(0), t);
  assert.equal(r.dissolved, true);
  assert.deepEqual(r.removed, ['p3']);
  assert.deepEqual(t.participants, []);
  assert.deepEqual([t.members, t.captains, t.requests], [{}, {}, []]);
  assert.equal(of.coins({ id: 'p1' }).left, 3);
  assert.equal(of.coins({ id: 'p3' }).left, 3, 'members of a dissolved team get their coins back');
});

test('Captain: Umbenennen, Entfernen und Sperre ab Turnierstart', () => {
  const { t, of, as, notes } = setup({ teamSize: 2 });
  of.foundTeam(as(0), t, 'Alpha');
  of.foundTeam(as(1), t, 'Beta');
  of.requestJoin(as(2), t, 'Alpha');
  notes.length = 0;
  of.renameTeam(as(0), t, '__proto__');
  assert.deepEqual(t.participants, ['__proto__', 'Beta']);
  assert.ok(Object.hasOwn(t.members, '__proto__') && Object.hasOwn(t.captains, '__proto__'));
  assert.equal(t.requests[0].team, '__proto__');
  const [, , renames] = notes.find(([name]) => name === 'changed');
  assert.equal(renames.Alpha, '__proto__', 'Discord channel follows the rename');
  assert.throws(() => of.renameTeam(as(0), t, 'beta'), (err) => err.code === 'team-exists');
  assert.throws(() => of.renameTeam(as(2), t, 'X'), (err) => err.code === 'not-captain');
  of.answerRequest(as(0), t, 'p3', true);
  assert.throws(() => of.removeMember(as(0), t, 'p1'), (err) => err.code === 'captain-self');
  of.removeMember(as(0), t, 'p3');
  assert.deepEqual(t.members.__proto__, ['p1']);
  t.status = 'running';
  assert.throws(() => of.renameTeam(as(0), t, 'Neu'), (err) => err.code === 'started');
  assert.throws(() => of.removeMember(as(1), t, 'p4'), (err) => err.code === 'started');
  assert.throws(() => of.leaveTeam(as(0), t), (err) => err.code === 'closed');
  assert.throws(() => of.dissolveTeam(as(0), t), (err) => err.code === 'closed');
});

test('Orga greift im laufenden Turnier ein: Mitglieder, Captain und Name', () => {
  const { t, of, persons } = setup({ status: 'running', participants: ['Alpha', 'Beta'], order: [0, 1], members: { Alpha: ['p1', 'p2'], Beta: ['p3'] }, teamSize: 2 });
  const admin = { admin: true };
  assert.throws(() => of.teamAdmin({ discordId: persons[0].discordId }, t, { team: 'Alpha', action: 'remove', person: 'p2' }), /Admin/);
  of.teamAdmin(admin, t, { team: 'Alpha', action: 'remove', person: 'p2' });
  assert.throws(() => of.teamAdmin(admin, t, { team: 'Beta', action: 'add', person: 'p1' }), /schon im Team/);
  of.teamAdmin(admin, t, { team: 'Beta', action: 'add', person: 'p4' });
  assert.throws(() => of.teamAdmin(admin, t, { team: 'Beta', action: 'add', person: 'p2' }), /voll/);
  of.teamAdmin(admin, t, { team: 'Beta', action: 'captain', person: 'p4' });
  assert.equal(t.captains.Beta, 'p4');
  of.teamAdmin(admin, t, { team: 'Beta', action: 'rename', name: 'Beta Neu' });
  assert.deepEqual(t.participants, ['Alpha', 'Beta Neu']);
  assert.deepEqual(t.members, { Alpha: ['p1'], 'Beta Neu': ['p3', 'p4'] });
  assert.equal(t.captains['Beta Neu'], 'p4');
  assert.deepEqual(t.order, [0, 1], 'bracket unchanged');
  assert.ok(t.log.some((x) => /entfernt Synthetic 2/.test(x.text)));
  assert.throws(() => of.teamAdmin(admin, t, { team: 'Nope', action: 'add', person: 'p2' }), /nicht gefunden/);
  assert.throws(() => of.teamAdmin(admin, t, { team: 'Alpha', action: 'drop', person: 'p1' }), /Unbekannte Aktion/);
});

// CODING_STANDARDS.md „Erst vollständig prüfen, dann ändern“: jede Ablehnung lässt den gespeicherten Stand unverändert
// (Turnier, Personen, keine Speicherung, keine Discord-Benachrichtigung).
function refusedUnchanged({ t, event, persons, saves, notes }, cases) {
  const state = () => JSON.stringify([event, persons, saves.length, notes.length]);
  for (const [label, run, expected] of cases) {
    const before = state();
    assert.throws(run, typeof expected === 'string' ? (err) => err.code === expected : expected, label);
    assert.equal(state(), before, `${label}: refused, nothing changed`);
  }
  return t;
}

test('Ablehnungen bei Teams ändern nichts: Captain, Anfragen, Gründen, Orga', () => {
  const s = setup({ teamSize: 2 }, { persons: [{ id: 'p5', name: 'Synthetic 5', discordId: '100000000000000005' }] });
  const { t, of, as } = s;
  of.foundTeam(as(0), t, 'Alpha');
  of.requestJoin(as(1), t, 'Alpha');
  of.answerRequest(as(0), t, 'p2', true); // Alpha voll: p1 (Captain), p2
  of.foundTeam(as(2), t, 'Beta'); // Beta: p3 (Captain)
  of.requestJoin(as(4), t, 'Beta'); // offene Anfrage von p5
  const at = new Date().toISOString();
  t.requests.push({ person: 'p4', team: 'Alpha', at }, { person: 'p2', team: 'Beta', at }); // z. B. Altbestand
  const admin = { admin: true };
  refusedUnchanged(s, [
    ['rename by member', () => of.renameTeam(as(1), t, 'X'), 'not-captain'],
    ['remove by member', () => of.removeMember(as(1), t, 'p1'), 'not-captain'],
    ['dissolve without team', () => of.dissolveTeam(as(4), t), 'not-captain'],
    ['answer by member', () => of.answerRequest(as(1), t, 'p5', true), 'not-captain'],
    ['answer request of another team', () => of.answerRequest(as(0), t, 'p5', true), 'no-request'],
    ['accept into full team', () => of.answerRequest(as(0), t, 'p4', true), 'team-full'],
    ['accept member of another team', () => of.answerRequest(as(2), t, 'p2', true), 'in-team'],
    ['captain removes self', () => of.removeMember(as(0), t, 'p1'), 'captain-self'],
    ['remove non-member', () => of.removeMember(as(0), t, 'p3'), 'no-member'],
    ['rename to blank', () => of.renameTeam(as(0), t, '  '), 'team-name'],
    ['rename to existing', () => of.renameTeam(as(0), t, 'beta'), 'team-exists'],
    ['request full team', () => of.requestJoin(as(4), t, 'Alpha'), 'team-full'],
    ['request unknown team', () => of.requestJoin(as(4), t, 'Nope'), 'no-team'],
    ['request while in team', () => of.requestJoin(as(1), t, 'Beta'), 'in-team'],
    ['found existing name', () => of.foundTeam(as(4), t, 'ALPHA'), 'team-exists'],
    ['found while in team', () => of.foundTeam(as(1), t, 'Neu'), 'in-team'],
    ['found blank name', () => of.foundTeam(as(4), t, ' '), 'team-name'],
    ['admin op by visitor', () => of.teamAdmin(as(0), t, { team: 'Alpha', action: 'remove', person: 'p2' }), /Admin/],
    ['admin: unknown team', () => of.teamAdmin(admin, t, { team: 'Nope', action: 'add', person: 'p5' }), /nicht gefunden/],
    ['admin: unknown person', () => of.teamAdmin(admin, t, { team: 'Beta', action: 'add', person: 'p9' }), /Unbekannte Person/],
    ['admin: add member of another team', () => of.teamAdmin(admin, t, { team: 'Beta', action: 'add', person: 'p1' }), /schon im Team/],
    ['admin: add to full team', () => of.teamAdmin(admin, t, { team: 'Alpha', action: 'add', person: 'p5' }), /voll/],
    ['admin: remove non-member', () => of.teamAdmin(admin, t, { team: 'Beta', action: 'remove', person: 'p1' }), /Nicht in diesem Team/],
    ['admin: captain not in team', () => of.teamAdmin(admin, t, { team: 'Beta', action: 'captain', person: 'p1' }), /Mitglied/],
    ['admin: unknown action', () => of.teamAdmin(admin, t, { team: 'Beta', action: 'drop', person: 'p3' }), /Unbekannte Aktion/],
    ['admin: rename to existing', () => of.teamAdmin(admin, t, { team: 'Beta', action: 'rename', name: 'alpha' }), 'team-exists'],
    ['admin: rename to blank', () => of.teamAdmin(admin, t, { team: 'Beta', action: 'rename', name: '' }), 'team-name'],
  ]);
  t.status = 'running';
  refusedUnchanged(s, [
    ['rename after start', () => of.renameTeam(as(0), t, 'Neu'), 'started'],
    ['remove after start', () => of.removeMember(as(0), t, 'p2'), 'started'],
    ['leave after start', () => of.leaveTeam(as(1), t), 'closed'],
    ['dissolve after start', () => of.dissolveTeam(as(0), t), 'closed'],
    ['request after start', () => of.requestJoin(as(4), t, 'Beta'), 'closed'],
    ['found after start', () => of.foundTeam(as(4), t, 'Gamma'), 'closed'],
    ['accept after start', () => of.answerRequest(as(2), t, 'p5', true), 'closed'],
  ]);
});

test('Kontolöschung: nur Turniere vor dem Start, Captain-Team aufgelöst, Anfragen weg', () => {
  const draft = { id: 'd', status: 'draft', signup: true, teamSize: 2, participants: ['Alpha', 'Beta'], playerIds: {}, members: { Alpha: ['p1', 'p2'], Beta: ['p3', 'p1x'] }, captains: { Alpha: 'p1' },
    requests: [{ person: 'p1', team: 'Beta', at: '' }, { person: 'p4', team: 'Alpha', at: '' }] };
  const single = { id: 's', status: 'draft', participants: ['Synthetic 1', 'Synthetic 2'], playerIds: { 'Synthetic 1': 'p1', 'Synthetic 2': 'p2' }, members: {} };
  const running = { id: 'r', status: 'running', teamSize: 2, participants: ['Alpha', 'Beta'], order: [0, 1], results: {}, members: { Alpha: ['p1', 'p2'], Beta: ['p3'] }, playerIds: {} };
  const member = { id: 'm', status: 'draft', teamSize: 2, participants: ['Gamma'], playerIds: {}, members: { Gamma: ['p3', 'p1'] }, captains: { Gamma: 'p3' } };
  const { of, event, notes } = setup();
  event.tournaments = [draft, single, running, member];
  notes.length = 0;
  of.withdrawPerson('p1');
  assert.deepEqual(draft.participants, ['Beta'], 'captain team dissolved');
  assert.deepEqual(draft.members, { Beta: ['p3', 'p1x'] });
  assert.deepEqual(draft.requests, []);
  assert.deepEqual(single.participants, ['Synthetic 2']);
  assert.deepEqual(member.members.Gamma, ['p3'], 'plain member leaves');
  assert.deepEqual(running.members.Alpha, ['p1', 'p2'], 'running tournament keeps the (pseudonymised) entry');
  assert.deepEqual(notes.map(([, t]) => t.id).sort(), ['d', 'm', 's']);
});

test('Ansichten: Anfragen sieht nur der Captain, nie die öffentliche Turnieransicht', () => {
  const { t, of, as, persons } = setup();
  of.foundTeam(as(0), t, 'Alpha');
  of.requestJoin(as(1), t, 'Alpha');
  assert.equal(of.show({}, { ...t, status: 'running', order: [0] }).requests, undefined);
  const captain = of.signupView({ discordId: persons[0].discordId }).tournaments[0];
  assert.deepEqual(captain.team.requests.map((r) => [r.id, r.name]), [['p2', 'Synthetic 2']]);
  assert.equal(captain.team.captain, true);
  const asker = of.signupView({ discordId: persons[1].discordId });
  assert.equal(asker.tournaments[0].request, 'Alpha');
  assert.equal(asker.tournaments[0].team, null);
  assert.deepEqual(asker.tournaments[0].teams, [{ name: 'Alpha', size: 1, captain: 'Synthetic 1', members: ['Synthetic 1'] }]);
  const noTicket = of.signupView({ discordId: persons[3].discordId });
  assert.equal(noTicket.allowed, false);
  assert.deepEqual(noTicket.tournaments[0].teams[0].members, [], 'no member names without ticket');
  assert.equal(JSON.stringify(of.signupView({ discordId: persons[0].discordId })).includes('10000000000000000'), false, 'no Discord IDs');
});

test('Zusammenführen: Captain und Anfragen gehen an die Zielperson', () => {
  const t = { id: 'm', status: 'draft', teamSize: 3, participants: ['A'], playerIds: {}, members: { A: ['x', 'y'] }, captains: { A: 'x' }, requests: [{ person: 'z', team: 'A' }, { person: 'w', team: 'A' }] };
  const { of, event } = setup();
  event.tournaments = [t];
  of.mergePersons('x', 'q');
  assert.equal(t.captains.A, 'q');
  of.mergePersons('z', 'y'); // y ist schon im Team: Anfrage erledigt
  assert.deepEqual(t.requests.map((r) => r.person), ['w']);
});

test('Discord: Teams nennen ihre Mitglieder auch ohne Erwähnungen; Captain bekommt eine Nachricht', async () => {
  const persons = [{ id: 'c', name: 'Carol', discordId: '100000000000000003', discordName: 'carol_dc' }, { id: 'd', name: 'Dave', discordId: null }];
  const t = { id: 't', name: 'Cup', type: 'ko', status: 'running', participants: ['Team A', 'Team B'], order: [0, 1], results: {}, members: { 'Team A': ['c', 'd'], 'Team B': [] } };
  const quiet = discordSide({ event: { tournaments: [t] }, persons, mentionPlayers: false });
  quiet.side.started(t);
  assert.match(quiet.posts[0].text, /\*\*Team A\*\* \(carol_dc, Dave\) vs \*\*Team B\*\*$/m);
  const loud = discordSide({ event: { tournaments: [t] }, persons });
  loud.side.started(t);
  assert.match(loud.posts[0].text, /\*\*Team A\*\* \(<@100000000000000003>, Dave\)/);
  const calls = [];
  const dm = discordSide({ event: { tournaments: [t] }, persons, Discord: { enabled: true, call: async (m, path, body) => { calls.push([m, path, body]); return { id: 'dm1' }; },
    post: async (ch, text) => { calls.push(['post', ch, text]); }, sync: async () => {}, remove: async () => {} } });
  dm.side.joinRequested(t, 'Team A', { name: 'Dave' }, persons[0]);
  dm.side.joinRequested(t, 'Team A', { name: 'Dave' }, persons[1]); // ohne Discord-Konto: keine Nachricht
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls[0], ['POST', '/users/@me/channels', { recipient_id: '100000000000000003' }]);
  assert.match(calls[1][2], /Dave\*\* möchte deinem Team \*\*Team A\*\*/);
  assert.equal(calls.length, 2);
});

// Issue #121: Auch im Discord gilt „nur mit Ticket“ – echtes Commands-Modul über dem echten Turniermodul.
test('Discord /anmelden: ohne Ticket abgelehnt mit eigenem Hinweis, mit Ticket angemeldet', () => {
  const persons = [1, 2].map((n) => ({ id: `p${n}`, name: `Synthetic ${n}`, discordId: `10000000000000000${n}` }));
  const t = { id: 'solo', name: 'Solo', type: 'ko', status: 'draft', signup: true, participants: [], members: {}, playerIds: {}, order: [], results: {} };
  const event = { id: 'e', tournaments: [t] };
  const { tournaments } = tournamentModule({ db: { persons }, event, mayEnter: (e, id) => id !== '100000000000000002' });
  // Turniermodul öffentlich sichtbar: Die Anmeldung muss das Ticket trotzdem prüfen
  const commands = require('../lib/commands.js')(testCtx({ announcements: {}, schedule: {}, participation: { mayView: () => true },
    people: { byDiscord: (id) => persons.find((p) => p.discordId === id) || null }, tournaments, event: { current: () => event } }));
  const anmelden = (id) => commands.find('anmelden').run({ user: { id }, opts: { turnier: 'solo' } });
  assert.throws(() => anmelden('100000000000000002'), /nur Teilnehmer mit Ticket/);
  assert.deepEqual(t.participants, [], 'refused signup changes nothing');
  assert.match(anmelden('100000000000000001'), /Angemeldet bei \*\*Solo\*\* als \*\*Synthetic 1\*\*/);
  assert.deepEqual(t.participants, ['Synthetic 1']);
});
