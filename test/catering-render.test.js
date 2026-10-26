'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('catering: real offer/entry builders escape guest/admin text and expose payment controls only for admin', () => {
  const root = path.resolve(__dirname, '../public');
  const context = vm.createContext({ views: {}, adminViews: {}, document: { addEventListener() {} } });
  const encoder = fs.readFileSync(path.join(root, 'app.js'), 'utf8').split('\n').find((line) => line.startsWith('const esc ='));
  vm.runInContext(encoder, context);
  for (const file of ['vendor/marked.umd.js', 'markdown.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'catering.js'), 'utf8'), context);
  const { cateringOffer, cateringEntries } = vm.runInContext('({ cateringOffer, cateringEntries })', context);
  const hostile = '"><img src=x onerror=alert(1)><script>alert(1)</script>';
  const offer = { id: 'offer', title: hostile, description: hostile, price: 1234, capacity: 0, open: true, available: true, registered: 0 };
  const data = { offers: [offer], entries: [{ id: 'entry', offerId: 'offer', guestKey: 'guest', name: hostile, price: 1234, paidAt: null }], guests: [{ key: hostile, name: hostile }], loggedIn: true, over: false };
  for (const html of [cateringOffer(offer, data), cateringEntries(data), cateringEntries(data, true)]) {
    assert.ok(!/<(?:img|script)\b/i.test(html), html); assert.ok(html.includes('&lt;'));
  }
  assert.ok(!cateringEntries(data).includes('data-catering-payment'));
  assert.ok(cateringEntries(data, true).includes('data-catering-payment'));
  data.entries[0].paidAt = '2026-10-24T00:00:00Z';
  assert.ok(!cateringEntries(data).includes('data-catering-cancel'));
  assert.ok(!cateringEntries(data, true).includes('data-catering-cancel'));
});
