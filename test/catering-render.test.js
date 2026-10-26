'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('catering: admin price propagation is opt-in and sent only when editing', async () => {
  const root = path.resolve(__dirname, '../public');
  const offer = { id: 'offer', title: 'Buffet', description: '', price: 1250, capacity: 0, open: true, version: 1 };
  for (const editing of [false, true]) {
    for (const checked of [false, true]) {
      const calls = [], elements = {};
      const app = { innerHTML: '', querySelectorAll() { return []; } };
      const fields = { title: { value: 'Buffet' }, description: { value: '' }, price: { value: '20.00' },
        capacity: { value: '0' }, servingAt: { value: '' }, deadline: { value: '' }, open: { checked: true },
        updateUnpaidPrices: { checked } };
      const button = {};
      elements.app = app;
      elements.cateringOfferForm = { elements: fields, querySelector() { return button; } };
      elements.cFilter = {}; elements.cEntries = {}; elements.cOfferError = {};
      const context = vm.createContext({ views: {}, adminViews: {}, location: {},
        document: { getElementById(id) { return elements[id]; } },
        async api(method, url, body) {
          if (method === 'GET') return { offers: [offer], entries: [], guests: [] };
          calls.push({ method, url, body });
        }, adminTabs: () => '', markdownHelp: () => '', toLocalInput: () => '', toast() {}, async render() {},
      });
      const encoder = fs.readFileSync(path.join(root, 'app.js'), 'utf8').split('\n').find((line) => line.startsWith('const esc ='));
      vm.runInContext(encoder, context);
      vm.runInContext(fs.readFileSync(path.join(root, 'catering.js'), 'utf8'), context);
      await context.adminViews.catering.render(editing ? offer.id : undefined);
      if (editing) {
        assert.match(app.innerHTML, /<input[^>]*name="updateUnpaidPrices"[^>]*type="checkbox"[^>]*>/);
        const checkbox = app.innerHTML.match(/<input[^>]*name="updateUnpaidPrices"[^>]*>/)[0];
        assert.ok(!checkbox.includes('checked'), 'price propagation must default to off');
      } else assert.ok(!app.innerHTML.includes('name="updateUnpaidPrices"'));
      await elements.cateringOfferForm.onsubmit({ preventDefault() {}, target: elements.cateringOfferForm });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, editing ? 'PUT' : 'POST');
      assert.equal(calls[0].body.price, 2000);
      assert.equal(calls[0].body.updateUnpaidPrices, editing ? checked : undefined);
    }
  }
});

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
