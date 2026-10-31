'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { isolated } = require('../test-support/isolated.cjs');
const { createAgent, config } = require('../agent/tmt2-agent.js');

const TMT_TOKEN = 'synthetic-tmt2-token';
const AGENT_TOKEN = 'a'.repeat(40);
const quiet = { log() {}, error() {} };

// Lokale TMT2-Attrappe: merkt sich alle Anfragen und antwortet wie die TMT2-API (nur die genutzten Pfade).
async function fakeTmt(t) {
  const calls = [];
  const matches = new Map();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const url = new URL(req.url, 'http://x');
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(value === undefined ? '' : JSON.stringify(value)); };
      if (req.headers.authorization !== `Bearer ${TMT_TOKEN}`) return reply(401, { message: 'unauthorized' });
      const id = decodeURIComponent(url.pathname.split('/')[3] || '');
      if (req.method === 'GET' && url.pathname === '/api/matches') {
        const p = url.searchParams.getAll('passthrough');
        return reply(200, [...matches.values()].filter((m) => !p.length || p.includes(m.passthrough)));
      }
      if (req.method === 'POST' && url.pathname === '/api/matches') {
        if (body.teamA.name === 'busy') return reply(400, { message: 'no free game server <b>available</b>' });
        const m = { id: `tmt-${matches.size + 1}`, state: 'ELECTION', isStopped: false, matchMaps: [], rconPassword: 'SECRET_RCON', ...body };
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
const poll = (app, token) => fetch(`${app.base}/api/cs2/agent/poll`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
const admin = async (app) => (await app.request('/api/cs2', { admin: true })).data;
const agentFor = (app, tmt) => createAgent({ lanUrl: app.base, agentToken: AGENT_TOKEN, tmtUrl: tmt.url, tmtToken: TMT_TOKEN, log: quiet });

test('CS2/TMT2: the LAN client creates the match, reports progress and the result lands in the bracket once', async (t) => {
  const tmt = await fakeTmt(t);
  const app = await isolated(t, { prepare: enable, env: { TMT2_AGENT_TOKEN: AGENT_TOKEN, TMT2_PUBLIC_URL: 'http://tmt.invalid' } });
  const agent = agentFor(app, tmt);

  assert.equal((await app.request('/api/cs2', { user: 'buyer' })).status, 401, 'participants never see the admin bridge');
  assert.equal((await poll(app)).status, 403);
  assert.equal((await poll(app, 'b'.repeat(40))).status, 403);
  assert.match(app.logs(), /"cs2_agent_rejected"/);

  const start = await admin(app);
  assert.deepEqual([start.configured, start.agentOnline, start.candidates.length], [true, false, 1]);
  const c = start.candidates[0];
  assert.deepEqual([c.tournamentId, c.teamA, c.teamB], ['match', 'buyer', 'other']);
  const created = await app.request('/api/cs2/matches', { method: 'POST', admin: true, body: { tournamentId: c.tournamentId, matchId: c.matchId, format: 'bo3' } });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.data.state, 'PENDING');
  assert.equal(tmt.calls.length, 0, 'the internet-facing server never talks to TMT2 itself');
  assert.equal((await admin(app)).candidates.length, 0, 'a pairing with an open match is not offered twice');
  assert.equal((await app.request('/api/cs2/matches', { method: 'POST', admin: true, body: { tournamentId: c.tournamentId, matchId: c.matchId } })).status, 400);

  await agent.cycle();
  const sent = tmt.calls.find((x) => x.method === 'POST');
  assert.equal(sent.auth, `Bearer ${TMT_TOKEN}`);
  assert.equal(sent.body.gameServer, null, 'game servers and RCON passwords stay in TMT2');
  assert.deepEqual([sent.body.teamA.name, sent.body.teamB.name, sent.body.passthrough], ['buyer', 'other', created.data.id]);
  assert.equal(sent.body.electionSteps.length, sent.body.mapPool.length);
  assert.equal(sent.body.webhookUrl, undefined);
  let d = await admin(app);
  assert.deepEqual([d.agentOnline, d.matches[0].state, d.matches[0].tmtId, d.matches[0].link], [true, 'ELECTION', 'tmt-1', 'http://tmt.invalid/matches/tmt-1']);

  const live = tmt.matches.get('tmt-1');
  Object.assign(live, { state: 'MATCH_MAP', matchMaps: [{ name: 'de_nuke', state: 'FINISHED', score: { teamA: 13, teamB: 8 } }, { name: 'de_mirage', state: 'IN_PROGRESS', score: { teamA: 3, teamB: 5 } }] });
  await agent.cycle();
  d = await admin(app);
  assert.deepEqual([d.matches[0].state, d.matches[0].wonA, d.matches[0].wonB, d.matches[0].maps.length], ['MATCH_MAP', 1, 0, 2]);
  assert.doesNotMatch(JSON.stringify(app.snapshot()), /SECRET_RCON/, 'the client only reports status and map scores');

  Object.assign(live, { state: 'FINISHED', matchMaps: [{ name: 'de_nuke', state: 'FINISHED', score: { teamA: 13, teamB: 8 } },
    { name: 'de_mirage', state: 'FINISHED', score: { teamA: 9, teamB: 13 } }, { name: 'de_train', state: 'FINISHED', score: { teamA: 13, teamB: 11 } }] });
  await agent.cycle();
  d = await admin(app);
  assert.deepEqual([d.matches[0].state, d.matches[0].wonA, d.matches[0].wonB, d.matches[0].reported, d.matches[0].note], ['FINISHED', 2, 1, true, '']);
  const results = async () => Object.values((await app.request('/api/tournaments/match', { admin: true })).data.results).map((r) => [r.a, r.b, r.pa, r.pb]);
  assert.deepEqual(await results(), [[2, 1, 0, 1]]);

  // Beendete Matches werden nicht mehr beobachtet; spätere Änderungen in TMT2 überschreiben nichts
  live.matchMaps[2].score = { teamA: 0, teamB: 13 };
  const before = tmt.calls.length;
  await agent.cycle();
  assert.equal(tmt.calls.length, before);
  assert.deepEqual(await results(), [[2, 1, 0, 1]]);

  assert.doesNotMatch(JSON.stringify(await admin(app)) + JSON.stringify(app.snapshot()), new RegExp(`${AGENT_TOKEN}|${TMT_TOKEN}`), 'no token is shown or stored');
  assert.equal((await app.request(`/api/cs2/matches/${d.matches[0].id}`, { method: 'DELETE', admin: true })).status, 200);
  assert.equal((await results()).length, 1, 'the reported result stays');
  assert.match(app.logs(), /"cs2_match_created"/);
});

test('CS2/TMT2: stopping, crash recovery, TMT2 errors and validation', async (t) => {
  const tmt = await fakeTmt(t);
  const app = await isolated(t, { prepare: enable, env: { TMT2_AGENT_TOKEN: AGENT_TOKEN } });
  const agent = agentFor(app, tmt);
  const create = (body) => app.request('/api/cs2/matches', { method: 'POST', admin: true, body });

  assert.equal((await app.request('/api/cs2/config', { method: 'PUT', admin: true, body: { mapPool: ['de_nuke', 'x y<script>'] } })).status, 400);
  assert.equal((await app.request('/api/cs2/config', { method: 'PUT', admin: true, body: { mapPool: ['de_nuke', 'de_mirage', '3070923343/fy_pool_day'] } })).status, 200);
  const tooSmall = await create({ teamA: 'Alpha', teamB: 'Bravo', format: 'bo5' });
  assert.equal(tooSmall.status, 400);
  assert.match(tooSmall.data.error, /mindestens 5 Maps/);
  assert.equal((await create({ teamA: 'Alpha', teamB: 'alpha' })).status, 400);

  // TMT2 lehnt ab: Fehler mit Meldung, nichts bleibt hängen
  const busy = await create({ teamA: 'busy', teamB: 'Bravo' });
  await agent.cycle();
  let m = (await admin(app)).matches.find((x) => x.id === busy.data.id);
  assert.equal(m.state, 'ERROR');
  assert.match(m.note, /TMT2: 400: no free game server/);

  // Absturz zwischen Anlegen und Melden: das schon vorhandene TMT2-Match wird wiederverwendet
  const free = await create({ teamA: 'Alpha', teamB: 'Bravo', format: 'bo1' });
  tmt.matches.set('tmt-pre', { id: 'tmt-pre', passthrough: free.data.id, state: 'ELECTION', isStopped: false, matchMaps: [] });
  const posts = tmt.calls.filter((x) => x.method === 'POST').length;
  await agent.cycle();
  assert.equal(tmt.calls.filter((x) => x.method === 'POST').length, posts, 'no second match in TMT2');
  assert.equal((await admin(app)).matches.find((x) => x.id === free.data.id).tmtId, 'tmt-pre');

  // Entfernen: der Client beendet das Match beim nächsten Durchlauf in TMT2
  assert.equal((await app.request(`/api/cs2/matches/${free.data.id}`, { method: 'DELETE', admin: true })).status, 200);
  assert.deepEqual((await (await poll(app, AGENT_TOKEN)).json()).stop, ['tmt-pre']);
  await agent.cycle();
  assert.ok(tmt.calls.some((x) => x.method === 'DELETE' && x.url === '/api/matches/tmt-pre'));
  assert.deepEqual((await (await poll(app, AGENT_TOKEN)).json()).stop, []);

  // In TMT2 verschwunden: abgebrochen
  const gone = await create({ teamA: 'Charlie', teamB: 'Delta' });
  await agent.cycle();
  tmt.matches.delete((await admin(app)).matches.find((x) => x.id === gone.data.id).tmtId);
  await agent.cycle();
  assert.equal((await admin(app)).matches.find((x) => x.id === gone.data.id).state, 'STOPPED');

  // Modul aus: keine Aufträge mehr
  await create({ teamA: 'Echo', teamB: 'Foxtrot' });
  assert.equal((await app.request('/api/settings', { method: 'PUT', admin: true, body: { modules: { cs2: false } } })).status, 200);
  assert.deepEqual((await (await poll(app, AGENT_TOKEN)).json()).create, []);
});

test('CS2/TMT2: without TMT2_AGENT_TOKEN nothing can be queued and no client gets in', async (t) => {
  const app = await isolated(t, { prepare: enable });
  assert.equal((await admin(app)).configured, false);
  const r = await app.request('/api/cs2/matches', { method: 'POST', admin: true, body: { teamA: 'Alpha', teamB: 'Bravo' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /nicht eingerichtet/);
  assert.equal((await poll(app, AGENT_TOKEN)).status, 403);
});

test('CS2/TMT2 client: forwards only known fields to TMT2 and sends the token only via HTTPS', async (t) => {
  const tmt = await fakeTmt(t);
  // Eine kompromittierte oder fehlerhafte Gegenstelle darf keine Gameserver, RCON-Befehle oder Webhooks unterschieben.
  const lan = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url.endsWith('/poll') ? { create: [{ id: 'x1', body: { teamA: { name: 'A' }, teamB: { name: 'B', passthrough: 'B' }, mapPool: ['de_nuke'],
        electionSteps: [], gameServer: { ip: '10.0.0.1', port: 27015, rconPassword: 'evil' }, rconCommands: { init: ['quit'] }, webhookUrl: 'http://evil.invalid' } }] } : { ok: true }));
    });
  });
  await new Promise((r) => lan.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => lan.close(r)));
  await createAgent({ lanUrl: `http://127.0.0.1:${lan.address().port}`, agentToken: AGENT_TOKEN, tmtUrl: tmt.url, tmtToken: TMT_TOKEN, log: quiet }).cycle();
  const sent = tmt.calls.find((x) => x.method === 'POST').body;
  assert.deepEqual(Object.keys(sent).sort(), ['canClinch', 'electionSteps', 'gameServer', 'mapPool', 'mode', 'passthrough', 'teamA', 'teamB']);
  assert.equal(sent.gameServer, null);

  const env = { LAN_URL: 'http://lan.example.org', TMT2_AGENT_TOKEN: AGENT_TOKEN, TMT2_TOKEN: TMT_TOKEN };
  assert.throws(() => config(env), /https/);
  assert.equal(config({ ...env, LAN_URL: 'https://lan.example.org/' }).lanUrl, 'https://lan.example.org');
  assert.throws(() => config({ ...env, LAN_URL: 'https://lan.example.org', TMT2_TOKEN: '' }), /TMT2_TOKEN fehlt/);
});
