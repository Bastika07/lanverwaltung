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

function mayReport(db, discordId, tournament, match) {
  if (!discordId) return false;
  const ids = new Set((db.persons || []).filter((p) => p.discordId === discordId).map((p) => p.id));
  return [match.a, match.b].some((index) => {
    if (!Number.isInteger(index)) return false;
    const name = tournament.participants[index];
    if ((tournament.teamSize || 1) > 1) {
      return Object.hasOwn(tournament.members || {}, name)
        && tournament.members[name].some((id) => ids.has(id));
    }
    return Object.hasOwn(tournament.playerIds || {}, name) && ids.has(tournament.playerIds[name]);
  });
}

function bindPlayers(db, tournament, refresh = false) {
  tournament.playerIds = Object.fromEntries(tournament.participants.map((name) => [name,
    !refresh && Object.hasOwn(tournament.playerIds || {}, name) ? tournament.playerIds[name]
      : ((db.persons || []).find((p) => p.name === name) || {}).id || null]));
}

module.exports = { isMember, mayReport, bindPlayers };
