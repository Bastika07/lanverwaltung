'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const profile = { firstName: 'Ada', lastName: 'Example', street: 'Street 1', zip: '12345', city: 'Town', email: 'ada@example.invalid', birthdate: '1990-01-01' };
const fields = Object.keys(profile);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
async function harness(options = {}) {
  const elements = {}, calls = [], pending = []; let controls = [], html = '';
  const matches = (e, s) => s.includes(',') ? s.split(',').some((x) => matches(e, x.trim())) : /^[a-z]+$/.test(s) ? e.tag === s : s.startsWith('[') ? Object.hasOwn(e.attrs, s.slice(1, -1)) : false;
  const select = (s) => controls.filter((e) => matches(e, s));
  elements.app = { querySelectorAll: select, get innerHTML() { return html; }, set innerHTML(value) {
    html = value; controls = []; const generation = controls; for (const k of Object.keys(elements)) if (k !== 'app') delete elements[k];
    for (const m of value.matchAll(/<(input|select|button|form|p)\b([^>]*)>/g)) {
      const attrs = Object.fromEntries([...m[2].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], decode(a[2])]));
      const e = { tag: m[1], attrs, dataset: {}, value: attrs.value || '', disabled: /\bdisabled\b/.test(m[2]), textContent: '', pos: m.index };
      for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) e.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
      if (e.tag === 'select') { const opts = [...value.slice(m.index + m[0].length).split('</select>')[0].matchAll(/<option\b([^>]*)>([^<]*)/g)]; const opt = opts.find((o) => /\bselected\b/.test(o[1])) || opts[0]; e.value = opt ? decode(opt[1].match(/value="([^"]*)"/)?.[1] || '') : ''; }
      if (e.tag === 'form') { const end = value.indexOf('</form>', m.index); e.querySelectorAll = (s) => generation.filter((x) => matches(x, s) && x.pos > m.index && x.pos < end); }
      controls.push(e); if (attrs.id) elements[attrs.id] = e;
    }
  } };
  const targets = options.targets || [{ kind: 'account', id: 'buyer', name: 'Ada', relationship: 'own', profile: { ...profile }, version: 'version-1', consentAt: '2020-01-01' }];
  const ctx = vm.createContext({ views: {}, adminViews: {}, beamerSlides: [], esc, toast() {}, on: () => true, adminTabs: () => '', state: { events: { events: [] } }, confirm: () => true,
    document: { getElementById: (id) => elements[id] },
    api: async (method, url, body) => {
      calls.push({ method, url, body: body && JSON.parse(JSON.stringify(body)) });
      if (method === 'PUT') return options.write ? options.write(body) : { ...targets[0], profile: body.profile, version: 'version-2' };
      if (options.read) { const result = await options.read(url); if (result !== undefined) return result; }
      if (url === '/persons') return [{ id: 'person1', name: 'Ada', events: [], steam: '', note: '' }];
      if (url === '/persons/person1/ticket-accounts') return { person: { id: 'person1', name: 'Ada' }, targets: structuredClone(targets) };
      throw new Error('Unexpected request: ' + url);
    }, render: () => { const p = ctx.adminViews.personen.render(); pending.push(p); return p; },
  });
  vm.runInContext(fs.readFileSync(require.resolve('../public/people.js'), 'utf8'), ctx);
  await ctx.adminViews.personen.render();
  return { ctx, elements, calls, select, get html() { return html; }, async flush() { await Promise.all(pending); }, async open() { const b = select('[data-ticket-account]')[0]; assert.ok(b, 'person row offers ticket-account access'); await b.onclick(); await this.flush(); } };
}

test('persons: direct account action opens labeled fields and saves exact version without consent fabrication', async () => {
  const h = await harness(); await h.open();
  assert.match(h.html, /Eigenes Ticketkonto/);
  for (const field of fields) assert.equal(h.elements['pa_' + field].value, profile[field]);
  h.elements.pa_city.value = 'New town';
  await h.elements.personAccountForm.onsubmit({ preventDefault() {} }); await h.flush();
  const put = h.calls.find((c) => c.method === 'PUT');
  assert.equal(put.url, '/persons/person1/ticket-accounts/account/buyer');
  assert.deepEqual(put.body, { profile: { ...profile, city: 'New town' }, version: 'version-1' });
  assert.equal(h.ctx.adminViews.personen.preserveDraft, true);
});

