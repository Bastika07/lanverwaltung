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

test('Durchsage „vorlesen“: Discord bekommt tts und nur den Text ohne Emoji, Beamer das Flag speak', async (t) => {
  const discord = await discordMock(t);
  const app = await isolated(t, {
    env: { DISCORD_BOT_TOKEN: 'synthetic-token', DISCORD_GUILD_ID: 'synthetic-guild', DISCORD_API_BASE: discord.base },
    prepare: (data) => {
      data.meta.announceChannelId = 'ansagen'; data.meta.eventCategoryId = 'event';
      data.events.find((x) => x.id === 'first').active = true;
    },
  });
  const send = async (body) => (await app.request('/api/announcements', { method: 'POST', admin: true, body: { seconds: 0, lamp: false, ...body } })).data;

  let a = await send({ text: '🍕 Pizza ist da', speak: true });
  assert.deepEqual([a.speak, a.tts], [true, true]);
  await waitFor(() => discord.messages.length >= 1);
  a = await send({ text: 'Siegerehrung' });
  assert.deepEqual([a.speak, a.tts], [false, false], 'Standard: nicht vorlesen');
  await waitFor(() => discord.messages.length >= 2);
  a = await send({ text: 'Nur Beamer', speak: true, discord: false });
  assert.deepEqual([a.speak, a.tts], [true, false], 'ohne Discord-Post kein TTS, der Beamer liest trotzdem');
  assert.equal((await send({ text: 'Alter Name', tts: true, discord: false })).speak, true, 'früheres Feld tts gilt weiter');

  const [spoken, normal, ...rest] = discord.messages;
  assert.equal(spoken.channel, 'ansagen');
  assert.equal(spoken.tts, true);
  assert.equal(spoken.content, 'Pizza ist da', 'vorgelesen wird nur der Text');
  assert.equal(normal.tts, undefined);
  assert.equal(normal.content, '📢 **Durchsage** von Orga: Siegerehrung');
  assert.equal(rest.length, 0);
});

test('„Standardmäßig vorlesen“: nur Admins schalten es, Durchsagen ohne Angabe folgen ihm', async (t) => {
  const app = await isolated(t);
  const settings = async () => (await app.request('/api/settings', { admin: true })).data;
  assert.deepEqual([(await settings()).speakDefault, (await settings()).speakMatches], [false, false], 'Standard aus');
  assert.equal((await app.request('/api/me')).data.settings.speakAnnouncements, undefined, 'alter Beamer-Schalter entfällt');

  const denied = await app.request('/api/settings', { method: 'PUT', body: { speakDefault: true } });
  assert.ok([401, 403].includes(denied.status));
  assert.equal((await settings()).speakDefault, false);

  assert.equal((await app.request('/api/settings', { method: 'PUT', admin: true, body: { speakDefault: 'ja', speakMatches: true } })).status, 200);
  assert.equal(app.snapshot().meta.settings.speakDefault, true, 'als Boolean gespeichert');
  assert.equal((await app.request('/api/me')).data.settings.speakMatches, true, 'Spiele-Schalter ist für den Beamer öffentlich');

  const send = async (body) => (await app.request('/api/announcements', { method: 'POST', admin: true, body: { seconds: 0, lamp: false, discord: false, ...body } })).data;
  assert.equal((await send({ text: 'Ohne Angabe' })).speak, true);
  assert.equal((await send({ text: 'Abgewählt', speak: false })).speak, false);
});
