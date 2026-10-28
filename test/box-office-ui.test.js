'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/tickets.js'), 'utf8');
const fields = ['firstName', 'lastName', 'street', 'zip', 'city', 'email', 'birthdate'];
const profile = { firstName: 'Ada', lastName: 'Lovelace', street: 'Main 1', zip: '12345', city: 'Town', email: 'ada@example.org', birthdate: '1990-01-01' };
const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function order(status = 'pending', source = 'box_office') {
  return { id: 'o1', ref: 'BOX1', source, version: 3, status, total: 2500, createdAt: '2026-01-01', dueAt: '2026-12-01', buyer: { name: 'Ada', profile: { ...profile }, age: 36 }, tickets: [{ id: 't1', holder: 'Nick', code: 'A'.repeat(32), typeName: 'LAN', price: 2500 }] };
}
async function harness(options = {}) {
  const calls = [], renders = [], elements = {};
  let controls = [], html = '', prints = 0;
  const matches = (el, selector) => {
    if (selector.includes(',')) return selector.split(',').some((s) => matches(el, s.trim()));
    if (/^[a-z]+$/.test(selector)) return el.tag === selector;
    if (selector.startsWith('#')) return el.attrs.id === selector.slice(1);
    const m = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    return m && Object.hasOwn(el.attrs, m[1]) && (m[2] === undefined || el.attrs[m[1]] === m[2]);
  };
  const select = (selector, list = controls) => list.filter((el) => matches(el, selector));
  elements.app = { get innerHTML() { return html; }, set innerHTML(value) {
    html = value; controls = [];
    for (const key of Object.keys(elements)) if (!['app', 'printArea'].includes(key)) delete elements[key];
    for (const m of value.matchAll(/<(input|textarea|select|button|form|p)\b([^>]*)>/g)) {
      const attrs = Object.fromEntries([...m[2].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], decode(a[2])]));
      const el = { tag: m[1], id: attrs.id, attrs, dataset: {}, value: attrs.value || '', checked: /\bchecked\b/.test(m[2]), disabled: /\bdisabled\b/.test(m[2]), textContent: '', innerHTML: '', blur() {} };
      for (const [key, val] of Object.entries(attrs)) if (key.startsWith('data-')) el.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = val;
      if (el.tag === 'select') {
        const contents = value.slice(m.index + m[0].length).split('</select>')[0];
        const opts = [...contents.matchAll(/<option\b([^>]*)>([^<]*)/g)];
        const option = opts.find((o) => /\bselected\b/.test(o[1])) || opts[0];
        el.value = option ? decode(option[1].match(/value="([^"]*)"/)?.[1] ?? option[2]) : '';
      }
      if (el.tag === 'form') {
        const end = value.indexOf('</form>', m.index);
        el.range = [m.index, end];
        el.querySelectorAll = (s) => select(s, controls.filter((c) => c.pos > el.range[0] && c.pos < el.range[1]));
        el.querySelector = (s) => el.querySelectorAll(s)[0];
      }
      el.pos = m.index; controls.push(el); if (attrs.id) elements[attrs.id] = el;
    }
  } };
  const data = { event: { id: 'e1', name: 'LAN' }, settings: { bank: {}, privacy: 'Privacy notice', saleOpen: false }, types: [{ id: 'active', name: 'LAN', price: 2500, active: true, sold: 2, quota: 10, onSale: false }, { id: 'inactive', name: 'Hidden', price: 100, active: false, sold: 0 }], stats: {}, persons: options.persons || [], orders: options.orders || [] };
  const ctx = vm.createContext({ console, URL, structuredClone, views: {}, adminViews: {}, startHooks: [], liveHandlers: [], esc: escape, markdown: escape, markdownHelp: () => '', websiteLegalLinks: () => '', adminTabs: () => '', toLocalInput: () => '', copyBtn: () => '', on: () => true, toast: () => {}, confirm: () => true, location: { origin: 'https://lan.test' }, state: { admin: true, settings: {}, route: { view: 'admin:tickets', name: 'tickets' } }, QR: { svg: (url) => `<svg>${escape(url)}</svg>` }, window: { print: () => { prints++; } },
    scopeEventId: () => data.event.id,
    document: { getElementById: (id) => elements[id], querySelectorAll: select, activeElement: null, createElement: () => ({}), body: { appendChild: (el) => { elements[el.id] = el; } } },
    api: async (method, url, body) => {
      calls.push({ method, url, body: body && JSON.parse(JSON.stringify(body)) });
      if (method !== 'GET') {
        if (options.write) return options.write(method, url, body, data);
        if (url === '/tickets/admin/orders') { const o = order(body.paid ? 'paid' : 'pending'); data.orders.push(o); return o; }
        return order();
      }
      if (options.read) await options.read(method, url);
      if (url === '/tickets/admin') return structuredClone(data);
      if (url === '/accounts') return { accounts: [], redirectUri: '' };
      if (url === '/people') return { seating: { categories: [] } };
      return {};
    }, render: () => { const pending = ctx.adminViews.tickets.render(); renders.push(pending); return pending; },
  });
  vm.runInContext(source, ctx); vm.runInContext("TixAdmin.filter = 'all'", ctx); await ctx.adminViews.tickets.render();
  return { ctx, elements, calls, renders, data, select, get html() { return html; }, get prints() { return prints; }, async redraw() { await ctx.adminViews.tickets.render(); }, async flush() { await Promise.all(renders); } };
}
function fill(h, values = profile) {
  for (const field of fields) { h.elements['bo_' + field].value = values[field]; h.elements['bo_' + field].oninput?.(); }
}
function submit(h) { return h.elements.boxOfficeForm.onsubmit({ preventDefault() {} }); }
function choose(h, id) { h.elements.bo_person.value = id; h.elements.bo_person.onchange(); }

