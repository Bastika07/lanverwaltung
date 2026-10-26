'use strict';
const crypto = require('crypto');

// Einmalig: alte freie Discord-Claims sind kein Identitätsnachweis; alte Codes waren öffentlich.
module.exports = function migrate(ctx) {
  const { db, people, event, save } = ctx;
  if ((db.meta.securityVersion || 0) >= 1) return;
  const previousLinks = new Map(db.persons.map((p) => [p.id, p.discordId]));
  const refs = event.all().flatMap((e) => e.orders.flatMap((o) => o.tickets.map((t) => ({ e, o, t }))));
  const oldCodes = refs.map(({ t }) => t.code).filter(Boolean);
  for (const p of db.persons) {
    p.discordId = null;
    p.discordName = '';
    for (const code of oldCodes) p.note = String(p.note || '').split(`Ticket ${code}`).join('').split(code).join('').trim();
  }
  for (const e of event.all()) for (const a of e.attendees) a.approved = false;
  // Zuerst die früher dem Käufer zugeordnete Person erhalten, dann mehrdeutige Bezüge trennen.
  refs.sort((a, b) => Number(b.o.status === 'paid') - Number(a.o.status === 'paid')
    || Number(previousLinks.get(b.t.personId) === b.o.accountId) - Number(previousLinks.get(a.t.personId) === a.o.accountId));
  const assigned = new Map();
  const seenInEvent = new Set();
  for (const { e, o, t } of refs) {
    const ownerId = o.accountId || `order:${o.id}`;
    const p = t.personId && people.personById(t.personId);
    if (p) {
      const key = `${e.id}:${p.id}`;
      if ((!assigned.has(p.id) || assigned.get(p.id) === ownerId) && !seenInEvent.has(key)) {
        assigned.set(p.id, ownerId);
        seenInEvent.add(key);
        p.ticketOwnerId = ownerId;
      } else {
        const replacement = event.run(e, () => people.createTicketPerson(t.holder, ownerId));
        t.personId = replacement.id;
        if (o.status !== 'paid') e.attendees = e.attendees.filter((a) => a.personId !== replacement.id);
      }
    }
    t.code = crypto.randomBytes(16).toString('hex').toUpperCase();
  }
  db.meta.securityVersion = 1;
  save();
  console.log('Sicherheitsmigration: Ticketcodes erneuert, alte Discord-Verknüpfungen und unbestätigte Freigaben zurückgesetzt.');
};
