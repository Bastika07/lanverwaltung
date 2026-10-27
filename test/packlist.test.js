'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isolated } = require('../test-support/isolated.cjs');
const fs = require('node:fs');
const vm = require('node:vm');

test('packlist: invalid values are rejected before any info changes', async (t) => {
  const f = await isolated(t);
  for (const packlist of [null, 42, true, {}, [], 'x'.repeat(10001)]) {
    const before = f.snapshot();
    const infoBefore = (await f.request('/api/info', { admin: true })).data;
    const r = await f.request('/api/info', { method: 'PUT', admin: true, body: { packlist, extra: 'must not change',
      wifi: { ssid: 'must not change' }, servers: [{ name: 'changed' }], games: [{ name: 'changed' }], rules: 'changed' } });
    assert.equal(r.status, 400);
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual((await f.request('/api/info', { admin: true })).data, infoBefore);
  }
  const exact = 'x'.repeat(10000);
  const r = await f.request('/api/info', { method: 'PUT', admin: true, body: { packlist: exact } });
  assert.equal(r.status, 200); assert.equal(r.data.packlist, exact);
  assert.equal((await f.request('/api/info', { admin: true })).data.packlist, exact);
});

test('packlist: existing access, admin, CSRF and upload-session boundaries remain active', async (t) => {
  const f = await isolated(t), body = { packlist: 'LAN-Kabel\nKopfhörer' };
  assert.equal((await f.request('/api/info', { method: 'PUT', body })).status, 403);
  assert.equal((await f.request('/api/info', { method: 'PUT', user: 'buyer', body })).status, 401);
  assert.equal((await f.request('/api/info', { method: 'PUT', admin: true, body, headers: { Origin: 'https://evil.invalid' } })).status, 403);
  assert.equal((await f.request('/api/info')).status, 403);
  assert.equal((await f.request('/api/info', { user: 'outsider' })).status, 403);
  assert.equal((await f.request('/api/info', { method: 'PUT', admin: true, body })).status, 200);
  assert.equal((await f.request('/api/info', { user: 'buyer' })).data.packlist, body.packlist);
  assert.equal((await f.request('/api/settings', { method: 'PUT', admin: true, body: { modules: { info: false } } })).status, 200);
  assert.equal((await f.request('/api/info', { user: 'buyer' })).status, 404);
  assert.equal((await f.request('/api/settings', { method: 'PUT', admin: true, body: { modules: { info: true } } })).status, 200);
  const pending = f.staged('/api/info', { method: 'PUT', admin: true, body: { packlist: 'must not save' } });
  // Let the request enter readBody before revoking its session.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const beforeLogout = f.snapshot().events;
  await f.request('/api/logout', { method: 'POST', admin: true, body: {} });
  pending.finish(); assert.equal((await pending.done).status, 401);
  assert.deepEqual(f.snapshot().events, beforeLogout);
  assert.equal(f.snapshot().events.find((e) => e.id === 'first').info.packlist, body.packlist);
});

