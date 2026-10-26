'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function frontend() {
  const root = path.resolve(__dirname, '../public'), listeners = {};
  const elements = {}, previews = [];
  const context = vm.createContext({
    views: {}, adminViews: {}, homeCards: [], beamerSlides: [], startHooks: [], liveHandlers: [],
    state: { settings: { modules: {} } },
    document: {
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      getElementById(id) { return elements[id]; },
      querySelectorAll() { return previews; },
    },
  });
  const encoder = fs.readFileSync(path.join(root, 'app.js'), 'utf8').split('\n').find((line) => line.startsWith('const esc ='));
  vm.runInContext(encoder, context);
  for (const file of ['vendor/marked.umd.js', 'markdown.js', 'info.js', 'details.js', 'schedule.js', 'tickets.js', 'catering.js', 'website.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  return { context, listeners, elements, previews, ...vm.runInContext('({ markdown, markdownHelp, richText, websiteText, wifiBlock, serverTable, detailsHtml, schedItem, cateringOffer, profileForm, listEditor })', context) };
}

test('markdown: headings, emphasis, lists, quotes, code, tables and existing line breaks', () => {
  const { markdown } = frontend();
  const html = markdown('## Infos\n\n**fett** *kursiv* ~~alt~~\nzweite Zeile\n\n- Kabel\n- PC\n  - Maus\n\n1. Anmelden\n2. Aufbauen\n\n> Hinweis\n\n`<code>`\n\n```html\n<script>alert(1)</script>\n```\n\n| Zeit | Titel |\n| --- | --- |\n| 18:00 | Start |');
  for (const expected of ['<h2>Infos</h2>', '<strong>fett</strong>', '<em>kursiv</em>', '<del>alt</del>', '<br>', '<ul>', '<ol>', '<blockquote>', '<code>&lt;code&gt;</code>', '<pre>', '&lt;script&gt;', '<table>', '<td>18:00</td>']) assert.ok(html.includes(expected), expected);
  assert.equal((html.match(/<ul>/g) || []).length, 2, 'nested lists');
  assert.equal(markdown(null), '');
  assert.match(markdown('eins\nzwei'), /eins<br>\s*zwei/);
  assert.match(markdown('\\*literal\\*'), /\*literal\*/);
});

test('markdown: safe explicit, automatic and reference links preserve attributes safely', () => {
  const { markdown } = frontend();
  for (const source of ['[Website](https://example.org/?a=1&b=2 "Titel")', 'https://example.org', '[Mail](mailto:orga@example.org)', '[Infos](#/infos)', '[Website][ref]\n\n[ref]: https://example.org']) {
    const html = markdown(source);
    assert.match(html, /<a href="(?:https:\/\/|mailto:|#)/);
    assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  }
  assert.match(markdown('[Website](https://example.org/?a=1&b=2 "Titel")'), /title="Titel"/);
  const hostileTitle = markdown('[Link](https://example.org/ "&quot; onclick=&quot;alert(1)")');
  assert.ok(!/title="[^"]*"\s+onclick=/.test(hostileTitle), hostileTitle);
});

test('markdown: raw HTML, obfuscated dangerous URLs and images never become active content', () => {
  const { markdown } = frontend();
  const sources = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<iframe src="https://tracker.invalid"></iframe>',
    '<svg><a xlink:href="javascript:alert(1)">x</a></svg>', '<style>body{display:none}</style>',
    '[x](javascript:alert%281%29)', '[x](JaVaScRiPt:alert%281%29)', '[x](data:text/html,test)',
    '[x](vbscript:msgbox)', '[x](//tracker.invalid)', '[x](javascript&#58;alert%281%29)',
    '[x](&#106;avascript:alert%281%29)', '[x](java&#x09;script:alert%281%29)',
    '[x][ref]\n\n[ref]: javascript:alert%281%29',
    '![Logo](https://tracker.invalid/pixel)', '![<img src=x onerror=alert(1)>](https://tracker.invalid/pixel)',
    '[![Logo](https://tracker.invalid/pixel)](javascript:alert%281%29)',
    '&lt;img src=x onerror=alert(1)&gt;',
  ];
  for (const source of sources) {
    const html = markdown(source);
    assert.ok(!/<(?:script|img|iframe|svg|style|object|embed)\b/i.test(html), html);
    assert.ok(!/\b(?:src|onerror|onclick|onload)="/i.test(html), html);
    assert.ok(!html.includes('<a '), html);
  }
  assert.match(markdown('![Logo](https://tracker.invalid/pixel)'), /Logo/);
});

test('markdown: public info, event, programme, ticket privacy, catering and website builders share formatting', () => {
  const f = frontend(), text = '**Wichtig**\n\n- Kabel';
  const html = [
    f.richText(text), f.websiteText(text),
    f.wifiBlock({ wifi: { ssid: 'LAN', note: text } }),
    f.serverTable({ servers: [{ name: 'Server', address: '10.0.0.1', note: text }] }),
    f.detailsHtml({ event: { name: 'LAN' }, details: { text }, tickets: [{ name: 'Ticket', description: text, price: 0 }] }),
    f.schedItem({ title: 'Start', start: '2020-01-01T00:00:00Z', note: text }),
    f.profileForm({}, text),
    f.cateringOffer({ id: 'offer', title: 'Essen', description: text, price: 0 }, { entries: [], guests: [] }),
  ];
  for (const result of html) {
    assert.ok(result.includes('<strong>Wichtig</strong>'), result);
    assert.ok(result.includes('<li>Kabel</li>'), result);
    assert.ok(!/<p[^>]*>\s*<(?:p|div|ul|h\d)\b/.test(result), 'no block elements wrapped in a paragraph');
  }
});

test('markdown: preview is local, uses the public renderer and updates only when open', () => {
  const f = frontend(), preview = { innerHTML: '' };
  const details = { open: false, dataset: { markdownFor: 'text' }, matches: () => true, querySelector: () => preview };
  f.elements.text = { id: 'text', value: '**Vorschau**' };
  f.previews.push(details);
  f.listeners.toggle[0]({ target: details });
  assert.equal(preview.innerHTML, '');
  details.open = true;
  f.listeners.toggle[0]({ target: details });
  assert.equal(preview.innerHTML, f.markdown(f.elements.text.value));
  f.elements.text.value = '<script>alert(1)</script>';
  f.listeners.input[0]({ target: f.elements.text });
  assert.equal(preview.innerHTML, f.markdown(f.elements.text.value));
  assert.ok(!preview.innerHTML.includes('<script>'));
  assert.ok(f.markdownHelp('text').includes('data-markdown-for="text"'));
});

test('markdown: list notes support multiple lines and new rows get unique preview targets', () => {
  const f = frontend();
  const html = f.listEditor('games', [{ name: 'Spiel', note: '**Mods**\n- A' }, { name: 'Anderes', note: 'B' }], [{ key: 'name', label: 'Spiel' }, { key: 'note', label: 'Hinweis' }]);
  assert.match(html, /<textarea[^>]+data-f="note"/);
  assert.ok(html.includes('**Mods**\n- A'));
  const ids = [...html.matchAll(/<textarea id="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);
  assert.ok(html.includes('LIST_ROW_ID'), 'new row template has a replaceable preview target');
});
