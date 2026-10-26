'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

function fixture() {
  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const db = { meta: {} }, events = [];
  let saves = 0;
  const ctx = { db, HttpError, readBody: async (req) => req.pending ? req.pending : req.body,
    requireAdmin: (req) => { if (!req.admin) throw new HttpError(401, 'Admin erforderlich'); },
    send: (res, status, body) => Object.assign(res, { status, body: structuredClone(body) }),
    save: () => { saves++; }, broadcast: (type) => events.push(type) };
  const module = require('../lib/website')(ctx);
  async function request(method = 'GET', { admin = false, body, path = '', pending } = {}) {
    const req = { admin, body, pending }, res = {};
    await module.routes(req, res, ['website', ...(path ? [path] : [])], method);
    return res.body;
  }
  return { db, events, request, module, get saves() { return saves; } };
}

test('website modules start unpublished and anonymous readers never receive drafts', async () => {
  const f = fixture();
  assert.equal(f.module.alwaysOn, true);
  assert.deepEqual(await f.request(), { pages: {}, cookies: null, sponsors: null });
  await assert.rejects(f.request('GET', { path: 'admin' }), { status: 401 });
  const s = await f.request('GET', { path: 'admin', admin: true });
  assert.equal(s.version, 0);
  s.pages.impressum.text = 'SECRET DRAFT';
  s.cookies.text = 'SECRET COOKIE DRAFT';
  s.sponsors.entries = [{ name: 'SECRET SPONSOR', description: '', tier: '', url: '', enabled: true }];
  await f.request('PUT', { path: 'admin', admin: true, body: s });
  assert.deepEqual(await f.request(), { pages: {}, cookies: null, sponsors: null });
  assert.equal(f.saves, 1); assert.deepEqual(f.events, ['website']);
});

test('published legal pages and sponsors are website-wide and filter hidden sponsor entries', async () => {
  const f = fixture(), s = await f.request('GET', { path: 'admin', admin: true });
  s.pages.impressum = { enabled: true, text: 'Organisation\nAnschrift\nKontakt' };
  s.pages.datenschutz = { enabled: false, text: 'Private draft' };
  s.sponsors = { enabled: true, text: 'Vielen Dank!', entries: [
    { name: 'First', description: 'Description', url: 'https://example.org/?a=1&b=2', tier: 'Gold', enabled: true },
    { name: 'Hidden', description: 'Private draft', url: '', tier: '', enabled: false },
  ] };
  const result = await f.request('PUT', { path: 'admin', admin: true, body: s });
  assert.equal(result.version, 1); assert.ok(result.pages.impressum.updatedAt);
  const pub = await f.request();
  assert.equal(pub.pages.impressum.title, 'Impressum');
  assert.equal(pub.pages.datenschutz, undefined);
  assert.deepEqual(pub.sponsors.entries.map((entry) => entry.name), ['First']);
  assert.ok(f.db.meta.website); assert.equal(f.db.events, undefined, 'no dependency on an event or its visibility');
});

test('invalid website edits are rejected atomically and only HTTPS sponsor URLs are allowed', async () => {
  const f = fixture(), original = await f.request('GET', { path: 'admin', admin: true });
  const invalid = [
    (s) => { s.pages.agb.enabled = true; },
    (s) => { s.pages.agb.text = 'x'.repeat(60001); },
    (s) => { s.pages.agb.enabled = 'false'; },
    (s) => { s.cookies.enabled = true; s.cookies.text = ''; },
    (s) => { s.sponsors.entries = [null]; },
    (s) => { s.sponsors.entries = Array(41).fill({}); },
    ...['javascript:alert(1)', 'data:text/html,test', 'http://example.org', '//example.org', 'https://user:pass@example.org'].map((url) =>
      (s) => { s.sponsors.entries = [{ name: 'Unsafe', url, tier: '', description: '', enabled: true }]; }),
  ];
  for (const change of invalid) {
    const s = structuredClone(original); change(s);
    await assert.rejects(f.request('PUT', { path: 'admin', admin: true, body: s }), { status: 400 });
    assert.equal(f.db.meta.website, undefined);
  }
  assert.equal(f.saves, 0);
  await assert.rejects(f.request('PUT', { path: 'admin', body: original }), { status: 401 });
});

test('cookie notice revision follows its text and published privacy contents, not unrelated sponsor edits', async () => {
  const f = fixture();
  let s = await f.request('GET', { path: 'admin', admin: true });
  s.cookies.enabled = true;
  s = await f.request('PUT', { path: 'admin', admin: true, body: s });
  const revision = (await f.request()).cookies.revision;
  s.sponsors.text = 'Sponsor edit';
  s = await f.request('PUT', { path: 'admin', admin: true, body: s });
  assert.equal((await f.request()).cookies.revision, revision);
  s.pages.datenschutz = { enabled: true, text: 'Geprüfte Datenschutzerklärung' };
  s = await f.request('PUT', { path: 'admin', admin: true, body: s });
  assert.notEqual((await f.request()).cookies.revision, revision);
  const updatedAt = s.pages.datenschutz.updatedAt;
  s = await f.request('PUT', { path: 'admin', admin: true, body: s });
  assert.equal(s.pages.datenschutz.updatedAt, updatedAt);
});

test('stale website versions and admin sessions revoked during upload cannot publish', async () => {
  const f = fixture(), s = await f.request('GET', { path: 'admin', admin: true });
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const stale = f.request('PUT', { path: 'admin', admin: true, pending });
  await f.request('PUT', { path: 'admin', admin: true, body: s });
  finish(s);
  await assert.rejects(stale, { status: 409 });
  let unblock;
  const req = { admin: true, pending: new Promise((resolve) => { unblock = resolve; }) };
  const revoked = f.module.routes(req, {}, ['website', 'admin'], 'PUT');
  req.admin = false; unblock({ ...s, version: 1 });
  await assert.rejects(revoked, { status: 401 });
  assert.equal(f.saves, 1);
});
