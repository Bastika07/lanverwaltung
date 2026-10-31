'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const mods = Object.fromEntries(['tournaments', 'people', 'seating'].map((k) => [k, true]));

// Echtes people-Modul und playerIds/pings unverändert aus server.js.
function setup() {
  const event = { id: 'e', name: 'Synthetic', active: true, modules: mods, access: {}, sale: {}, info: {}, ticketTypes: [], orders: [], tournaments: [], guestServers: [],
    attendees: ['claimer', 'bob', 'carol', 'dave'].map((personId) => ({ personId, seat: null })) };
  const db = { meta: { settings: { modules: mods } }, accounts: [], events: [event], seating: { cols: 1, rows: 1, seats: [], categories: [], areas: [] },
    persons: [{ id: 'claimer', name: 'Alice', discordId: '100000000000000001', selfClaimed: true }, { id: 'bob', name: 'Bob', discordId: '100000000000000002' },
      { id: 'carol', name: 'Carol', discordId: '100000000000000003' }, { id: 'dave', name: 'Dave', discordId: '100000000000000004' }] };
  const ctx = { db, save() {}, broadcast() {}, str: (v, n = 100) => String(v || '').trim().slice(0, n), settings: () => ({ modules: mods }),
    Discord: { enabled: false, md: String }, moduleOn: (k) => mods[k] };
  ctx.event = require('../lib/event')(ctx);
  const people = require('../lib/people')(ctx);
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8').replace(/\r\n/g, '\n');
  const source = server.match(/\nfunction playerIds[\s\S]*?\n\}\n\nfunction pings[\s\S]*?\n\}/);
  assert.ok(source, 'server.js playerIds/pings must exist');
  return vm.runInNewContext(`${source[0]}\n({ playerIds, pings })`, {
    settings: () => ({ mentionPlayers: true }), moduleOn: (k) => mods[k], modules: { people } });
}

test('Erwähnungen: nur namensgleiche, selbst angelegte Person wird nicht angepingt', () => {
  const { playerIds, pings } = setup();
  const t = { participants: ['Alice', 'Bob'], playerIds: { Alice: null, Bob: 'bob' }, members: {} };
  assert.deepEqual([...playerIds(t, 0)], []);
  assert.equal(pings(t, 0), '');
  assert.deepEqual([...playerIds(t, 1)], ['100000000000000002']);
  assert.equal(pings(t, 1), ' (<@100000000000000002>)');
});

test('Erwähnungen: Teams weiter über ihre Mitglieder, ohne Bindung niemand', () => {
  const { playerIds } = setup();
  const team = { participants: ['Team Synthetic', 'Alice'], members: { 'Team Synthetic': ['carol', 'dave'] }, playerIds: {} };
  assert.deepEqual([...playerIds(team, 0)], ['100000000000000003', '100000000000000004']);
  assert.deepEqual([...playerIds(team, 1)], [], 'unbound name');
  assert.deepEqual([...playerIds({ participants: ['__proto__'], members: {} }, 0)], [], 'reserved name without binding');
});
