'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Access = require('../lib/access');

const mods = Object.fromEntries(['details', 'tournaments', 'announcements', 'schedule', 'info', 'people', 'seating', 'beamer', 'tickets', 'servers'].map((k) => [k, true]));
const member = { id: '100000000000000001', name: 'Member' };
const stranger = { id: '100000000000000009', name: 'Stranger' };

// Echte Module people/commands; Sichtbarkeitsregel (accessOf, mayViewDiscord) unverändert aus server.js.
function setup(access) {
  const event = { id: 'e', name: 'Synthetic', active: true, modules: mods, access, sale: {}, info: {},
    ticketTypes: [{ id: 'normal', name: 'Normal', participant: true }], tournaments: [], guestServers: [],
    orders: [{ id: 'o', accountId: member.id, status: 'paid', tickets: [{ id: 't', typeId: 'normal', personId: 'member' }] }],
    attendees: [{ personId: 'member', seat: 'seat-a' }, { personId: 'other', seat: 'seat-b' }] };
  const db = { meta: { securityVersion: 1, settings: { modules: mods } }, accounts: [],
    persons: [{ id: 'member', name: 'Member', discordId: member.id }, { id: 'other', name: 'Synthetic Other' }],
    events: [event], seating: { cols: 2, rows: 1, seats: [{ id: 'seat-a', label: 'A1' }, { id: 'seat-b', label: 'B7' }], categories: [], areas: [] } };
  const ctx = { db, save() {}, broadcast() {}, str: (v, n = 100) => String(v || '').trim().slice(0, n),
    settings: () => ({ modules: mods }), Discord: { enabled: false, md: String }, moduleOn: (k) => mods[k] };
  ctx.event = require('../lib/event')(ctx);
  ctx.people = require('../lib/people')(ctx);
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const accessOf = server.match(/^const accessOf = [^\n]+$/m);
  const mayView = server.match(/^ {2}mayViewDiscord: ([^\n]+),$/m);
  assert.ok(accessOf && mayView, 'server.js visibility rule must exist');
  const mayViewDiscord = vm.runInNewContext(`${accessOf[0]}\n(${mayView[1]})`, {
    modules: { event: { current: () => event } }, isMemberId: (id, e) => Access.isMember(db, id, e) });
  const commands = require('../lib/commands')({ ...ctx, tournaments: {}, announcements: {}, schedule: {}, mayViewDiscord });
  const platz = commands.find('platz');
  return {
    run: (user, name) => { try { return platz.run({ user, opts: name ? { name } : {} }); } catch (e) { return `Fehler: ${e.message}`; } },
    complete: (user, focused) => platz.autocomplete({ user, focused }),
  };
}

test('/platz: gesperrte Teilnehmerliste verbirgt Namen und Plätze trotz öffentlichem Sitzplan', () => {
  const { run, complete } = setup({ people: 'tickets', seating: 'public' });
  const answer = run(stranger, 'Synthetic Other');
  assert.match(answer, /nur für Teilnehmer mit Ticket/);
  assert.doesNotMatch(answer, /Synthetic Other|B7/);
  assert.deepEqual(complete(stranger, 'Syn'), []);
  // Mitglieder dürfen beide Module sehen
  assert.match(run(member, 'Synthetic Other'), /Synthetic Other\*\* sitzt auf Platz \*\*B7/);
  assert.ok(complete(member, 'Syn').some((x) => x.value === 'Synthetic Other'));
});

test('/platz: gesperrter Sitzplan bleibt trotz öffentlicher Teilnehmerliste gesperrt', () => {
  const { run, complete } = setup({ people: 'public', seating: 'tickets' });
  assert.match(run(stranger, 'Synthetic Other'), /nur für Teilnehmer mit Ticket/);
  assert.deepEqual(complete(stranger, 'Syn'), []);
});

test('/platz: sind beide Module öffentlich, funktionieren eigene und fremde Abfragen wie bisher', () => {
  const { run, complete } = setup({ people: 'public', seating: 'public' });
  assert.match(run(stranger, 'Synthetic Other'), /sitzt auf Platz \*\*B7/);
  assert.ok(complete(stranger, 'Syn').some((x) => x.value === 'Synthetic Other'));
  assert.match(run(member), /Member\*\* sitzt auf Platz \*\*A1/);
  assert.match(run(stranger), /noch nicht verknüpft/);
});
