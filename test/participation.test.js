'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Participation = require('../lib/participation');

// Synthetisches Event: Käuferkonto „buyer“ kauft ein Teilnehmerticket für „holder“; „guest“ hat nur ein Zuschauerticket,
// „approved“ eine Orga-Freigabe. Konten sind über persons.discordId verknüpft.
function setup() {
  const db = { persons: [{ id: 'p-holder', discordId: 'holder' }, { id: 'p-guest', discordId: 'guest' }, { id: 'p-approved', discordId: 'approved' }] };
  const e = {
    ticketTypes: [{ id: 'normal', participant: true }, { id: 'viewer', participant: false }],
    orders: [
      { accountId: 'buyer', status: 'paid', tickets: [{ typeId: 'normal', personId: 'p-holder' }] },
      { accountId: 'guest', status: 'paid', tickets: [{ typeId: 'viewer', personId: 'p-guest' }] },
      { accountId: 'late', status: 'pending', tickets: [{ typeId: 'normal', personId: 'p-late' }] },
    ],
    attendees: [{ personId: 'p-holder' }, { personId: 'p-approved', approved: true }],
    access: { people: 'tickets', schedule: 'public' },
  };
  return { e, p: Participation({ db }) };
}

test('Teilnehmer (Person): eigenes bezahltes Teilnehmerticket oder Orga-Freigabe', () => {
  const { e, p } = setup();
  assert.equal(p.takesPart(e, 'p-holder'), true);
  assert.equal(p.takesPart(e, 'p-approved'), true);
  assert.equal(p.takesPart(e, 'p-guest'), false, 'viewer ticket');
  assert.equal(p.takesPart(e, 'p-late'), false, 'unpaid');
});

test('Teilnehmerrechte (Konto): auch der Käufer, nicht aber ein Zuschauer oder ein Unbekannter', () => {
  const { e, p } = setup();
  assert.equal(p.hasRights(e, { discordId: 'buyer' }), true, 'buyer of a participant ticket for someone else');
  assert.equal(p.takesPart(e, 'buyer'), false, 'the buyer is not a participant person');
  assert.equal(p.hasRights(e, { discordId: 'holder' }), true, 'linked holder');
  assert.equal(p.hasRights(e, { discordId: 'approved' }), true);
  assert.equal(p.hasRights(e, { discordId: 'guest' }), false);
  assert.equal(p.hasRights(e, { admin: true }), false, 'organizers see everything but get no participant rights');
  assert.equal(p.hasRights(null, { discordId: 'buyer' }), false);
});

test('Sichtbarkeit: öffentlich für alle, „nur Teilnehmer mit Ticket“ für Orga und Konten mit Teilnehmerrechten', () => {
  const { e, p } = setup();
  assert.equal(p.visibility(e, 'people'), 'tickets');
  assert.equal(p.visibility(e, 'info'), 'public', 'unset means public');
  assert.equal(p.mayView({}, 'schedule', e), true);
  assert.equal(p.mayView({}, 'people', e), false);
  assert.equal(p.mayView({ discordId: 'guest' }, 'people', e), false);
  assert.equal(p.mayView({ discordId: 'buyer' }, 'people', e), true);
  assert.equal(p.mayView({ admin: true }, 'people', e), true);
});

test('Ticketart: nur bekannte Arten, die als Teilnehmer zählen', () => {
  const { e, p } = setup();
  assert.equal(p.countsAsParticipant(e, { typeId: 'normal' }), true);
  assert.equal(p.countsAsParticipant(e, { typeId: 'viewer' }), false);
  assert.equal(p.countsAsParticipant(e, { typeId: 'deleted' }), false, 'unknown types fail closed');
});
