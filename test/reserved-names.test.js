'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const Access = require('../lib/access');

const RESERVED = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
const root = path.resolve(__dirname, '..');

// Lokale Discord-REST-Attrappe: Kanäle anlegen, lesen, ändern, löschen.
async function discordMock(t) {
  const channels = new Map(), calls = [];
  let next = 1000;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (b) => { body += b; });
    req.on('end', () => {
      calls.push(`${req.method} ${req.url}`);
      const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
      if (req.method === 'GET' && req.url === '/guilds/synthetic-guild/channels') return json(200, [...channels.values()]);
      if (req.method === 'POST' && req.url === '/guilds/synthetic-guild/channels') {
        const c = { id: String(next++), parent_id: null, ...JSON.parse(body) };
        channels.set(c.id, c);
        return json(200, c);
      }
      const id = (req.url.match(/^\/channels\/(\d+)$/) || [])[1];
      if (id && !channels.has(id)) return json(404, { message: 'Unknown Channel' });
      if (id && req.method === 'PATCH') { Object.assign(channels.get(id), JSON.parse(body)); return json(200, channels.get(id)); }
      if (id && req.method === 'DELETE') { channels.delete(id); res.writeHead(204); return res.end(); }
      return json(404, { message: 'Not available in synthetic Discord' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { base: `http://127.0.0.1:${server.address().port}`, channels, calls };
}

function freshDiscord(base) {
  Object.assign(process.env, { DISCORD_API_BASE: base, DISCORD_BOT_TOKEN: 'synthetic-token', DISCORD_GUILD_ID: 'synthetic-guild' });
  delete require.cache[require.resolve('../lib/discord')];
  return require('../lib/discord');
}

test('Discord sync: reserved participant names keep exactly one managed channel and are removed again', async (t) => {
  const mock = await discordMock(t);
  const Discord = freshDiscord(mock.base);
  const tournament = { id: 'cup', name: 'Cup', discordEnabled: true, participants: [...RESERVED, 'Alice'] };
  await Discord.sync(tournament);
  const voice = () => [...mock.channels.values()].filter((c) => c.type === 2);
  assert.equal(voice().length, RESERVED.length + 1);
  assert.equal(Object.getPrototypeOf(tournament.discord.channels), Object.prototype, 'no prototype change');
  assert.deepEqual(Object.keys(tournament.discord.channels).sort(), [...RESERVED, 'Alice'].sort());
  assert.equal({}.toString, Object.prototype.toString, 'global prototype untouched');

  await Discord.sync(tournament);
  const stored = JSON.parse(JSON.stringify(tournament)); // wie nach Speichern und Neustart
  await Discord.sync(stored);
  assert.equal(voice().length, RESERVED.length + 1, 'repeated sync creates no duplicate channels');
  assert.equal(mock.calls.filter((c) => c.startsWith('POST')).length, RESERVED.length + 2, 'one category plus one channel per participant');

  stored.participants = ['Renamed', ...RESERVED.slice(1), 'Alice'];
  await Discord.sync(stored, Object.assign(Object.create(null), { ['__proto__']: 'Renamed' }));
  assert.equal(voice().length, RESERVED.length + 1);
  assert.ok(Object.hasOwn(stored.discord.channels, 'Renamed'));
  assert.ok(!Object.hasOwn(stored.discord.channels, '__proto__'), 'renamed channel moved to the new name');

  await Discord.remove(stored);
  assert.equal(mock.channels.size, 0, 'all channels and the category are deleted');
});

// Echte /team-Befehle mit tournamentApi und applyMembers aus server.js.
function teamSetup() {
  const mods = { tournaments: true, people: true };
  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const db = { meta: { securityVersion: 1, settings: { modules: mods } }, persons: [], accounts: [],
    events: [{ id: 'e', name: 'Synthetic', active: false, modules: mods, access: {}, sale: {}, info: {}, attendees: [], orders: [], ticketTypes: [], tournaments: [], guestServers: [] }],
    seating: { cols: 1, rows: 1, seats: [], categories: [], areas: [] } };
  const ctx = { db, save() {}, broadcast() {}, HttpError, str: (v, n = 100) => String(v || '').trim().slice(0, n), settings: () => ({ modules: mods }),
    Discord: { enabled: false, md: String }, moduleOn: (k) => mods[k], requireAdmin() {}, readBody: async () => ({}), send() {} };
  ctx.event = require('../lib/event')(ctx);
  ctx.people = require('../lib/people')(ctx);
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const sandbox = { db, Access, cleanParticipants: (n) => n.map(String), discordSync() {}, save() {}, broadcast() {}, isFinished: () => false, allTournaments: () => db.tournaments, wantsChannels: () => false };
  vm.runInNewContext(server.match(/function applyMembers[\s\S]*?\n\}/)[0], sandbox);
  const tournaments = vm.runInNewContext(`(${server.match(/const tournamentApi = (\{[\s\S]*?\n\});/)[1]})`, sandbox);
  const commands = require('../lib/commands')({ ...ctx, tournaments, announcements: {}, schedule: {}, mayViewDiscord: () => true });
  const t = { id: 'teams', name: 'Teams', type: 'ko', status: 'draft', signup: true, teamSize: 2, participants: [], members: {}, order: [], results: {} };
  db.tournaments.push(t);
  return { t, sandbox, team: (sub, user, opts) => commands.find('team').run({ sub, user, opts: { turnier: 'teams', ...opts } }) };
}

test('/team: reserved team names are stored as normal data through found, join, rename and leave', () => {
  const { t, sandbox, team } = teamSetup();
  const users = [1, 2, 3, 4].map((n) => ({ id: `20000000000000000${n}`, name: `Player ${n}` }));
  team('gruenden', users[0], { name: '__proto__' });
  team('gruenden', users[1], { name: 'constructor' });
  team('beitreten', users[2], { team: '__proto__' });
  // Plain Object (Prototyp aus irgendeinem Realm, dessen Prototyp null ist) – kein Array als untergeschobener Prototyp.
  assert.equal(Object.getPrototypeOf(Object.getPrototypeOf(t.members)), null);
  assert.deepEqual(t.participants, ['__proto__', 'constructor']);
  assert.equal(t.members.__proto__ === Object.prototype, false);
  assert.equal(Object.hasOwn(t.members, '__proto__') && t.members['__proto__'].length, 2);
  assert.throws(() => team('beitreten', users[3], { team: '__proto__' }), /schon voll/);
  assert.equal(Object.hasOwn(t.members, 'toString'), false);

  const renames = Object.create(null);
  renames.constructor = 'Builders';
  sandbox.applyMembers(t, ['__proto__', 'Builders'], renames);
  assert.deepEqual(Object.keys(t.members).sort(), ['Builders', '__proto__']);
  sandbox.applyMembers(t, ['__proto__', 'Builders']); // ohne Umbenennungen: Standard-{} darf keine Prototyp-Treffer liefern
  assert.deepEqual(Object.keys(t.members).sort(), ['Builders', '__proto__']);

  t.participants = ['__proto__', 'Builders'];
  assert.match(team('verlassen', users[2], {}), /verlassen/);
  assert.match(team('verlassen', users[0], {}), /war leer/);
  assert.deepEqual(t.participants, ['Builders']);
  assert.equal(Object.hasOwn(t.members, '__proto__'), false);
});

test('browser: team view renders reserved team names with and without members', async () => {
  const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
  const esc = app.split('\n').find((line) => line.startsWith('const esc ='));
  const people = [{ id: 'p1', name: 'Ann' }, { id: 'p2', name: '<b>Ben</b>' }];
  const context = vm.createContext({ on: () => true, api: async () => ({ people }) });
  vm.runInContext(`${esc}\n${app.match(/async function teamsCard[\s\S]*?\n\}/)[0]}`, context);
  const members = JSON.parse('{"__proto__":["p1","p2"]}'); // wie aus der API-Antwort
  const html = await context.teamsCard({ teamSize: 2, participants: ['__proto__', 'constructor', 'toString'], members });
  for (const name of ['__proto__', 'constructor', 'toString']) assert.ok(html.includes(`<strong>${name}</strong>`), name);
  assert.ok(html.includes('Ann 👑, &lt;b&gt;Ben&lt;/b&gt;'));
  assert.equal((html.match(/\(0\/2\)/g) || []).length, 2, 'teams without members render as empty');
});
