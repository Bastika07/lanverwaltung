'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Bracket = require('../public/bracket.js');
const { isolated } = require('../test-support/isolated.cjs');
const { tournamentModule } = require('../test-support/tournaments.cjs');

test('Spielplan-Ansicht: unveränderte Revision nutzt die Berechnung wieder, jede Speicherung erneuert sie', (t) => {
  const compute = Bracket.compute;
  let calls = 0;
  Bracket.compute = (x) => ({ id: x.id, call: ++calls });
  t.after(() => { Bracket.compute = compute; });
  const { of, save } = tournamentModule();
  const a = { id: 'a' }, b = { id: 'b' };
  assert.equal(of.view(a), of.view(a));
  assert.equal(calls, 1);
  of.view(b);
  assert.equal(calls, 2, 'each tournament has its own entry');
  save(); // irgendeine Speicherung
  assert.equal(of.view(a).call, 3, 'save invalidates');
  assert.equal(of.view(a).call, 3);
});

// Rundenturnier in den synthetischen Daten; „buyer“ ist an Platz 0 gebunden.
const roundRobin = (id, names, done) => (data) => {
  const t = { id, name: id, type: 'rr', status: 'running', participants: names, order: names.map((_, i) => i), results: {}, members: {},
    playerIds: Object.fromEntries(names.map((n) => [n, n === 'buyer' ? 'buyer' : null])), discordEnabled: false };
  for (const m of Bracket.compute(t).matches.slice(0, done)) t.results[m.id] = { a: 2, b: 1, pa: m.a, pb: m.b };
  data.events[0].tournaments.push(t);
};

test('öffentliche Ansicht bleibt nach Ergebnissen aktuell (echter Speicherpfad)', async (t) => {
  const app = await isolated(t, { prepare: roundRobin('small', ['buyer', 'Synthetic B', 'Synthetic C'], 2) });
  const summary = async () => (await app.request('/api/tournaments')).data.find((x) => x.id === 'small');
  assert.equal((await summary()).finished, false);
  const mine = await app.request('/api/tournaments/small', { user: 'buyer' });
  assert.equal(mine.data.reportableMatches.length, 2, 'buyer plays two matches');
  assert.deepEqual((await app.request('/api/tournaments/small')).data.reportableMatches, [], 'anonymous');

  const open = Bracket.compute(app.snapshot().events[0].tournaments.find((x) => x.id === 'small')).matches.find((m) => m.status === 'ready');
  const report = await app.request(`/api/tournaments/small/matches/${open.id}`, { method: 'POST', admin: true, body: { a: 0, b: 3 } });
  assert.equal(report.status, 200, JSON.stringify(report.data));
  const after = await summary();
  assert.equal(after.finished, true, 'result invalidates the cached view');
  assert.equal(typeof after.champion, 'string');
});

test('größtes zulässiges Rundenturnier: wiederholte Abrufe bleiben schnell', async (t) => {
  const names = ['buyer', ...Array.from({ length: 255 }, (_, i) => `Synthetic ${i}`)];
  const app = await isolated(t, { prepare: roundRobin('big', names, 16000) });
  const timed = async (url, user) => {
    const ms = [];
    let last;
    for (let i = 0; i < 15; i++) { const s = process.hrtime.bigint(); last = await app.request(url, { user }); ms.push(Number(process.hrtime.bigint() - s) / 1e6); }
    assert.equal(last.status, 200);
    ms.sort((x, y) => x - y);
    return { last, first: ms.at(-1), median: ms[7] };
  };
  const member = await timed('/api/tournaments/big', 'buyer');
  assert.equal(member.last.data.reportableMatches.length, 255, 'one match against each other participant');
  const anonymous = await timed('/api/tournaments/big');
  const list = await timed('/api/tournaments');
  for (const [label, r] of Object.entries({ member, anonymous, list })) {
    t.diagnostic(`${label}: max ${r.first.toFixed(1)} ms, median ${r.median.toFixed(1)} ms`);
    assert.ok(r.median < 250, `${label} median ${r.median} ms`);
  }
});
