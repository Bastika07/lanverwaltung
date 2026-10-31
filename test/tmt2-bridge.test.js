'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { isolated } = require('../test-support/isolated.cjs');

const TOKEN = 'synthetic-tmt2-token';

// Lokale TMT2-Attrappe: merkt sich alle Anfragen und antwortet wie die TMT2-API (nur die genutzten Pfade).
async function fakeTmt(t) {
  const calls = [];
  const matches = new Map();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(value === undefined ? '' : JSON.stringify(value)); };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { message: 'unauthorized' });
      const id = decodeURIComponent(req.url.split('/')[3] || '');
      if (req.method === 'POST' && req.url === '/api/matches') {
        if (body.teamA.name === 'busy') return reply(400, { message: 'no free game server <b>available</b>' });
        const m = { id: `tmt-${matches.size + 1}`, state: 'ELECTION', isStopped: false, matchMaps: [], ...body };
        matches.set(m.id, m);
        return reply(201, m);
      }
      if (req.method === 'GET' && matches.has(id)) return reply(200, matches.get(id));
      if (req.method === 'DELETE' && matches.has(id)) { matches.get(id).isStopped = true; return reply(200); }
      return reply(404, { message: 'not found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return { calls, matches, url: `http://127.0.0.1:${server.address().port}` };
}

const enable = (data) => { const e = data.events.find((x) => x.id === 'first'); e.modules = { ...e.modules, cs2: true }; };
const hook = (app, id, secret, body) => fetch(`${app.base}/api/cs2/webhook/${id}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(body),
});

test('CS2/TMT2: match from a tournament pairing, webhook result lands in the bracket exactly once', async (t) => {
  const tmt = await fakeTmt(t);
  const app = await isolated(t, { prepare: enable, env: { TMT2_URL: tmt.url, TMT2_TOKEN: TOKEN, TMT2_WEBHOOK_URL: 'http://lan.invalid', TMT2_PUBLIC_URL: 'http://tmt.invalid' } });

  assert.equal((await app.request('/api/cs2', { user: 'buyer' })).status, 401, 'participants never see the admin bridge');
  const start = await app.request('/api/cs2', { admin: true });
  assert.equal(start.status, 200);
  assert.equal(start.data.configured, true);
  assert.equal(start.data.candidates.length, 1);
  const c = start.data.candidates[0];
  assert.deepEqual([c.tournamentId, c.teamA, c.teamB], ['match', 'buyer', 'other']);

  const created = await app.request('/api/cs2/matches', { method: 'POST', admin: true, body: { tournamentId: c.tournamentId, matchId: c.matchId, format: 'bo3' } });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.data.link, 'http://tmt.invalid/matches/tmt-1');
  const sent = tmt.calls.find((x) => x.method === 'POST');
  assert.equal(sent.auth, `Bearer ${TOKEN}`);
  assert.equal(sent.body.gameServer, null, 'game servers and RCON passwords stay in TMT2');
  assert.deepEqual([sent.body.teamA.name, sent.body.teamB.name, sent.body.passthrough], ['buyer', 'other', created.data.id]);
  assert.equal(sent.body.webhookUrl, `http://lan.invalid/api/cs2/webhook/${created.data.id}`);
  assert.equal(sent.body.electionSteps.length, sent.body.mapPool.length);
  const secret = sent.body.webhookHeaders.Authorization.slice(7);
  assert.match(secret, /^[0-9a-f]{64}$/);

  const list = await app.request('/api/cs2', { admin: true });
  assert.equal(list.data.candidates.length, 0, 'a pairing with an open match is not offered twice');
  assert.doesNotMatch(list.text, new RegExp(`${TOKEN}|${secret}|hookHash`), 'neither the TMT2 token nor the webhook secret leave the server');
  assert.doesNotMatch(JSON.stringify(app.snapshot()), new RegExp(`${TOKEN}|${secret}`), 'only a hash of the webhook secret is stored');
  const again = await app.request('/api/cs2/matches', { method: 'POST', admin: true, body: { tournamentId: c.tournamentId, matchId: c.matchId } });
  assert.equal(again.status, 400);

  // Fremde oder falsche Webhooks ändern nichts
  assert.equal((await hook(app, created.data.id, 'f'.repeat(64), { type: 'MATCH_END', wonMapsTeamA: 0, wonMapsTeamB: 2 })).status, 403);
  assert.equal((await hook(app, created.data.id, null, { type: 'MATCH_END' })).status, 403);
  assert.equal((await hook(app, 'unknown', secret, { type: 'MATCH_END' })).status, 403);
  assert.match(app.logs(), /"cs2_webhook_rejected"/);

  assert.equal((await hook(app, created.data.id, secret, { type: 'MAP_ELECTION_END', matchId: 'tmt-1', mapNames: ['de_nuke', 'de_mirage', 'de_train'] })).status, 200);
  assert.equal((await hook(app, created.data.id, secret, { type: 'MAP_END', matchId: 'tmt-1', mapIndex: 0, mapName: 'de_nuke', scoreTeamA: 13, scoreTeamB: 8 })).status, 200);
  let m = (await app.request('/api/cs2', { admin: true })).data.matches[0];
  assert.deepEqual([m.state, m.wonA, m.wonB, m.maps.length], ['MATCH_MAP', 1, 0, 3]);
  assert.equal((await hook(app, created.data.id, secret, { type: 'MATCH_END', matchId: 'tmt-1', wonMapsTeamA: 2, wonMapsTeamB: 1,
    mapResults: [{ mapName: 'de_nuke', scoreTeamA: 13, scoreTeamB: 8 }, { mapName: 'de_mirage', scoreTeamA: 9, scoreTeamB: 13 }, { mapName: 'de_train', scoreTeamA: 13, scoreTeamB: 11 }] })).status, 200);

  m = (await app.request('/api/cs2', { admin: true })).data.matches[0];
  assert.deepEqual([m.state, m.wonA, m.wonB, m.reported, m.note], ['FINISHED', 2, 1, true, '']);
  const tour = (await app.request('/api/tournaments/match', { admin: true })).data;
  assert.deepEqual(Object.values(tour.results).map((r) => [r.a, r.b, r.pa, r.pb]), [[2, 1, 0, 1]]);

  // Ein späterer, abweichender Webhook überschreibt das Turnierergebnis nicht
  await hook(app, created.data.id, secret, { type: 'MATCH_END', matchId: 'tmt-1', wonMapsTeamA: 0, wonMapsTeamB: 2 });
  assert.deepEqual(Object.values((await app.request('/api/tournaments/match', { admin: true })).data.results).map((r) => [r.a, r.b]), [[2, 1]]);

  assert.equal((await app.request(`/api/cs2/matches/${created.data.id}`, { method: 'DELETE', admin: true })).status, 200);
  assert.ok(tmt.calls.some((x) => x.method === 'DELETE' && x.url === '/api/matches/tmt-1'));
  assert.equal((await app.request('/api/cs2', { admin: true })).data.matches.length, 0);
  assert.equal(Object.keys((await app.request('/api/tournaments/match', { admin: true })).data.results).length, 1, 'the reported result stays');
  assert.match(app.logs(), /"cs2_match_created"/);
});

