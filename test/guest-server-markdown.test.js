'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../public');
const HOSTILE = [
  '<b style="position:fixed;inset:0">Overlay</b>',
  '<style>body{display:none}</style>',
  '<button class="small" data-gsblock="victim" data-blocked="0">Sperren</button>',
  '<img src=x onerror=alert(1)>',
  '- [ ] <div style="color:red">Liste</div>',
  '| <a href="javascript:alert(1)">x</a> |\n|---|\n| y |',
].join('\n\n');
const FORMATTED = '## CS2\n\n**5v5** mit *Passwort*\n\n- Map: Mirage\n- [Regeln](https://example.org/regeln)';

function frontend({ data, buttons = [] }) {
  const app = { innerHTML: '', querySelectorAll: (selector) => buttons.filter((b) => selector === `button[${b.attr}]`) };
  const forms = { gscForm: {} };
  const context = vm.createContext({
    views: {}, adminViews: {}, state: {}, render() {}, toast() {}, confirm: () => true,
    adminTabs: () => '', copyBtn: () => '', api: async () => data,
    document: { addEventListener() {}, getElementById: (id) => (id === 'app' ? app : forms[id] || null) },
  });
  const encoder = fs.readFileSync(path.join(root, 'app.js'), 'utf8').split('\n').find((line) => line.startsWith('const esc ='));
  vm.runInContext(encoder, context);
  for (const file of ['vendor/marked.umd.js', 'markdown.js', 'servers.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  return { context, app, views: context.views, adminViews: context.adminViews, markdown: vm.runInContext('markdown', context) };
}

const server = (id, description, extra = {}) => ({ id, name: id, fqdn: `${id}.gast.lan`, ip: '10.10.50.10', description,
  owner: 'Synthetic', reverse: false, blocked: false, createdAt: '2026-10-31T10:00:00Z', ...extra });
const publicData = () => ({ loggedIn: true, member: true, open: false, domain: 'gast.lan', maxPerAccount: 2, free: '10.10.50.11',
  event: { id: 'e', name: 'Synthetic LAN' }, mine: [server('mine', HOSTILE)], servers: [server('evil', HOSTILE), server('ok', FORMATTED)] });
const adminData = () => ({ config: { domain: 'gast.lan', ipFrom: '10.10.50.10', ipTo: '10.10.50.12', maxPerAccount: 2, open: true },
  free: '10.10.50.11', event: { id: 'e', name: 'Synthetic LAN' }, servers: [server('evil', HOSTILE), server('ok', FORMATTED)] });

// Nur die Beschreibungsblöcke prüfen: dort darf ausschließlich Markdown-Markup entstehen.
function descriptionTags(html) {
  return [...html.matchAll(/<div class="meta markdown">([\s\S]*?)<\/div>(?=<div|<\/td>)/g)]
    .flatMap(([, block]) => [...block.matchAll(/<\/?([a-z][\w-]*)([^>]*)>/gi)].map(([tag, name, attrs]) => ({ tag, name: name.toLowerCase(), attrs })));
}
const ALLOWED = new Set(['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
  'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'a', 'input']);

function assertSafeDescriptions(html) {
  const tags = descriptionTags(html);
  assert.ok(tags.length > 0, 'descriptions must be rendered');
  for (const { tag, name, attrs } of tags) {
    assert.ok(ALLOWED.has(name), `unexpected element ${tag}`);
    assert.doesNotMatch(attrs, /\b(?:style|on\w+|data-[\w-]+|class)=/i, tag);
    if (name === 'a' && !tag.startsWith('</')) assert.match(attrs, /^ href="https:\/\/example\.org\/regeln" target="_blank" rel="noopener noreferrer"$/);
  }
  for (const raw of ['<b style', '<style>', '<button class="small" data-gsblock="victim"', '<img', '<div style="color:red"', 'javascript:alert(1)">']) {
    assert.ok(!html.includes(raw), `raw markup leaked: ${raw}`);
  }
  for (const text of ['&lt;b style=&quot;position:fixed;inset:0&quot;&gt;Overlay', '&lt;style&gt;', 'data-gsblock=&quot;victim&quot;']) {
    assert.ok(html.includes(text), `hostile markup stays visible as text: ${text}`);
  }
  for (const formatted of ['<h2>CS2</h2>', '<strong>5v5</strong>', '<em>Passwort</em>', '<li>Map: Mirage</li>']) {
    assert.ok(html.includes(formatted), `allowed Markdown preserved: ${formatted}`);
  }
}

test('guest servers: public view renders descriptions only as safe Markdown', async () => {
  const { views, app } = frontend({ data: publicData() });
  await views.server.render();
  assertSafeDescriptions(app.innerHTML);
});

test('guest servers: admin view renders descriptions only as safe Markdown', async () => {
  const { adminViews, app } = frontend({ data: adminData() });
  await adminViews.server.render();
  assertSafeDescriptions(app.innerHTML);
});

test('guest servers: admin and owner actions bind only to trusted buttons outside descriptions', async () => {
  const button = (attr, insideDescription) => ({ attr, dataset: {}, closest: (selector) => (selector === '.markdown' && insideDescription ? {} : null) });
  for (const [view, data, attrs] of [['adminViews', adminData(), ['data-gsblock', 'data-gsdel']], ['views', publicData(), ['data-gsdel']]]) {
    const buttons = attrs.flatMap((attr) => [button(attr, false), button(attr, true)]);
    const ui = frontend({ data, buttons });
    await ui[view].server.render();
    for (const b of buttons) assert.equal(typeof b.onclick, b.closest('.markdown') ? 'undefined' : 'function', `${view} ${b.attr}`);
  }
});

test('markdown: final HTML is sanitized even if the parser emitted raw markup', () => {
  const { context, markdown } = frontend({ data: {} });
  vm.runInContext(`markdownParser.parse = () => '<p onclick="x">a</p><div style="color:red">b</div><a href="javascript:x">c</a>'
    + '<script>x</script><button data-gsdel="1">d</button><strong>ok</strong><a href="https://example.org" target="_blank" rel="noopener noreferrer">e</a><b';`, context);
  const html = markdown('ignored');
  // Unpassende schließende Tags sind harmlos; aktive Attribute und fremde Elemente bleiben Text.
  assert.equal(html, '&lt;p onclick=&quot;x&quot;&gt;a</p>&lt;div style=&quot;color:red&quot;&gt;b&lt;/div&gt;'
    + '&lt;a href=&quot;javascript:x&quot;&gt;c</a>&lt;script&gt;x&lt;/script&gt;&lt;button data-gsdel=&quot;1&quot;&gt;d&lt;/button&gt;'
    + '<strong>ok</strong><a href="https://example.org" target="_blank" rel="noopener noreferrer">e</a>&lt;b');
});