test('existing-person picker escapes and sorts labels and submits only the selected identity', async () => {
  const persons = [{ id: 'z', name: 'Zed' }, { id: 'a"', name: 'Ada <img src=x>', discordId: '123', discordName: '<script>nick</script>' }];
  const h = await harness({ persons });
  assert.ok(h.elements.bo_person, 'existing-person picker exists');
  const markup = h.html.match(/<select id="bo_person"[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.match(markup, /^<option value="">Neue Person anlegen<\/option>/);
  assert.ok(markup.indexOf('Ada') < markup.indexOf('Zed'));
  assert.match(markup, /Ada &lt;img src=x&gt;.*&lt;script&gt;nick&lt;\/script&gt;/);
  assert.doesNotMatch(h.html, /<(?:img|script)\b/i);
  choose(h, 'a"');
  assert.equal(h.elements.bo_holder.value, persons[1].name);
  assert.equal(h.elements.bo_holder.disabled, true);
  for (const field of fields) assert.equal(h.elements['bo_' + field].value, '', 'identity is not buyer contact');
  fill(h); h.elements.bo_privacy.checked = true;
  await submit(h); await h.flush();
  assert.deepEqual(h.calls.find((c) => c.method === 'POST').body, {
    buyerProfile: profile, items: [{ typeId: 'active', personId: 'a"' }], paid: false, privacyConfirmed: true,
  });
});

test('existing person selection and contacts survive redraw; redraw cannot bypass pending booking lock', async () => {
  let release;
  const h = await harness({ persons: [{ id: 'known', name: 'Known' }], write: () => new Promise((r) => { release = r; }) });
  fill(h); choose(h, 'known'); h.elements.bo_privacy.checked = true; h.elements.bo_paid.value = 'paid';
  await h.redraw();
  assert.equal(h.elements.bo_person.value, 'known');
  assert.equal(h.elements.bo_city.value, profile.city);
  assert.equal(h.elements.bo_privacy.checked, true);
  const saving = submit(h); await new Promise(setImmediate);
  await h.redraw();
  assert.ok(h.elements.boxOfficeForm.querySelectorAll('input, select, button').every((c) => c.disabled));
  await submit(h); assert.equal(h.calls.filter((c) => c.method === 'POST').length, 1);
  release(order('paid')); await saving; await h.flush();
});

test('failed booking after redraw retains selection and draft and unlocks replacement controls', async () => {
  let reject;
  const h = await harness({ persons: [{ id: 'known', name: 'Known' }], write: () => new Promise((_, r) => { reject = r; }) });
  fill(h); choose(h, 'known'); h.elements.bo_privacy.checked = true;
  const saving = submit(h); await new Promise(setImmediate); await h.redraw();
  reject(new Error('Save failed')); await saving;
  assert.equal(h.elements.bo_error.textContent, 'Save failed');
  assert.equal(h.elements.bo_person.value, 'known'); assert.equal(h.elements.bo_city.value, profile.city);
  assert.equal(h.elements.bo_person.disabled, false); assert.equal(h.elements.bo_holder.disabled, true);
  choose(h, ''); assert.equal(h.elements.bo_holder.disabled, false);
});

test('booking drafts are event-scoped and vanished selections never become a new person silently', async () => {
  const h = await harness({ persons: [{ id: 'known', name: 'Known' }] });
  fill(h); choose(h, 'known'); h.elements.bo_privacy.checked = true;
  h.data.event = { id: 'second', name: 'Second' }; await h.redraw();
  assert.equal(h.elements.bo_person.value, ''); assert.equal(h.elements.bo_city.value, ''); assert.equal(h.elements.bo_privacy.checked, false);
  h.data.event = { id: 'e1', name: 'LAN' }; await h.redraw();
  assert.equal(h.elements.bo_person.value, 'known'); assert.equal(h.elements.bo_city.value, profile.city);
  h.data.persons = []; await h.redraw(); assert.match(h.html, /Ausgewählte Person nicht mehr verfügbar/);
  assert.equal(h.elements.bo_person.value, 'known'); await submit(h);
  assert.match(h.elements.bo_error.textContent, /nicht mehr verfügbar/); assert.equal(h.calls.filter((c) => c.method === 'POST').length, 0);
});

test('stale booking form rejects changed event scope before writing while redraw is pending', async () => {
  let refreshing = false;
  const releases = [];
  const h = await harness({
    persons: [{ id: 'known', name: 'Known' }],
    read: () => refreshing ? new Promise((r) => releases.push(r)) : undefined,
    write: async () => { throw new Error('Unexpected stale write'); },
  });
  fill(h); choose(h, 'known'); h.elements.bo_privacy.checked = true; h.elements.bo_paid.value = 'paid';
  const oldForm = h.elements.boxOfficeForm;
  h.ctx.scopeEventId = () => 'second';
  refreshing = true;
  const redraw = h.redraw();
  try {
    assert.equal(releases.length, 3, 'event redraw is still fetching');
    assert.equal(h.elements.boxOfficeForm, oldForm, 'previous event form remains visible');
    await submit(h);
    assert.equal(h.calls.filter((c) => c.method !== 'GET').length, 0, 'no old-event draft may be sent under the new scope');
    assert.match(h.elements.bo_error.textContent, /Veranstaltung.*geändert.*neu laden/);
    assert.equal(h.elements.bo_city.value, profile.city);
    assert.equal(h.elements.bo_person.value, 'known');
    assert.equal(h.elements.bo_paid.value, 'paid');
    assert.equal(h.elements.bo_privacy.checked, true);
    assert.equal(h.elements.bo_person.disabled, false, 'rejected write unlocks original controls');
    assert.equal(h.elements.bo_holder.disabled, true, 'selected identity stays locked');
  } finally {
    refreshing = false; h.data.event = { id: 'second', name: 'Second' };
    releases.forEach((r) => r()); await redraw;
  }
  assert.equal(h.elements.bo_city.value, '', 'old draft is not moved to the new event');
  h.data.event = { id: 'e1', name: 'LAN' }; h.ctx.scopeEventId = () => 'e1'; await h.redraw();
  assert.equal(h.elements.bo_city.value, profile.city);
  assert.equal(h.elements.bo_person.value, 'known');
  assert.equal(h.elements.bo_paid.value, 'paid');
  assert.equal(h.elements.bo_privacy.checked, true);
  assert.match(h.elements.bo_error.textContent, /Veranstaltung.*geändert.*neu laden/);
  assert.equal(h.elements.bo_person.disabled, false);
});

for (const mode of ['contacts', 'holders']) {
  test(`stale ${mode} form rejects changed event scope before writing while redraw is pending`, async () => {
    let refreshing = false;
    const releases = [];
    const h = await harness({
      orders: [order()],
      read: () => refreshing ? new Promise((r) => releases.push(r)) : undefined,
      write: async () => { throw new Error('Unexpected stale write'); },
    });
    await h.select(mode === 'contacts' ? '[data-bo-edit]' : '[data-bo-holders]')[0].onclick(); await h.flush();
    const form = mode === 'contacts' ? h.elements.boxOfficeForm : h.elements.boHoldersForm;
    const input = mode === 'contacts' ? h.elements.bo_city : h.elements.bo_ticket_t1;
    const error = mode === 'contacts' ? h.elements.bo_error : h.elements.bo_holders_error;
    input.value = 'Unsaved change';
    h.ctx.scopeEventId = () => 'second';
    refreshing = true;
    const redraw = h.redraw();
    try {
      assert.equal(releases.length, 3);
      assert.equal(h.elements[form.id], form, 'old form remains visible');
      await form.onsubmit({ preventDefault() {} });
      assert.equal(h.calls.filter((c) => c.method !== 'GET').length, 0);
      assert.match(error.textContent, /Veranstaltung.*geändert.*neu laden/);
      assert.equal(input.value, 'Unsaved change');
      assert.ok(form.querySelectorAll('input, button').every((c) => !c.disabled), 'rejected form is unlocked');
    } finally {
      refreshing = false; releases.forEach((r) => r()); await redraw;
    }
  });
}

test('admin box office creates pending ticket without Discord and shows price, active types and privacy acknowledgement', async () => {
  const h = await harness();
  assert.ok(h.elements.boxOfficeForm, 'admin box office form exists');
  assert.match(h.html, /Abendkasse/);
  for (const field of fields) assert.match(h.html, new RegExp('for="bo_' + field + '"'));
  assert.equal(h.elements.bo_paid.value, 'pending');
  assert.equal(h.elements.bo_privacy.checked, false);
  const typeMarkup = h.html.match(/<select id="bo_type"[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.match(typeMarkup, /25,00/); assert.match(typeMarkup, /8/); assert.doesNotMatch(typeMarkup, /inactive/);
  fill(h); await submit(h);
  assert.equal(h.calls.filter((c) => c.method === 'POST').length, 0, 'privacy cannot be fabricated');
  h.elements.bo_privacy.checked = true;
  await submit(h); await h.flush();
  const request = h.calls.find((c) => c.method === 'POST');
  assert.equal(request.url, '/tickets/admin/orders');
  assert.deepEqual(request.body, { buyerProfile: profile, items: [{ typeId: 'active', holder: 'Ada Lovelace' }], paid: false, privacyConfirmed: true });
  assert.match(h.html, /BOX1/); assert.match(h.html, /Abendkasse/);
  assert.equal(h.calls.some((c) => c.url.includes('/checkin/')), false);
});

test('admin box office submits cash choice and prevents duplicate submissions while controls are disabled', async () => {
  let resolve;
  const h = await harness({ write: () => new Promise((r) => { resolve = r; }) });
  fill(h); h.elements.bo_paid.value = 'paid'; h.elements.bo_holder.value = 'Nickname'; h.elements.bo_privacy.checked = true;
  const form = h.elements.boxOfficeForm;
  const saving = submit(h);
  assert.ok(form.querySelectorAll('input, select, button').every((c) => c.disabled));
  await form.onsubmit({ preventDefault() {} });
  assert.equal(h.calls.filter((c) => c.method === 'POST').length, 1);
  assert.equal(h.calls.find((c) => c.method === 'POST').body.paid, true);
  assert.equal(h.calls.find((c) => c.method === 'POST').body.items[0].holder, 'Nickname');
  resolve(order('paid')); await saving; await h.flush();
});

test('successful booking stays locked while its post-success refresh is pending or fails', async () => {
  let refreshing = false;
  const releases = [];
  const h = await harness({
    write: async () => { refreshing = true; return order(); },
    read: () => refreshing ? new Promise((r) => releases.push(r)) : undefined,
  });
  fill(h); h.elements.bo_privacy.checked = true;
  const form = h.elements.boxOfficeForm;
  const saved = submit(h);
  await new Promise(setImmediate);
  try {
    assert.equal(releases.length, 3, 'post-success refresh is pending');
    assert.ok(form.querySelectorAll('input, select, button').every((c) => c.disabled), 'successful booking must remain locked until refresh replaces it');
    await form.onsubmit({ preventDefault() {} });
    assert.equal(h.calls.filter((c) => c.method === 'POST').length, 1);
  } finally {
    refreshing = false; releases.forEach((r) => r()); await saved; await h.flush();
  }

  const failed = await harness({
    write: async () => { refreshing = true; return order(); },
    read: () => { if (refreshing) throw new Error('Refresh failed'); },
  });
  fill(failed); failed.elements.bo_privacy.checked = true;
  const oldForm = failed.elements.boxOfficeForm;
  await submit(failed);
  await assert.rejects(failed.flush(), /Refresh failed/);
  assert.equal(failed.elements.boxOfficeForm, oldForm, 'failed refresh leaves the original form visible');
  assert.match(failed.elements.bo_error.textContent, /Refresh failed/);
  assert.ok(oldForm.querySelectorAll('input, select, button').every((c) => c.disabled));
  await oldForm.onsubmit({ preventDefault() {} });
  assert.equal(failed.calls.filter((c) => c.method === 'POST').length, 1, 'a committed booking cannot be resubmitted after refresh failure');
});

test('admin box office edits escaped contact fields with version and preserves drafts after conflict', async () => {
  const o = order(); o.buyer.profile.firstName = '\"><img src=x onerror=bad()>';
  const h = await harness({ orders: [o], write: async () => { throw new Error('Daten wurden inzwischen geändert'); } });
  const edit = h.select('[data-bo-edit]')[0];
  assert.ok(edit, 'manual order has contact edit action'); await edit.onclick(); await h.flush();
  assert.equal(h.elements.bo_firstName.value, o.buyer.profile.firstName);
  assert.doesNotMatch(h.html, /<img\b/i);
  assert.equal(h.elements.bo_type, undefined, 'contact edits cannot change ticket type or payment');
  assert.equal(h.elements.bo_paid, undefined);
  fill(h); h.elements.bo_city.value = 'New town'; await submit(h);
  const put = h.calls.find((c) => c.method === 'PUT');
  assert.equal(put.url, '/tickets/orders/o1/buyer');
  assert.deepEqual(put.body, { buyerProfile: { ...profile, city: 'New town' }, version: 3 });
  assert.equal(h.elements.bo_city.value, 'New town');
  assert.match(h.elements.bo_error.textContent, /inzwischen/);
  assert.ok(h.elements.boxOfficeForm.querySelectorAll('input, button').every((c) => !c.disabled));
  assert.equal(h.ctx.adminViews.tickets.preserveDraft, true, 'SSE must not erase unfocused drafts');
});

test('admin prints paid QR tickets but not pending orders and does not expose manual edit on online orders', async () => {
  const paid = order('paid'); paid.paymentMethod = 'cash';
  const h = await harness({ orders: [paid] });
  const print = h.select('[data-oprint]')[0]; assert.ok(print); print.onclick();
  assert.equal(h.prints, 1); assert.match(h.elements.printArea.innerHTML, /<svg>/);
  assert.match(h.elements.printArea.innerHTML, /checkin/);
  assert.match(h.html, /bar bezahlt/i);
  const online = order(); online.source = undefined;
  const p = await harness({ orders: [online] });
  assert.equal(p.select('[data-oprint]').length, 0);
  assert.equal(p.select('[data-bo-edit]').length, 0);
  assert.match(p.html, /id="ciCode"[^>]*maxlength="32"/);
});

test('admin separately edits ticket holder names without changing contact data', async () => {
  const h = await harness({ orders: [order()] });
  const edit = h.select('[data-bo-holders]')[0]; assert.ok(edit); await edit.onclick(); await h.flush();
  assert.equal(h.elements.bo_ticket_t1.value, 'Nick');
  h.elements.bo_ticket_t1.value = 'New nickname';
  await h.elements.boHoldersForm.onsubmit({ preventDefault() {} }); await h.flush();
  const put = h.calls.find((c) => c.method === 'PUT');
  assert.equal(put.url, '/tickets/orders/o1/holders');
  assert.deepEqual(put.body, { holders: { t1: 'New nickname' } });
});
