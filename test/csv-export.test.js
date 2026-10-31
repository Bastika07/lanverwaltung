'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cell, csv } = require('../lib/csv');
const { isolated } = require('../test-support/isolated.cjs');

// Wie Tabellenkalkulationen lesen: außerhalb von Anführungszeichen beendet jedes \r oder \n den Datensatz.
function records(text) {
  const out = [[]];
  let field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ';') { out.at(-1).push(field); field = ''; } else if (c === '\r' || c === '\n') {
      out.at(-1).push(field); field = '';
      if (c === '\r' && text[i + 1] === '\n') i++;
      out.push([]);
    } else field += c;
  }
  out.at(-1).push(field);
  return out;
}
const formula = (v) => /(^|[\r\n])[=+\-@\t]/.test(v);

test('csv: Zeilenumbrüche bleiben im Feld, Formelzeichen werden je Zeile entschärft', () => {
  for (const value of ['Max\r=HYPERLINK(1)', 'a\nb', 'a\r\n+1', '=1+1', '@SUM(A1)', '\r-2', 'normal', 'Semi;kolon "Zitat"']) {
    const rows = records(csv([[value, 'x'], ['y', 'z']]).slice(1));
    assert.equal(rows.length, 2, JSON.stringify(value));
    assert.equal(rows[0][1], 'x');
    assert.equal(formula(rows[0][0]), false, JSON.stringify(rows[0][0]));
  }
  assert.equal(cell('normal'), 'normal');
  assert.equal(cell('Semi;kolon "Zitat"'), '"Semi;kolon ""Zitat"""');
  assert.equal(cell('Max\r=X'), '"Max\r\'=X"');
  assert.equal(cell(null), '');
  assert.ok(csv([['a']]).startsWith('﻿'));
});

test('csv: Ticket- und Gastserver-Export erzeugen keine zusätzlichen Datensätze', async (t) => {
  const app = await isolated(t);
  const hostile = 'Synthetic\r=HYPERLINK("http://example.invalid")';
  const rename = await app.request('/api/tickets/orders/first-buyer/holders', { method: 'PUT', user: 'buyer', body: { holders: { 'first-ticket-buyer': hostile } } });
  assert.equal(rename.status, 200, JSON.stringify(rename.data));
  const server = await app.request('/api/servers', { method: 'POST', user: 'buyer', body: { name: 'csvbox', description: 'Spiel\r@SUM(1)', reverse: false } });
  assert.equal(server.status, 201, JSON.stringify(server.data));

  for (const url of ['/api/tickets/export.csv', '/api/servers/export.csv']) {
    const rows = records((await app.request(url, { admin: true })).text.replace(/^﻿/, ''));
    const width = rows[0].length;
    for (const row of rows) {
      assert.equal(row.length, width, `${url}: ${JSON.stringify(row)}`);
      for (const value of row) assert.equal(formula(value), false, `${url}: ${JSON.stringify(value)}`);
    }
  }
  const tickets = records((await app.request('/api/tickets/export.csv', { admin: true })).text.replace(/^﻿/, ''));
  assert.ok(tickets.some((row) => row.includes('Synthetic\r\'=HYPERLINK("http://example.invalid")')));
});
