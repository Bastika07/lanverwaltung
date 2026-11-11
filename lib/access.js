'use strict';

// Anzeigenamen und selbst angelegte Teilnahmen sind niemals ein Berechtigungsnachweis.
// Nur Tickets einer bestehenden Ticketart, die als Teilnehmer zählt, berechtigen (z. B. kein Zuschauerticket).
function isMember(db, discordId, event) {
  if (!discordId || !event) return false;
  const ids = new Set((db.persons || []).filter((p) => p.discordId === discordId).map((p) => p.id));
  const participantTypes = new Set((event.ticketTypes || []).filter((t) => t.participant !== false).map((t) => t.id));
  return event.orders.some((o) => o.status === 'paid' && o.tickets.some((t) => participantTypes.has(t.typeId)
    && (o.accountId === discordId || ids.has(t.personId))))
    || event.attendees.some((a) => a.approved === true && ids.has(a.personId));
}

module.exports = { isMember };
