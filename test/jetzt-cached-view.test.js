'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Bracket = require('../public/bracket.js');

// tournamentApi und cachedView unverändert aus server.js, echter Bracket mit Aufrufzähler, echter /jetzt-Befehl.
function setup() {
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8').replace(/\r\n/g, '\n');
  const api = server.match(/const tournamentApi = (\{[\s\S]*?\n\});/);
  const cache = server.match(/const viewCache = new WeakMap\(\);\nfunction cachedView[\s\S]*?\n\}/);
  assert.ok(api && cache, 'server.js tournamentApi/cachedView must exist');
  const names = Array.from({ length: 8 }, (_, i) => `Synthetic ${i}`);
  const t = { id: 'rr', name: 'Liga', type: 'rr', status: 'running', participants: names, order: names.map((_, i) => i), results: {}, members: {} };
  const db = { tournaments: [t] };
  let calls = 0;
  const sandbox = { db, WeakMap, revision: 0, Bracket: { ...Bracket, compute: (x) => { calls++; return Bracket.compute(x); } },
    isFinished: () => { throw new Error('read path must not use the uncached isFinished'); } };
  const tournaments = vm.runInNewContext(`${cache[0]}\n(${api[1]})`, sandbox);
  const mods = { tournaments: true };
  const commands = require('../lib/commands')({ Discord: { md: String }, settings: () => ({}), moduleOn: (k) => mods[k], mayViewDiscord: () => true,
    tournaments, people: {}, announcements: {}, schedule: {} });
  const jetzt = () => commands.find('jetzt').run({ user: { id: '100000000000000001' }, opts: {} });
  return { t, sandbox, jetzt, calls: () => calls };
}

test('/jetzt: unveränderte Turniere werden nicht neu berechnet', () => {
  const { jetzt, calls } = setup();
  const first = jetzt();
  assert.match(first, /Spieltag 1/);
  assert.equal(calls(), 1, 'running() and the answer share one computation');
  assert.equal(jetzt(), first);
  assert.equal(calls(), 1, 'repeated calls reuse it');
});

test('/jetzt: nach einer Speicherung erscheinen die neuen spielbaren Begegnungen', () => {
  const { t, sandbox, jetzt, calls } = setup();
  const round = Bracket.compute(t).rounds[0];
  assert.match(jetzt(), /Spieltag 1/);
  for (const m of round) t.results[m.id] = { a: 1, b: 0, pa: m.a, pb: m.b };
  sandbox.revision++; // wie save()
  const after = jetzt();
  assert.match(after, /Spieltag 2/);
  assert.doesNotMatch(after, /Spieltag 1/);
  assert.equal(calls(), 2);
});