test('packlist: route rechecks admin after awaiting the request body', async () => {
  let admin = true, finish;
  const db = { info: { packlist: 'unchanged' } };
  const before = structuredClone(db);
  class HttpError extends Error { constructor(status) { super(); this.status = status; } }
  const route = require('../lib/info')({ db, save: () => assert.fail('must not save'), broadcast: () => assert.fail('must not broadcast'),
    send: () => assert.fail('must not respond successfully'), HttpError, str: String,
    requireAdmin: () => { if (!admin) throw new HttpError(401); },
    readBody: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = route.routes({}, {}, ['info'], 'PUT');
  admin = false;
  finish({ packlist: 'revoked write' });
  await assert.rejects(pending, { status: 401 });
  assert.deepEqual(db, before);
});

function frontend(info) {
  const elements = { app: { innerHTML: '' }, infoForm: {}, iError: {},
    wSsid: { value: '' }, wPw: { value: '' }, wNote: { value: '' }, iRules: { value: '' }, iExtra: { value: '' } };
  let html = '';
  Object.defineProperty(elements.app, 'innerHTML', { get: () => html, set(value) {
    html = value;
    delete elements.iPacklist;
    const textarea = value.match(/<textarea id="iPacklist"[^>]*>([\s\S]*?)<\/textarea>/);
    // HTML textarea parsing discards one immediately following LF.
    if (textarea) elements.iPacklist = { value: textarea[1].replace(/^\n/, '').replace(/&(amp|lt|gt|quot|#39);/g,
      (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[entity])) };
  } });
  const calls = [];
  const context = vm.createContext({ views: {}, adminViews: {}, homeCards: [], beamerSlides: [],
    document: { addEventListener() {}, getElementById: (id) => elements[id], querySelectorAll: () => [], activeElement: { blur() {} } },
    api: async (method, path, body) => { calls.push({ method, path, body }); return info; },
    adminTabs: () => '', markdownHelp: () => '', toast() {}, render() {},
    esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) });
  vm.runInContext(fs.readFileSync(require.resolve('../public/info.js'), 'utf8'), context);
  return { context, elements, calls };
}

test('packlist: public plain text preserves lines, escapes HTML and has no checkboxes', async () => {
  const info = { wifi: {}, servers: [], games: [], packlist: '- Kabel\n- [ ] Maus\n<img src=x onerror=alert(1)>' };
  const f = frontend(info);
  await vm.runInContext('views.infos.render()', f.context);
  assert.match(f.elements.app.innerHTML, /Pack-\/Mitbringliste/);
  assert.match(f.elements.app.innerHTML, /class="packlist-text"/);
  assert.ok(f.elements.app.innerHTML.includes('- Kabel\n- [ ] Maus\n&lt;img'));
  assert.doesNotMatch(f.elements.app.innerHTML, /<input|<img/);
  const css = fs.readFileSync(require.resolve('../public/style.css'), 'utf8');
  assert.match(css, /\.packlist-text\s*\{[^}]*white-space:\s*pre-wrap/);
  for (const blank of ['', ' \n\t ', undefined]) {
    info.packlist = blank; await vm.runInContext('views.infos.render()', f.context);
    assert.doesNotMatch(f.elements.app.innerHTML, /Pack-\/Mitbringliste|packlist-text/);
    assert.match(f.elements.app.innerHTML, /Noch keine Infos/);
  }
  info.wifi.ssid = 'LAN';
  info.packlist = ' \n ';
  await vm.runInContext('views.infos.render()', f.context);
  assert.match(f.elements.app.innerHTML, /WLAN/);
  assert.doesNotMatch(f.elements.app.innerHTML, /Pack-\/Mitbringliste|packlist-text/);
});

test('packlist: admin textarea loads escaped text and submits a multiline replacement', async () => {
  const info = { wifi: {}, servers: [], games: [], rules: '', extra: '', packlist: '\nKabel\n</textarea><script>bad()</script>' };
  const f = frontend(info);
  await vm.runInContext('adminViews.infos.render()', f.context);
  assert.match(f.elements.app.innerHTML, /textarea id="iPacklist"[^>]*maxlength="10000"/);
  assert.ok(f.elements.app.innerHTML.includes('Kabel\n&lt;/textarea&gt;&lt;script&gt;'));
  assert.equal(f.elements.iPacklist.value, info.packlist);
  assert.doesNotMatch(f.elements.app.innerHTML, /<(?:script|iframe|object|embed|img)\b|type\s*=\s*["']checkbox\b/i);
  f.elements.iPacklist.value = 'Neue Liste\nLAN-Kabel';
  await f.elements.infoForm.onsubmit({ preventDefault() {} });
  assert.equal(f.calls.find((c) => c.method === 'PUT').body.packlist, 'Neue Liste\nLAN-Kabel');
});

test('packlist: legacy events default to empty text; admin can save, edit and clear multiline text per event', async (t) => {
  const f = await isolated(t);
  const read = () => f.request('/api/info', { admin: true });
  const beforeRead = f.snapshot();
  const initial = await read();
  assert.equal(initial.status, 200);
  assert.equal(initial.data.packlist, '');
  assert.deepEqual(f.snapshot(), beforeRead, 'legacy GET must not write defaults');
  const text = '\nBitte mitbringen:\r\n\n- LAN-Kabel\n- Kopfhörer\n  Beschriftet & vollständig\n';
  let result = await f.request('/api/info', { method: 'PUT', admin: true, body: { packlist: text } });
  assert.equal(result.status, 200); assert.equal(result.data.packlist, text);
  assert.equal((await read()).data.packlist, text);
  let snapshot = f.snapshot();
  assert.equal(snapshot.events.find((e) => e.id === 'first').info.packlist, text);
  assert.equal(snapshot.events.find((e) => e.id === 'second').info.packlist, undefined);
  result = await f.request('/api/info', { method: 'PUT', admin: true, headers: { 'X-Event': 'second' }, body: { packlist: 'Andere LAN' } });
  assert.equal(result.status, 200);
  assert.equal((await read()).data.packlist, text);
  result = await f.request('/api/info', { method: 'PUT', admin: true, body: { extra: 'Sonstige Hinweise' } });
  assert.equal(result.data.packlist, text, 'older clients omitting packlist must preserve it');
  result = await f.request('/api/info', { method: 'PUT', admin: true, body: { packlist: 'Neue Liste\nPC' } });
  assert.equal(result.data.packlist, 'Neue Liste\nPC');
  result = await f.request('/api/info', { method: 'PUT', admin: true, body: { packlist: '' } });
  assert.equal(result.data.packlist, '');
  snapshot = f.snapshot();
  assert.equal(snapshot.events.find((e) => e.id === 'second').info.packlist, 'Andere LAN');
});