test('CS2/TMT2: free match, sync from TMT2, validation and TMT2 errors', async (t) => {
  const tmt = await fakeTmt(t);
  const app = await isolated(t, { prepare: enable, env: { TMT2_URL: tmt.url, TMT2_TOKEN: TOKEN } });

  assert.equal((await app.request('/api/cs2/config', { method: 'PUT', admin: true, body: { mapPool: ['de_nuke', 'x y<script>'] } })).status, 400);
  assert.equal((await app.request('/api/cs2/config', { method: 'PUT', admin: true, body: { mapPool: ['de_nuke', 'de_mirage', '3070923343/fy_pool_day'] } })).status, 200);
  const tooSmall = await app.request('/api/cs2/matches', { method: 'POST', admin: true, body: { teamA: 'Alpha', teamB: 'Bravo', format: 'bo5' } });
  assert.equal(tooSmall.status, 400);
  assert.match(tooSmall.data.error, /mindestens 5 Maps/);
  assert.equal((await app.request('/api/cs2/matches', { method: 'POST', admin: true, body: { teamA: 'Alpha', teamB: 'alpha' } })).status, 400);
  assert.equal(tmt.calls.length, 0, 'invalid requests never reach TMT2');

  const failed = await app.request('/api/cs2/matches', { method: 'POST', admin: true, body: { teamA: 'busy', teamB: 'Bravo' } });
  assert.equal(failed.status, 502);
  assert.match(failed.data.error, /TMT2 meldet 400: no free game server/);
  assert.equal((await app.request('/api/cs2', { admin: true })).data.matches.length, 0, 'failed creations leave nothing behind');

  const created = await app.request('/api/cs2/matches', { method: 'POST', admin: true, body: { teamA: 'Alpha', teamB: 'Bravo', format: 'bo1' } });
  assert.equal(created.status, 201, created.text);
  assert.equal(tmt.calls.at(-1).body.webhookUrl, null, 'without TMT2_WEBHOOK_URL no webhook is registered');
  Object.assign(tmt.matches.get('tmt-1'), { state: 'FINISHED', matchMaps: [{ name: 'de_mirage', state: 'FINISHED', score: { teamA: 10, teamB: 13 } }] });
  const synced = await app.request(`/api/cs2/matches/${created.data.id}/sync`, { method: 'POST', admin: true });
  assert.equal(synced.status, 200, synced.text);
  assert.deepEqual([synced.data.state, synced.data.wonA, synced.data.wonB, synced.data.reported, synced.data.tournament], ['FINISHED', 0, 1, false, null]);

  // Webhooks gelten nur bei eingeschaltetem Modul
  assert.equal((await app.request('/api/settings', { method: 'PUT', admin: true, body: { modules: { cs2: false } } })).status, 200);
  assert.equal((await hook(app, created.data.id, 'x', { type: 'MATCH_END' })).status, 404);
});

test('CS2/TMT2: without TMT2_URL and token the bridge reports that it is not configured', async (t) => {
  const app = await isolated(t, { prepare: enable });
  const d = await app.request('/api/cs2', { admin: true });
  assert.equal(d.data.configured, false);
  const r = await app.request('/api/cs2/matches', { method: 'POST', admin: true, body: { teamA: 'Alpha', teamB: 'Bravo' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /nicht eingerichtet/);
});
