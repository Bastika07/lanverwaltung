'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Small identity-preserving DOM: render real HTML, move existing nodes on appendChild.
class Node {
  constructor(tag = '', attrs = {}) { this.tag = tag; this.attrs = attrs; this.children = []; this.dataset = {}; this.value = attrs.value || ''; this.disabled = 'disabled' in attrs;
    for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  appendChild(n) { if (n.parentElement) n.parentElement.children.splice(n.parentElement.children.indexOf(n), 1); n.parentElement = this; this.children.push(n); return n; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  matches(s) { const m = s.match(/^([\w-]+)?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/); return !!m && (!m[1] || m[1] === this.tag) && (!m[2] || Object.hasOwn(this.attrs, m[2]) && (m[3] === undefined || this.attrs[m[2]] === m[3])); }
  querySelectorAll(s) { return this.children.flatMap((n) => [...(s.split(',').some((x) => n.matches(x.trim())) ? [n] : []), ...n.querySelectorAll(s)]); }
  querySelector(s) { return this.querySelectorAll(s)[0] || null; }
  set innerHTML(html) {
    this.html = html; this.children = []; const stack = [this];
    for (const m of html.matchAll(/<\/?[a-z][^>]*>|[^<]+/gi)) {
      const t = m[0]; if (!t.startsWith('<')) { stack.at(-1).textContent = (stack.at(-1).textContent || '') + decode(t); continue; }
      if (t.startsWith('</')) { stack.pop(); continue; }
      const tag = t.match(/^<([\w-]+)/)[1];
      const attrs = Object.fromEntries([...t.slice(tag.length + 1, -1).matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((a) => [a[1], decode(a[2] || '')]));
      const n = stack.at(-1).appendChild(new Node(tag, attrs));
      if (!['input', 'hr', 'br'].includes(tag)) stack.push(n);
    }
    for (const s of this.querySelectorAll('select')) {
      const opts = s.querySelectorAll('option'); s.selectedOptions = opts.filter((o) => Object.hasOwn(o.attrs, 'selected'));
      s.value = (s.selectedOptions[0] || opts[0])?.attrs.value || '';
      Object.defineProperty(s, 'selectedIndex', { get: () => opts.findIndex((o) => o.attrs.value === s.value) });
      Object.defineProperty(s, 'options', { get: () => opts });
    }
  }
  get innerHTML() { return this.html; }
}
const person = (id, name, count = 0, extra = {}) => ({ id, name, events: Array.from({ length: count }, (_, i) => ({ name: `Event ${i}` })), checkedIn: 0, steam: '', note: '', ...extra });
async function harness(persons, options = {}) {
  const app = new Node(), calls = []; let active = 'personen', redraws = 0;
  const document = { getElementById: (id) => id === 'app' ? app : app.querySelectorAll('[id]').find((n) => n.attrs.id === id) };
  const ctx = vm.createContext({ document, views: {}, adminViews: {}, beamerSlides: [], esc, toast() {}, confirm: () => true,
    on: () => options.seating !== false, adminTabs: () => '', adminEvent: () => ({ name: 'Test' }), state: {},
    api: async (method, url, body) => { calls.push({ method, url, body }); if (method !== 'GET') return options.write?.(body);
      if (url === '/persons') return persons;
      if (url === '/people') return { people: options.people || persons, seating: { seats: [{ id: 'z', label: 'A2' }, { id: 'a', label: 'A10' }] } };
      if (url.endsWith('/ticket-accounts')) return { person: persons[0], targets: [{ kind: 'account', id: 'test', relationship: 'own', version: 'v1', profile: { city: 'Town' } }] };
      throw new Error(url);
    }, render: () => { redraws++; return ctx.adminViews[active].render(); } });
  vm.runInContext(fs.readFileSync(require.resolve('../public/people.js'), 'utf8'), ctx);
  const h = { app, calls, ctx, document, get redraws() { return redraws; },
    async show(view = active) { active = view; await ctx.adminViews[view].render(); },
    table: () => app.querySelector('table'), rows: () => app.querySelector('tbody').children,
    ids: () => h.rows().map((r) => r.dataset.pid || r.dataset.id),
    button: (key) => h.table().querySelector(`[data-sort="${key}"]`),
    click(key) { const b = h.button(key); assert.ok(b, `sortable ${key} header exists`); assert.equal(b.tag, 'button'); assert.equal(b.attrs.type, 'button'); b.onclick(); },
  }; await h.show(); return h;
}

test('persons: columns sort numbers, empty-last and live edits with deterministic ties and remembered direction', async () => {
  const h = await harness([person('b', 'Same', 10, { checkedIn: 10 }), person('a', 'same', 2, { checkedIn: 2 }), person('c', 'Zed', 0)]);
  for (const key of ['events', 'checkedIn']) {
    // Events starts descending; first select a different column so the new key starts ascending.
    h.click('name'); h.click(key); assert.deepEqual(h.ids(), ['c', 'a', 'b']);
    h.click(key); assert.deepEqual(h.ids(), ['b', 'a', 'c']);
  }
  for (const key of ['clan', 'steam', 'note']) {
    const rows = Object.fromEntries(h.rows().map((r) => [r.dataset.pid, r]));
    rows.a.querySelector(`[data-k="${key}"]`).value = 'Ä2'; rows.b.querySelector(`[data-k="${key}"]`).value = 'a10'; rows.c.querySelector(`[data-k="${key}"]`).value = '  ';
    h.click(key); assert.deepEqual(h.ids(), ['a', 'b', 'c']); h.click(key); assert.deepEqual(h.ids(), ['b', 'a', 'c']);
  }
  h.click('discordName'); assert.deepEqual(h.ids(), ['a', 'b', 'c']); h.click('discordName'); assert.deepEqual(h.ids(), ['a', 'b', 'c']);
  assert.equal(h.table().querySelectorAll('th').filter((n) => n.getAttribute('aria-sort')).length, 1);
  await h.show(); assert.equal(h.button('discordName').parentElement.getAttribute('aria-sort'), 'descending');
});

test('sorting never replaces contact drafts, busy/error/committed forms or bypasses duplicate-save guards', async () => {
  let finish, fail = true, blockRefresh = false, refresh;
  const h = await harness([person('b', 'Zed'), person('a', 'Anna')], { write: () => new Promise((resolve, reject) => { finish = () => fail ? reject(new Error('Conflict')) : resolve({}); }) });
  await h.app.querySelector('[data-ticket-account]').onclick();
  const form = h.document.getElementById('personAccountForm'), city = h.document.getElementById('pa_city'); city.value = 'Draft';
  h.click('name'); assert.equal(h.document.getElementById('personAccountForm'), form); assert.equal(city.value, 'Draft');
  let saving = form.onsubmit({ preventDefault() {} }); let calls = h.calls.length;
  h.click('name'); await form.onsubmit({ preventDefault() {} });
  assert.equal(h.calls.length, calls); assert.ok(form.querySelectorAll('input, select, button').every((n) => n.disabled));
  finish(); await saving; h.click('clan');
  assert.equal(h.document.getElementById('pa_error').textContent, 'Conflict'); assert.equal(city.value, 'Draft');
  assert.ok(form.querySelectorAll('input, select, button').every((n) => !n.disabled));
  const api = h.ctx.api;
  h.ctx.api = (method, url, body) => blockRefresh && method === 'GET' && url === '/persons' ? new Promise((r) => { refresh = r; }) : api(method, url, body);
  fail = false; saving = form.onsubmit({ preventDefault() {} }); blockRefresh = true; finish(); await new Promise(setImmediate);
  calls = h.calls.length; h.click('name'); await form.onsubmit({ preventDefault() {} });
  assert.equal(h.calls.length, calls); assert.equal(h.document.getElementById('personAccountForm'), form);
  assert.ok(form.querySelectorAll('input, select, button').every((n) => n.disabled));
  refresh([person('b', 'Zed'), person('a', 'Anna')]); await saving;
});

test('participants: independent remembered sorting preserves add drafts and pending row saves, sorting seats by labels', async () => {
  let release;
  const persons = [person('b', 'Zed', 9, { seat: 'z', discordName: 'User2' }), person('a', 'Anna', 1, { seat: 'a', discordName: 'user10' }), person('c', 'Empty', 0)];
  const h = await harness(persons.concat(person('known', 'Known')), { people: persons.slice(), write: () => new Promise((r) => { release = r; }) });
  h.click('checkedIn'); h.click('checkedIn');
  await h.show('teilnehmer'); assert.deepEqual(h.ids(), ['a', 'c', 'b']);
  const names = h.document.getElementById('pNames'); names.value = 'Unsaved\nNames';
  const known = h.document.getElementById('pKnownSel'); known.selectedOptions = [known.options[0]];
  const rows = h.rows().slice(), note = rows[0].querySelector('[data-k="note"]'); note.value = 'Pending';
  const saving = note.onchange(), calls = h.calls.length;
  h.click('seat'); assert.deepEqual(h.ids(), ['b', 'a', 'c']); h.click('seat'); assert.deepEqual(h.ids(), ['a', 'b', 'c']);
  const seats = Object.fromEntries(h.rows().map((r) => [r.dataset.id, r.querySelector('[data-k="seat"]')]));
  seats.a.value = 'z'; seats.b.value = 'a'; h.click('seat'); assert.deepEqual(h.ids(), ['a', 'b', 'c']);
  h.click('discordName'); assert.deepEqual(h.ids(), ['b', 'a', 'c']); h.click('discordName'); assert.deepEqual(h.ids(), ['a', 'b', 'c']);
  for (const key of ['name', 'clan', 'steam', 'note']) { h.click(key); h.click(key); }
  assert.equal(h.document.getElementById('pKnownSel'), known); assert.equal(known.selectedOptions[0].value, 'known');
  assert.equal(h.document.getElementById('pNames'), names); assert.equal(names.value, 'Unsaved\nNames');
  assert.ok(h.rows().every((r) => rows.includes(r))); assert.equal(note.value, 'Pending'); assert.equal(h.calls.length, calls); assert.equal(h.redraws, 0);
  release({}); await saving;
  await h.show('personen'); assert.equal(h.button('checkedIn').parentElement.getAttribute('aria-sort'), 'descending');
  await h.show('teilnehmer'); assert.equal(h.button('note').parentElement.getAttribute('aria-sort'), 'descending');
  const noSeats = await harness(persons, { seating: false }); await noSeats.show('teilnehmer'); assert.equal(noSeats.button('seat'), null);
});

test('persons: accessible headers toggle natural name sorting by moving existing rows without requests', async () => {
  const persons = [person('ten', 'Zehn10', 10), person('two', 'Änne2', 2), person('one', 'anne1', 2)];
  const original = structuredClone(persons), h = await harness(persons);
  assert.deepEqual(h.ids(), ['ten', 'one', 'two']);
  const rows = h.rows().slice(), calls = h.calls.length;
  h.click('name'); assert.deepEqual(h.ids(), ['one', 'two', 'ten']);
  assert.equal(h.button('name').parentElement.getAttribute('aria-sort'), 'ascending');
  assert.match(h.button('name').getAttribute('aria-label'), /Name.*absteigend/); assert.match(h.button('name').textContent, /▲/);
  h.click('name'); assert.deepEqual(h.ids(), ['ten', 'two', 'one']);
  assert.equal(h.button('name').parentElement.getAttribute('aria-sort'), 'descending');
  assert.match(h.button('name').getAttribute('aria-label'), /aufsteigend/); assert.match(h.button('name').textContent, /▼/);
  assert.ok(h.rows().every((r) => rows.includes(r))); assert.equal(h.calls.length, calls); assert.equal(h.redraws, 0);
  assert.deepEqual(persons, original);
});
