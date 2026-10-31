'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Access = require('../lib/access');

const mods = Object.fromEntries(['details', 'tournaments', 'announcements', 'schedule', 'info', 'people', 'seating', 'beamer', 'tickets', 'servers'].map((k) => [k, true]));
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

// Echte Module: people, commands und das tournamentApi-Objekt aus server.js (mit neutralen Stubs).
function setup() {
  let body;
  const db = { meta: { securityVersion: 1, settings: { modules: mods } }, persons: [], accounts: [],
    events: [{ id: 'e', name: 'Synthetic', start: null, end: null, active: false, modules: mods, access: {}, sale: {}, info: {},
      attendees: [], orders: [], ticketTypes: [{ id: 'normal', name: 'Normal', participant: true }], tournaments: [], guestServers: [] }],
    seating: { cols: 4, rows: 1, seats: [], categories: [], areas: [] } };
  const ctx = { db, save() {}, broadcast() {}, HttpError, str: (v, n = 100) => String(v || '').trim().slice(0, n),
    settings: () => ({ modules: mods }), Discord: { enabled: false, md: String }, moduleOn: (k) => mods[k],
    requireAdmin() {}, readBody: async () => body, send: (res, status, data) => Object.assign(res, { status, data }) };
  ctx.event = require('../lib/event')(ctx);
  ctx.people = require('../lib/people')(ctx);
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8').match(/const tournamentApi = (\{[\s\S]*?\n\});/);
  assert.ok(source, 'server.js tournamentApi must exist');
  const tournaments = vm.runInNewContext(`(${source[1]})`, { db, Access, cleanParticipants: (names) => names.map(String),
    applyMembers() {}, discordSync() {}, save() {}, broadcast() {}, isFinished: () => false, allTournaments: () => db.tournaments, wantsChannels: () => false });
  const commands = require('../lib/commands')({ ...ctx, tournaments, announcements: {}, schedule: {}, mayViewDiscord: () => true });
  const t = { id: 'cup', name: 'Cup', type: 'ko', status: 'draft', signup: true, teamSize: 1, participants: [], members: {}, playerIds: {}, order: [], results: {} };
  db.tournaments.push(t);
  const run = (name, user, opts) => commands.find(name).run({ user, opts });
  const call = async (method, parts, payload) => {
    const res = {};
    body = payload;
    await ctx.people.routes({ headers: {} }, res, parts, method);
    return res;
  };
  return { db, ctx, t, run, call, event: db.events[0] };
}
const attacker = { id: '100000000000000001', name: 'Alice' };
const bob = { id: '100000000000000002', name: 'Bob' };

test('/abmelden: a self-claimed equal name cannot remove an organizer entry', () => {
  const { t, run, db } = setup();
  t.participants = ['Alice'];
  Access.bindPlayers(db, t);
  assert.equal(t.playerIds.Alice, null, 'organizer typed a name without a person');
  run('ich', attacker, { name: 'Alice' });
  const claimed = db.persons.find((p) => p.discordId === attacker.id);
  assert.equal(claimed.selfClaimed, true);
  assert.match(run('abmelden', attacker, { turnier: 'cup' }), /nicht angemeldet/);
  assert.deepEqual(t.participants, ['Alice']);
});

test('/abmelden: own self-signups can still leave while signup is open, not after start', () => {
  const { t, run } = setup();
  assert.match(run('anmelden', bob, { turnier: 'cup' }), /Angemeldet/);
  assert.deepEqual(t.participants, ['Bob']);
  assert.ok(t.playerIds.Bob, 'self-signup binds the own person id');
  assert.match(run('abmelden', bob, { turnier: 'cup' }), /Abgemeldet/);
  assert.deepEqual(t.participants, []);
  run('anmelden', bob, { turnier: 'cup' });
  t.signup = false;
  assert.throws(() => run('abmelden', bob, { turnier: 'cup' }), /nur, solange die Anmeldung offen ist/);
  t.signup = true;
  t.status = 'running';
  assert.throws(() => run('abmelden', bob, { turnier: 'cup' }), /nur, solange die Anmeldung offen ist/);
  assert.deepEqual(t.participants, ['Bob']);
});

test('binding: self-claimed names never gain result rights; a deliberate organizer approval does', async () => {
  const { db, t, run, call, event } = setup();
  t.participants = ['Alice', 'Carol'];
  Access.bindPlayers(db, t);
  run('ich', attacker, { name: 'Alice' });
  const alice = db.persons.find((p) => p.discordId === attacker.id);
  Access.bindPlayers(db, t, true); // z. B. Turnier erneut gespeichert oder gestartet
  assert.equal(t.playerIds.Alice, null);
  assert.equal(Access.mayReport(db, attacker.id, t, { a: 0, b: 1 }), false);

  // Sammelübernahme per Namensliste bestätigt die beanspruchte Person nicht.
  const bulk = await call('POST', ['people'], { names: ['Alice', 'Carol'] });
  assert.equal(bulk.status, 201);
  assert.deepEqual(bulk.data.map((p) => [p.name, p.approved, p.selfClaimed === true]), [['Alice', false, true], ['Carol', true, false]]);
  assert.equal(Access.isMember(db, attacker.id, event), false);
  Access.bindPlayers(db, t, true);
  assert.equal(t.playerIds.Alice, null);
  assert.equal(t.playerIds.Carol, null, 'a matching name alone never binds');
  const carol = db.persons.find((p) => p.name === 'Carol').id;
  Access.bindPlayers(db, t, true, { Carol: carol });
  assert.equal(t.playerIds.Carol, carol, 'explicit organizer selection binds');

  // Bewusste Freigabe genau dieser Person macht sie geprüft.
  const approve = await call('PUT', ['people', alice.id], { approved: true });
  assert.equal(approve.status, 200);
  assert.equal(alice.selfClaimed, undefined);
  assert.equal(Access.isMember(db, attacker.id, event), true);
  Access.bindPlayers(db, t, true);
  assert.equal(t.playerIds.Alice, null, 'approval alone does not bind a tournament slot');
  Access.bindPlayers(db, t, true, { Alice: alice.id });
  assert.equal(t.playerIds.Alice, alice.id);
  assert.equal(Access.mayReport(db, attacker.id, t, { a: 0, b: 1 }), true);
});

test('binding: explicit person selection confirms; verified persons with other names stay unbound', async () => {
  const { db, t, run, call, event } = setup();
  run('ich', attacker, { name: 'Alice' });
  const alice = db.persons.find((p) => p.discordId === attacker.id);
  const single = await call('POST', ['people'], { name: 'Dora' });
  assert.equal(single.data.approved, true);
  t.participants = ['Dora', 'Dora X', 'Alice'];
  Access.bindPlayers(db, t, true, { Dora: single.data.id });
  assert.equal(t.playerIds.Dora, single.data.id);
  assert.equal(t.playerIds['Dora X'], null, 'no fuzzy or prefix match');
  assert.equal(t.playerIds.Alice, null);
  await call('POST', ['people'], { personIds: [alice.id] });
  assert.equal(alice.selfClaimed, undefined);
  assert.equal(event.attendees.find((a) => a.personId === alice.id).approved, true);
  Access.bindPlayers(db, t, true, { Alice: alice.id });
  assert.equal(t.playerIds.Alice, alice.id);
  db.persons.find((p) => p.id === alice.id).name = 'Alicia';
  Access.bindPlayers(db, t, true);
  assert.equal(t.playerIds.Alice, null, 'renamed persons lose the old name binding on refresh');
});
