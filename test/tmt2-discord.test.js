'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { isolated } = require('../test-support/isolated.cjs');
const { fakeTmt, TMT_TOKEN } = require('../test-support/fake-tmt2.cjs');
const { createAgent } = require('../agent/tmt2-agent.js');

const AGENT_TOKEN = 'd'.repeat(40);
const quiet = { log() {}, error() {} };

// Discord-Attrappe: merkt sich Nachrichten, alles andere (Kanäle für das Turnier) antwortet neutral
async function discordMock(t) {
  const messages = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (b) => { body += b; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.method === 'POST' && /^\/channels\/[\w-]+\/messages$/.test(url.pathname)) messages.push({ channel: url.pathname.split('/')[2], ...JSON.parse(body) });
      res.end(JSON.stringify(req.method === 'GET' ? [] : { id: `${Date.now()}${messages.length}` }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { base: `http://127.0.0.1:${server.address().port}`, messages };
}

test('CS2-Turnier: angelegtes TMT2-Match pingt die Spieler mit Server zum Verbinden, ohne RCON-Passwort', async (t) => {
  const tmt = await fakeTmt(t);
  const discord = await discordMock(t);
  const app = await isolated(t, {
    env: { TMT2_AGENT_TOKEN: AGENT_TOKEN, DISCORD_BOT_TOKEN: 'synthetic-token', DISCORD_GUILD_ID: 'synthetic-guild', DISCORD_API_BASE: discord.base },
    prepare: (data) => {
      data.meta.tournamentChannelId = 'turniere'; data.meta.eventCategoryId = 'event';
      data.persons.push({ id: 'p-alpha', name: 'Alpha', discordId: '111' }, { id: 'p-bravo', name: 'Bravo', discordId: '222' });
      const e = data.events.find((x) => x.id === 'first');
      Object.assign(e, { active: true, modules: { ...e.modules, cs2: true } });
      e.attendees.push({ personId: 'p-alpha' }, { personId: 'p-bravo' }); // Pings nur für Teilnehmer des Events
      e.tournaments.push({ id: 'cup', name: 'Cup', type: 'ko', status: 'running', participants: ['Alpha', 'Bravo', 'Charlie', 'Delta'], order: [0, 1, 2, 3],
        results: {}, members: {}, playerIds: { Alpha: 'p-alpha', Bravo: 'p-bravo', Charlie: null, Delta: null }, discordEnabled: true, cs2: { format: 'bo1', finalFormat: 'bo1' } });
    },
  });
  const agent = createAgent({ lanUrl: app.base, agentToken: AGENT_TOKEN, tmtUrl: tmt.url, tmtToken: TMT_TOKEN, log: quiet });
  await agent.cycle();
  await agent.cycle(); // zweiter Abruf: keine doppelte Ansage
  for (let i = 0; i < 50 && discord.messages.length < 2; i++) await new Promise((r) => setTimeout(r, 20));

  const ready = discord.messages.filter((m) => m.channel === 'turniere' && /connect /.test(m.content));
  assert.equal(ready.length, 2, 'eine Ansage je angelegtem Match');
  const alpha = ready.find((m) => m.content.includes('<@111>'));
  assert.ok(alpha, 'Spieler von Alpha werden erwähnt');
  assert.match(alpha.content, /^🎮 \*\*Cup\*\* – Halbfinale: \*\*Alpha\*\* \(<@111>\) vs \*\*\w+\*\*/);
  assert.match(alpha.content, /Server bereit: `connect 10\.0\.0\.5:270(15|16)`/);
  assert.deepEqual(alpha.allowed_mentions, { parse: [], users: ['111'] });

  const d = (await app.request('/api/cs2', { admin: true })).data;
  assert.deepEqual(d.matches.map((m) => m.server).sort(), ['10.0.0.5:27015', '10.0.0.5:27016']);
  const everything = JSON.stringify([discord.messages, d, app.snapshot()]);
  assert.doesNotMatch(everything, /SECRET_RCON/, 'RCON-Passwort verlässt das LAN nicht');
  // Öffentliche Turnieransicht ohne Serveradresse
  assert.doesNotMatch(JSON.stringify((await app.request('/api/tournaments/cup')).data), /10\.0\.0\.5/);
});
