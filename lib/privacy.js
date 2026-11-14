'use strict';
const crypto = require('node:crypto');

// Kontolöschung: pseudonymisiert die verknüpften Personen und lässt jedes Modul seine eigenen Daten bereinigen
// (ausdrückliche Aufrufe statt eines Registers, siehe docs/adr/0002-personenaenderungen-ohne-register.md).
// Keine Massenlöschung und keine Namenssuche: nur nachweislich verknüpfte Personen bearbeiten.
module.exports = function eraseAccount(ctx, account) {
  const { db, people } = ctx;
  const pseudonyms = new Map(); // Personen-ID -> neuer Name
  const own = db.persons.filter((x) => x.discordId === account.id);
  // Turniere vor dem Start: austragen, Captain-Teams auflösen (übrige Mitglieder bekommen ihre Coins zurück)
  if (ctx.tournaments && ctx.event) for (const e of ctx.event.all()) for (const p of own) ctx.tournaments.of(e).withdrawPerson(p.id);
  for (const p of own) {
    const name = `Gelöscht-${crypto.randomBytes(6).toString('hex')}`;
    people.rename(p, name); // feste Personen-IDs und Ergebnisstände bleiben erhalten
    Object.assign(p, { discordId: null, discordName: '', steam: '', note: '', clan: '' });
    pseudonyms.set(p.id, name);
  }
  ctx.tickets.onAccountDeleted(account, pseudonyms);
  if (ctx.catering) ctx.catering.onAccountDeleted(account);
  ctx.servers.onAccountDeleted(account);
  db.accounts = db.accounts.filter((a) => a !== account);
  for (const [key, session] of Object.entries(db.userSessions)) if (session.uid === account.id) delete db.userSessions[key];
  ctx.revokeAdminSessions(account.id);
};
