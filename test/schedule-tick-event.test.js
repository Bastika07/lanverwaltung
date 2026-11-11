'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const mods = { schedule: true };
const stamp = new Date().toISOString();
const event = (id, extra) => ({ id, name: id, createdAt: stamp, modules: mods, access: {}, sale: {}, info: {}, ticketTypes: [], orders: [],
  tournaments: [], guestServers: [], attendees: [], schedule: [], ...extra });

// Echtes Event- und Programm-Modul: laufendes Event „current“, die Orga bearbeitet das kommende Event „next“
function setup() {
  const current = event('current', { active: true });
  const next = event('next', { start: new Date(Date.now() + 7 * 86400000).toISOString() });
  const posts = [];
  let body;
  const ctx = { db: { meta: {}, persons: [], accounts: [], events: [current, next] }, save() {}, broadcast() {}, HttpError,
    str: (v, n = 100) => String(v || '').trim().slice(0, n), settings: () => ({ remindMinutes: 10, modules: mods }), moduleOn: () => true,
    Discord: { md: String }, discordPost: (text) => posts.push(text), requireAdmin() {}, readBody: async () => body,
    send: (res, status, data) => Object.assign(res, { status, data }) };
  ctx.event = require('../lib/event')(ctx);
  const schedule = require('../lib/schedule')(ctx);
  // Anfrage der Orga im Event e (wie server.js: ctx.event.run je Anfrage)
  const post = (e, item) => ctx.event.run(e, async () => { body = item; const res = {}; await schedule.routes({}, res, ['schedule'], 'POST'); return res; });
  return { current, next, posts, post };
}
const due = (title) => ({ title, start: new Date(Date.now() - 60000).toISOString(), remind: 0 });

test('Programm: Bearbeiten eines anderen Events löst dort keine Startmeldung aus', async () => {
  const { next, posts, post } = setup();
  assert.equal((await post(next, due('Synthetic Next'))).status, 201);
  assert.equal(next.schedule[0].startedAt, undefined, 'item of a non-current event is not started');
  assert.deepEqual(posts, []);
});

test('Programm: fällige Punkte des aktuellen Events werden weiter gemeldet, auch aus einer Anfrage im anderen Event', async () => {
  const { current, next, posts, post } = setup();
  current.schedule.push({ id: 'now', ...due('Synthetic Current'), end: null, note: '', announce: false });
  await post(next, { title: 'Synthetic Later', start: new Date(Date.now() + 86400000).toISOString() });
  assert.ok(current.schedule[0].startedAt);
  assert.equal(posts.length, 1);
  assert.match(posts[0], /Synthetic Current/);
});
