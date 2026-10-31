'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isolated } = require('../test-support/isolated.cjs');

const register = (app, user, name) => app.request('/api/servers', { method: 'POST', user, body: { name, description: 'Synthetic', reverse: false } });
const block = (app, id, blocked) => app.request(`/api/servers/${id}/block`, { method: 'POST', admin: true, body: { blocked } });
const roomy = (data) => { data.events.find((e) => e.id === 'first').serverConfig.ipTo = '10.10.50.30'; };

test('Gastserver: Moderationssperre gilt nach Kontolöschung und erneutem Login weiter, ohne Discord-ID im Klartext', async (t) => {
  // Phase 1: Server sperren, zweiten Server ungesperrt lassen, Konto löschen.
  const first = await isolated(t, { prepare: roomy });
  const banned = await register(first, 'buyer', 'gesperrt');
  const free = await register(first, 'buyer', 'frei');
  assert.equal((await block(first, banned.data.id, true)).status, 200);
  assert.equal((await first.request('/api/account', { method: 'DELETE', user: 'buyer' })).status, 200);
  const after = first.snapshot();
  const servers = after.events.find((e) => e.id === 'first').guestServers;
  assert.match(servers.find((s) => s.id === banned.data.id).banMark, /^[0-9a-f]{64}$/);
  assert.equal(servers.find((s) => s.id === free.data.id).banMark, undefined, 'nur bereits gesperrte Server tragen den Vermerk');
  assert.doesNotMatch(JSON.stringify(servers), /"buyer"/, 'keine Discord-ID im Klartext');
  assert.match(after.meta.banKey, /^[0-9a-f]{64}$/);

  // Phase 2: dasselbe Discord-Konto meldet sich erneut an (neues Konto, gleiche ID) und hat wieder ein Ticket.
  const second = await isolated(t, { prepare: (data) => {
    roomy(data);
    data.meta.banKey = after.meta.banKey;
    data.events.find((e) => e.id === 'first').guestServers = servers;
  } });
  const held = await register(second, 'buyer', 'neu');
  assert.equal(held.status, 201);
  assert.equal(held.data.blocked, true, 'neuer Server wartet auf Prüfung durch die Orga');
  assert.doesNotMatch((await second.request('/api/servers/export.txt', { admin: true })).text, /neu/);
  assert.equal((await register(second, 'other', 'nachbar')).data.blocked, false, 'andere Konten sind nicht betroffen');

  // Orga hebt die Sperre auf: Vermerk entfällt, neue Server sind wieder normal aktiv.
  assert.equal((await block(second, banned.data.id, false)).status, 200);
  assert.equal((await block(second, held.data.id, false)).status, 200); // zurückgehaltener Server wie bisher einzeln freigeben
  assert.equal(second.snapshot().events.find((e) => e.id === 'first').guestServers.find((s) => s.id === banned.data.id).banMark, undefined);
  assert.equal((await register(second, 'buyer', 'danach')).data.blocked, false);
});
