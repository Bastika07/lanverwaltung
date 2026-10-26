'use strict';
const crypto = require('node:crypto');

// Keine Massenlöschung und keine Namenssuche: nur nachweislich verknüpfte Personen bearbeiten.
module.exports = function eraseAccount(ctx, account) {
  const { db, event, people } = ctx;
  const linked = db.persons.filter((p) => p.discordId === account.id);
  ctx.tickets.onAccountDeleted(account);
  if (ctx.catering) ctx.catering.onAccountDeleted(account);
  for (const p of linked) {
    const name = `Gelöscht-${crypto.randomBytes(6).toString('hex')}`;
    people.rename(p, name); // feste Personen-IDs und Ergebnisstände bleiben erhalten
    Object.assign(p, { discordId: null, discordName: '', steam: '', note: '', clan: '' });
    for (const e of event.all()) for (const o of e.orders) for (const t of o.tickets) if (t.personId === p.id) t.holder = name;
  }
  for (const e of event.all()) for (const s of e.guestServers || []) if (s.accountId === account.id) {
    s.accountId = null;
    s.ownerDeleted = true;
    s.blocked = true; // DNS/IP muss die Orga gezielt freigeben; keine Wiederzuordnung bei erneutem Login
  }
  db.accounts = db.accounts.filter((a) => a !== account);
  for (const [key, session] of Object.entries(db.userSessions)) if (session.uid === account.id) delete db.userSessions[key];
  ctx.revokeAdminSessions(account.id);
};