test('persons: buyer and manual targets are distinct, escaped and explicitly selectable', async () => {
  const h = await harness({ targets: [
    { kind: 'account', id: 'other', name: 'Different buyer', relationship: 'buyer', profile: { ...profile }, version: 'other-1' },
    { kind: 'order', id: 'manual', relationship: 'box_office', name: 'Walk-in', profile: { ...profile, firstName: '"><img src=x onerror=bad()>' }, version: 7, eventId: 'second', eventName: 'Other event', ref: 'LAN-MANUAL' },
  ] });
  await h.open(); assert.match(h.html, /Käuferkonto/); assert.match(h.html, /gehören dem Käufer/);
  h.elements.pa_target.value = 'order:manual'; await h.elements.pa_target.onchange(); await h.flush();
  assert.match(h.html, /Other event/); assert.match(h.html, /LAN-MANUAL/); assert.doesNotMatch(h.html, /<img\b/i);
  assert.equal(h.elements.pa_firstName.value, '"><img src=x onerror=bad()>');
  h.elements.pa_firstName.value = 'Corrected'; await h.elements.personAccountForm.onsubmit({ preventDefault() {} });
  const put = h.calls.find((c) => c.method === 'PUT'); assert.equal(put.url, '/persons/person1/ticket-accounts/order/manual'); assert.equal(put.body.version, 7);
});

test('persons: conflict preserves draft and failed writes unlock, successful writes cannot be resubmitted', async () => {
  const h = await harness({ write: async () => { throw new Error('Daten wurden inzwischen geändert'); } }); await h.open();
  h.elements.pa_city.value = 'Unsaved town'; await h.elements.personAccountForm.onsubmit({ preventDefault() {} });
  assert.equal(h.elements.pa_city.value, 'Unsaved town'); assert.match(h.elements.pa_error.textContent, /inzwischen/);
  assert.ok(h.elements.personAccountForm.querySelectorAll('input, button, select').every((e) => !e.disabled));
  let release;
  const s = await harness({ write: () => new Promise((r) => { release = r; }) }); await s.open();
  const form = s.elements.personAccountForm; const saving = form.onsubmit({ preventDefault() {} });
  assert.ok(form.querySelectorAll('input, button, select').every((e) => e.disabled));
  await form.onsubmit({ preventDefault() {} }); assert.equal(s.calls.filter((c) => c.method === 'PUT').length, 1);
  release({}); await saving; await s.flush(); await form.onsubmit({ preventDefault() {} });
  assert.equal(s.calls.filter((c) => c.method === 'PUT').length, 1);
});

test('persons: committed contact writes remain locked through delayed and rejected refresh', async () => {
  for (const rejectRefresh of [false, true]) {
    let refreshing = false, release, commit;
    const h = await harness({
      write: () => new Promise((resolve) => { commit = () => { refreshing = true; resolve({}); }; }),
      read: (url) => refreshing && url === '/persons' ? new Promise((resolve, reject) => { release = () => { refreshing = false; if (rejectRefresh) reject(new Error('Refresh failed')); else resolve(); }; }) : undefined,
    });
    await h.open(); const form = h.elements.personAccountForm;
    const saving = form.onsubmit({ preventDefault() {} });
    h.elements.psSearch.onchange({ target: { value: 'Ada' } }); await h.flush();
    const replacement = h.elements.personAccountForm;
    commit();
    await new Promise(setImmediate);
    assert.equal(typeof release, 'function');
    assert.ok(form.querySelectorAll('input, select, button').every((e) => e.disabled));
    assert.ok(replacement.querySelectorAll('input, select, button').every((e) => e.disabled));
    await replacement.onsubmit({ preventDefault() {} });
    await form.onsubmit({ preventDefault() {} });
    assert.equal(h.calls.filter((c) => c.method === 'PUT').length, 1);
    release(); await saving;
    if (rejectRefresh) { await assert.rejects(h.flush(), /Refresh failed/); assert.match(h.elements.pa_error.textContent, /Refresh failed/); }
    else await h.flush();
    assert.ok(form.querySelectorAll('input, select, button').every((e) => e.disabled));
    assert.ok(replacement.querySelectorAll('input, select, button').every((e) => e.disabled));
    await replacement.onsubmit({ preventDefault() {} });
    await form.onsubmit({ preventDefault() {} });
    assert.equal(h.calls.filter((c) => c.method === 'PUT').length, 1);
  }
});

