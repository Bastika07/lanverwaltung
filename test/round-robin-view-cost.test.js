'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Bracket = require('../public/bracket.js');
const { isolated } = require('../test-support/isolated.cjs');

test('cachedView: unveränderte Revision nutzt die Berechnung wieder, jede Speicherung erneuert sie', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8').replace(/\r\n/g, '\n').match(/const viewCache = new WeakMap\(\);\nfunction cachedView[\s\S]*?\n\}/);
  assert.ok(source, 'server.js cachedView must exist');
  let calls = 0;
  const sandbox = { WeakMap, revision: 0, Bracket: { compute: (t) => ({ id: t.id, call: ++calls }) } };
  const cachedView = vm.runInNewContext(`${source[0]}\ncachedView`, sandbox);
  const a = { id: 'a' }, b = { id: 'b' };
  assert.equal(cachedView(a), cachedView(a));
  assert.equal(calls, 1);
  cachedView(b);
  assert.equal(calls, 2, 'each tournament has its own entry');
  sandbox.revision++;
  assert.equal(cachedView(a).call, 3, 'save invalidates');
  assert.equal(cachedView(a).call, 3);
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
