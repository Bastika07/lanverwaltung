'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Bracket = require('../public/bracket.js');
const { tournamentModule } = require('../test-support/tournaments.cjs');

// Echtes Turniermodul mit Aufrufzähler am Spielplan, echter /jetzt-Befehl.
function setup(t) {
  const names = Array.from({ length: 8 }, (_, i) => `Synthetic ${i}`);
  const tour = { id: 'rr', name: 'Liga', type: 'rr', status: 'running', participants: names, order: names.map((_, i) => i), results: {}, members: {} };
  const mod = tournamentModule({ event: { id: 'e', tournaments: [tour] } });
  const compute = Bracket.compute;
  let calls = 0;
  Bracket.compute = (x) => { calls++; return compute(x); };
  t.after(() => { Bracket.compute = compute; });
  const mods = { tournaments: true };
  const commands = require('../lib/commands')({ Discord: { md: String }, settings: () => ({}), moduleOn: (k) => mods[k], participation: { mayView: () => true },
    tournaments: mod.tournaments, event: { current: () => mod.event }, people: {}, announcements: {}, schedule: {} });
  const jetzt = () => commands.find('jetzt').run({ user: { id: '100000000000000001' }, opts: {} });
  return { tour, mod, compute, jetzt, calls: () => calls };
}

test('/jetzt: unveränderte Turniere werden nicht neu berechnet', (t) => {
  const { jetzt, calls } = setup(t);
  const first = jetzt();
  assert.match(first, /Spieltag 1/);
  assert.equal(calls(), 1, 'running() and the answer share one computation');
  assert.equal(jetzt(), first);
  assert.equal(calls(), 1, 'repeated calls reuse it');
});

test('/jetzt: nach einer Speicherung erscheinen die neuen spielbaren Begegnungen', (t) => {
  const { tour, mod, compute, jetzt, calls } = setup(t);
  const round = compute(tour).rounds[0];
  assert.match(jetzt(), /Spieltag 1/);
  for (const m of round) tour.results[m.id] = { a: 1, b: 0, pa: m.a, pb: m.b };
  mod.save(); // wie jede Speicherung: neue Revision
  const after = jetzt();
  assert.match(after, /Spieltag 2/);
  assert.doesNotMatch(after, /Spieltag 1/);
  assert.equal(calls(), 2);
});
