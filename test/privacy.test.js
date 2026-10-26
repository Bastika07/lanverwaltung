'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const eraseAccount = require('../lib/privacy');

test('account deletion pseudonymizes only the linked person and preserves other paid ticket holders', () => {
  const person = { id: 'own', name: 'Alice', discordId: '12345', discordName: 'Discord Alice', steam: 'steam-id', clan: 'Clan', note: 'Private', ticketOwnerId: '12345' };
  const other = { id: 'other', name: 'Bob', discordId: '67890', ticketOwnerId: '12345' };
  const account = { id: '12345', discordName: 'Alice', profile: { email: 'alice@example.invalid' } };
  const db = { meta: {}, persons: [person, other], accounts: [account, { id: '67890' }], userSessions: { own1: { uid: '12345' }, own2: { uid: '12345' }, other: { uid: '67890' } }, events: [{ id: 'event', attendees: [{ personId: 'own', seat: 'seat1' }, { personId: 'other', seat: 'seat2' }], tournaments: [
    { participants: ['Alice', 'Bob'], playerIds: { Alice: 'own', Bob: 'other' }, discord: { channels: { Alice: 'channel1', Bob: 'channel2' } }, results: { r0m0: { a: 1, b: 0 } } },
    { participants: ['Team'], teamSize: 2, members: { Team: ['own', 'other'] } },
  ], orders: [
    { id: 'paid', accountId: '12345', status: 'paid', total: 2000, tickets: [{ id: 'own-ticket', holder: 'Alice', personId: 'own', code: 'OWN' }, { id: 'other-ticket', holder: 'Bob', personId: 'other', code: 'OTHER' }] },
    { id: 'pending', accountId: '12345', status: 'pending', tickets: [] },
    { id: 'unrelated', accountId: '67890', status: 'paid', tickets: [] },
  ], guestServers: [{ id: 'own-server', accountId: '12345', blocked: false, ip: '10.1.1.1' }, { id: 'other-server', accountId: '67890', blocked: false }] }] };
  let saved = 0, revoked;
  const ctx = { db, save: () => { saved++; }, broadcast() {}, settings: () => ({}), str: (v) => String(v || ''), HttpError: Error, Discord: {}, revokeAdminSessions: (id) => { revoked = id; } };
  ctx.event = require('../lib/event')(ctx);
  ctx.people = require('../lib/people')(ctx);
  ctx.tickets = require('../lib/tickets')(ctx);
  const codeBefore = db.events[0].orders[0].tickets.map((t) => t.code);
  eraseAccount(ctx, account);
  assert.equal(saved, 0, 'the route saves the completed deletion once, not intermediate states');
  assert.equal(revoked, '12345');
  assert.deepEqual(db.accounts.map((a) => a.id), ['67890']);
  assert.deepEqual(Object.keys(db.userSessions), ['other']);
  assert.match(person.name, /^Gelöscht-[a-f0-9]{12}$/);
  assert.equal(person.discordId, null); assert.equal(person.note, ''); assert.equal(person.steam, ''); assert.equal(person.clan, '');
  assert.equal(other.name, 'Bob'); assert.equal(other.discordId, '67890');
  const e = db.events[0], paid = e.orders[0];
  assert.equal(paid.status, 'paid'); assert.equal(paid.total, 2000); assert.equal(paid.accountId, null); assert.equal(paid.buyerName, '(gelöscht)');
  assert.notEqual(person.ticketOwnerId, '12345'); assert.equal(person.ticketOwnerId, paid.ownerKey); assert.equal(other.ticketOwnerId, paid.ownerKey);
  assert.deepEqual(paid.tickets.map((t) => t.code), codeBefore);
  assert.equal(paid.tickets[0].holder, person.name); assert.equal(paid.tickets[1].holder, 'Bob');
  assert.equal(e.orders[1].status, 'cancelled'); assert.equal(e.orders[2].accountId, '67890');
  assert.equal(e.tournaments[0].participants[0], person.name); assert.equal(e.tournaments[0].playerIds[person.name], 'own');
  assert.equal(e.tournaments[0].discord.channels[person.name], 'channel1'); assert.ok(!Object.hasOwn(e.tournaments[0].discord.channels, 'Alice'));
  assert.deepEqual(e.tournaments[0].results, { r0m0: { a: 1, b: 0 } });
  assert.deepEqual(e.tournaments[1].members.Team, ['own', 'other']);
  assert.equal(e.attendees[0].seat, 'seat1'); assert.equal(e.guestServers[0].accountId, null); assert.equal(e.guestServers[0].blocked, true); assert.equal(e.guestServers[1].blocked, false);
  ctx.tickets.syncPeople(paid);
  assert.equal(paid.tickets[0].personId, 'own'); assert.equal(paid.tickets[1].personId, 'other');
  assert.equal(db.persons.length, 2, 'admin ticket synchronization must not recreate deleted identities');
});
