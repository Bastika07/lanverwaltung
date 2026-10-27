'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('assessment: actual frontend encoders and selected HTML builders escape hostile text and URL schemes', () => {
  // Execute repository-owned functions, not copied encoders. This is not a browser or full DOM-XSS test.
  const publicDir = path.resolve(__dirname, '../public');
  const context = vm.createContext({ URL, views: {}, adminViews: {}, homeCards: [], beamerSlides: [], startHooks: [], liveHandlers: [],
    document: { addEventListener() {} } });
  const encoder = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8').split('\n').find((line) => line.startsWith('const esc ='));
  assert.ok(encoder);
  vm.runInContext(encoder, context);
  for (const file of ['vendor/marked.umd.js', 'markdown.js', 'info.js', 'people.js', 'website.js']) vm.runInContext(fs.readFileSync(path.join(publicDir, file), 'utf8'), context, { filename: file });
  const helpers = vm.runInContext('({esc,richText,websiteText,sponsorCards,steamUrl,safeUrl,sponsorUrl,seatMap})', context);
  for (const value of ['<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>', "'><script>alert(1)</script>", '&quot; onmouseover=alert(1)', 'https://example.invalid/" onclick="alert(1)']) {
    for (const html of [helpers.esc(value), helpers.richText(value), helpers.websiteText(value), helpers.sponsorCards([{ name: value, description: value, tier: value, url: 'javascript:alert(1)' }]),
      helpers.seatMap({ people: [{ id: 'person', name: value, clan: value, seat: '1111111111' }], seating: { cols: 1, rows: 1, areas: [], categories: [], seats: [{ id: '1111111111', x: 0, y: 0, label: value }] } })]) {
      assert.ok(!/<(?:img|svg|script)\b/i.test(html), html);
      assert.ok(!/href="javascript:/i.test(html));
    }
  }
  for (const value of ['javascript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,test', 'JaVaScRiPt:alert(1)', '//example.invalid', ' https://example.invalid']) {
    assert.equal(helpers.safeUrl(value), null);
  }
  for (const value of ['javascript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,test', 'JaVaScRiPt:alert(1)', 'http://example.invalid', 'ftp://example.invalid', '//example.invalid', 'https://user:password@example.invalid', 'https://user@example.invalid', 'https://:password@example.invalid', '', 'not a URL']) {
    assert.equal(helpers.sponsorUrl(value), '');
  }
  assert.equal(helpers.sponsorUrl('https://example.invalid/sponsor'), 'https://example.invalid/sponsor');
  assert.equal(helpers.steamUrl('javascript:alert(1)'), null);
});
