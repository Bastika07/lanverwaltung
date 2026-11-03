'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { isolated } = require('../test-support/isolated.cjs');

// Discord-Attrappe: merkt sich Nachrichten, alles andere antwortet neutral
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

const waitFor = async (fn) => { for (let i = 0; i < 50 && !fn(); i++) await new Promise((r) => setTimeout(r, 20)); };

test('Durchsage: „in Discord vorlesen“ setzt tts und schickt nur den Text ohne Emoji', async (t) => {
  const discord = await discordMock(t);
  const app = await isolated(t, {
    env: { DISCORD_BOT_TOKEN: 'synthetic-token', DISCORD_GUILD_ID: 'synthetic-guild', DISCORD_API_BASE: discord.base },
    prepare: (data) => {
      data.meta.announceChannelId = 'ansagen'; data.meta.eventCategoryId = 'event';
      data.events.find((x) => x.id === 'first').active = true;
    },
  });
  const send = (body) => app.request('/api/announcements', { method: 'POST', admin: true, body: { seconds: 0, lamp: false, ...body } });

  assert.equal((await send({ text: '🍕 Pizza ist da', tts: true })).data.tts, true);
  await waitFor(() => discord.messages.length >= 1);
  assert.equal((await send({ text: 'Siegerehrung' })).data.tts, false, 'Standard: nicht vorlesen');
  await waitFor(() => discord.messages.length >= 2);
  assert.equal((await send({ text: 'Nur Beamer', tts: true, discord: false })).data.tts, false, 'ohne Discord-Post kein TTS');

  const [spoken, normal, ...rest] = discord.messages;
  assert.equal(spoken.channel, 'ansagen');
  assert.equal(spoken.tts, true);
  assert.equal(spoken.content, 'Pizza ist da', 'vorgelesen wird nur der Text');
  assert.equal(normal.tts, undefined);
  assert.equal(normal.content, '📢 **Durchsage** von Orga: Siegerehrung');
  assert.equal(rest.length, 0);
});

test('Beamer-Sprachausgabe: nur Admins schalten sie, Besucher sehen den Schalter in den öffentlichen Einstellungen', async (t) => {
  const app = await isolated(t);
  const pub = async () => (await app.request('/api/me')).data.settings;
  assert.deepEqual([(await pub()).speakAnnouncements, (await pub()).speakMatches], [false, false], 'Standard aus');

  const denied = await app.request('/api/settings', { method: 'PUT', body: { speakAnnouncements: true } });
  assert.ok([401, 403].includes(denied.status));
  assert.equal((await pub()).speakAnnouncements, false);

  assert.equal((await app.request('/api/settings', { method: 'PUT', admin: true, body: { speakAnnouncements: true, speakMatches: 'ja' } })).status, 200);
  assert.deepEqual([(await pub()).speakAnnouncements, (await pub()).speakMatches], [true, true]);
  assert.equal(app.snapshot().meta.settings.speakMatches, true, 'als Boolean gespeichert');
});
