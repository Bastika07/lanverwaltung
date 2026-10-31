'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isolated } = require('../test-support/isolated.cjs');

// Eine abgelehnte Anfrage darf nichts ändern – auch nicht im Arbeitsspeicher, den die nächste Speicherung übernähme.
async function rejectedThenSaved(app, url, body, status = 400) {
  const r = await app.request(url, { method: 'PUT', admin: true, body });
  assert.equal(r.status, status, JSON.stringify(r.data));
  // unabhängige speichernde Aktion
  assert.equal((await app.request('/api/tickets/settings', { method: 'PUT', admin: true, body: { payDays: 14 } })).status, 200);
  return app.snapshot();
}

test('Ticketeinstellungen: ungültige Bankdaten schließen den Verkauf nicht', async (t) => {
  const app = await isolated(t);
  const before = (await app.request('/api/tickets/settings', { method: 'PUT', admin: true, body: {} }), app.snapshot());
  const db = await rejectedThenSaved(app, '/api/tickets/settings', { saleOpen: false, requireMember: true, bank: { iban: 'ungueltig' } });
  for (const e of db.events) assert.equal(e.sale.saleOpen, true, e.id);
  assert.equal(db.meta.ticketSettings.requireMember, false);
  assert.deepEqual(db.meta.ticketSettings.bank, before.meta.ticketSettings.bank);
});

test('Personen: unbekannter Platz oder ungültige Felder lassen Name und Turniereinträge unverändert', async (t) => {
  const app = await isolated(t);
  for (const body of [{ name: 'Umbenannt', note: 'neu', seat: 'gibtesnicht' }, { name: 'Umbenannt', steam: 'javascript:alert(1)' }, { name: 'Umbenannt', discordId: 'abc' }]) {
    const db = await rejectedThenSaved(app, '/api/people/buyer', body);
    const p = db.persons.find((x) => x.id === 'buyer');
    assert.equal(p.name, 'buyer', JSON.stringify(body));
    assert.ok(!p.note);
    for (const e of db.events) assert.deepEqual([...e.tournaments[0].participants], ['buyer', 'other']);
  }
  // fremdes Discord-Konto: 409 ohne Teiländerung
  const db = await rejectedThenSaved(app, '/api/people/buyer', { name: 'Umbenannt', discordId: '1234567890' }, 409);
  assert.equal(db.persons.find((x) => x.id === 'buyer').name, 'buyer');
  // Gegenprobe: gültige Anfrage wirkt wie bisher
  const ok = await app.request('/api/people/buyer', { method: 'PUT', admin: true, body: { name: 'Umbenannt', note: 'neu', seat: '1111111111' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(app.snapshot().persons.find((x) => x.id === 'buyer').name, 'Umbenannt');
});

test('Events: ungültiger Zeitraum lässt den Namen unverändert', async (t) => {
  const app = await isolated(t);
  const db = await rejectedThenSaved(app, '/api/event/second', { name: 'Neuer Name', start: '2030-01-02T10:00', end: '2030-01-01T10:00' });
  assert.equal(db.events.find((e) => e.id === 'second').name, 'second');
  assert.equal((await app.request('/api/event/second', { method: 'PUT', admin: true, body: { name: 'Neuer Name' } })).status, 200);
  assert.equal(app.snapshot().events.find((e) => e.id === 'second').name, 'Neuer Name');
});

test('Einstellungen: ungültige DMX-Adresse lässt Module und Texte unverändert', async (t) => {
  const app = await isolated(t);
  const db = await rejectedThenSaved(app, '/api/settings', { eventName: 'Geändert', modules: { catering: true }, dmx: { url: 'ftp://x', on: '', off: '' } });
  assert.notEqual(db.meta.settings.eventName, 'Geändert');
  assert.notEqual(db.meta.settings.modules.catering, true);
  for (const e of db.events) assert.notEqual(e.modules.catering, true, e.id);
});
