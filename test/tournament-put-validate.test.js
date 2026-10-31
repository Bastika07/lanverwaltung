'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isolated } = require('../test-support/isolated.cjs');

test('Turnier bearbeiten: abgelehnte Anfrage ändert weder Name noch Spiel', async (t) => {
  const app = await isolated(t);
  for (const body of [{ name: 'Geändert', game: 'Neu', participants: ['buyer', 'other', 'dritter'] }, { name: 'Geändert', game: { x: 1 } }, { name: '', game: 'Neu' }]) {
    const r = await app.request('/api/tournaments/match', { method: 'PUT', admin: true, body });
    assert.equal(r.status, 400, JSON.stringify(body));
    // unabhängige speichernde Aktion
    assert.equal((await app.request('/api/tickets/settings', { method: 'PUT', admin: true, body: { payDays: 14 } })).status, 200);
    for (const e of app.snapshot().events) {
      const m = e.tournaments.find((x) => x.id === 'match');
      assert.equal(m.name, 'Match', JSON.stringify(body));
      assert.ok(!m.game);
      assert.deepEqual([...m.participants], ['buyer', 'other']);
    }
  }
  // Gegenprobe: gültige Anfrage wirkt wie bisher
  assert.equal((await app.request('/api/tournaments/match', { method: 'PUT', admin: true, body: { name: 'Geändert', game: 'Neu' } })).status, 200);
  const m = app.snapshot().events.find((e) => e.id === 'first').tournaments.find((x) => x.id === 'match');
  assert.deepEqual([m.name, m.game], ['Geändert', 'Neu']);
});