test('persons: search redraw preserves the active contact draft and exact version', async () => {
  const h = await harness(); await h.open();
  const original = h.elements.personAccountForm;
  h.elements.pa_city.value = 'UNSAVED';
  h.elements.psSearch.onchange({ target: { value: 'Ada' } }); await h.flush();
  assert.notEqual(h.elements.personAccountForm, original);
  assert.equal(h.elements.pa_city.value, 'UNSAVED');
  await h.elements.personAccountForm.onsubmit({ preventDefault() {} }); await h.flush();
  assert.deepEqual(h.calls.find((c) => c.method === 'PUT').body, { profile: { ...profile, city: 'UNSAVED' }, version: 'version-1' });
});

test('persons: pending write cannot be submitted again after search redraw', async () => {
  let release, writes = 0;
  const h = await harness({ write: () => ++writes === 1 ? new Promise((resolve) => { release = resolve; }) : {} });
  await h.open(); h.elements.pa_city.value = 'Pending town';
  const original = h.elements.personAccountForm;
  const saving = original.onsubmit({ preventDefault() {} });
  h.elements.psSearch.onchange({ target: { value: 'Ada' } }); await h.flush();
  const replacement = h.elements.personAccountForm;
  await replacement.onsubmit({ preventDefault() {} });
  assert.equal(h.calls.filter((c) => c.method === 'PUT').length, 1);
  assert.ok(replacement.querySelectorAll('input, select, button').every((e) => e.disabled));
  assert.equal(h.elements.pa_city.value, 'Pending town');
  release({}); await saving; await h.flush();
  for (const form of [original, replacement]) {
    assert.ok(form.querySelectorAll('input, select, button').every((e) => e.disabled));
    await form.onsubmit({ preventDefault() {} });
  }
  assert.equal(h.calls.filter((c) => c.method === 'PUT').length, 1);
});

test('persons: failed write after redraw unlocks the current form and preserves draft and error', async () => {
  let reject;
  const h = await harness({ write: () => new Promise((_, r) => { reject = r; }) }); await h.open();
  h.elements.pa_city.value = 'Retry town';
  const saving = h.elements.personAccountForm.onsubmit({ preventDefault() {} });
  h.elements.psSearch.onchange({ target: { value: 'Ada' } }); await h.flush();
  const replacement = h.elements.personAccountForm;
  reject(new Error('Write conflict')); await saving;
  assert.equal(h.elements.pa_error.textContent, 'Write conflict');
  assert.equal(h.elements.pa_city.value, 'Retry town');
  assert.ok(replacement.querySelectorAll('input, select, button').every((e) => !e.disabled));
  h.elements.psSearch.onchange({ target: { value: '' } }); await h.flush();
  assert.equal(h.elements.pa_error.textContent, 'Write conflict');
  assert.equal(h.elements.pa_city.value, 'Retry town');
  const retry = h.elements.personAccountForm.onsubmit({ preventDefault() {} });
  assert.deepEqual(h.calls.filter((c) => c.method === 'PUT').map((c) => c.body), [
    { profile: { ...profile, city: 'Retry town' }, version: 'version-1' },
    { profile: { ...profile, city: 'Retry town' }, version: 'version-1' },
  ]);
  reject(new Error('Still conflicting')); await retry;
});

test('persons: pending write blocks close, target switch, reload and opening another account', async () => {
  let release;
  const h = await harness({ write: () => new Promise((r) => { release = r; }), targets: [
    { kind: 'account', id: 'buyer', relationship: 'own', profile: { ...profile }, version: 'version-1' },
    { kind: 'order', id: 'manual', relationship: 'box_office', profile: { ...profile }, version: 7 },
  ] }); await h.open();
  const saving = h.elements.personAccountForm.onsubmit({ preventDefault() {} });
  h.elements.psSearch.onchange({ target: { value: 'Ada' } }); await h.flush();
  const reads = h.calls.filter((c) => c.method === 'GET').length;
  await h.elements.pa_close.onclick(); await h.flush();
  assert.ok(h.elements.personAccountForm, 'busy account cannot be closed');
  h.elements.pa_target.value = 'order:manual'; await h.elements.pa_target.onchange(); await h.flush();
  assert.equal(h.elements.pa_target.value, 'account:buyer');
  await h.elements.pa_reload.onclick();
  await h.select('[data-ticket-account]')[0].onclick();
  assert.equal(h.calls.filter((c) => c.method === 'GET').length, reads);
  release({}); await saving; await h.flush();
});

test('persons: no association offers no editable form and never invents an account', async () => {
  const h = await harness({ targets: [] }); await h.open(); assert.match(h.html, /Keine zugeordneten Ticketkonten/);
  assert.equal(h.elements.personAccountForm, undefined); assert.equal(h.calls.some((c) => c.method === 'PUT'), false);
});
