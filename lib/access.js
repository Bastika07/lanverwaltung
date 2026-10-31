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

// Teilnehmerplätze (Indizes), für die das Discord-Konto Ergebnisse melden darf
function reportableSides(db, discordId, tournament) {
  if (!discordId) return new Set();
  const ids = new Set((db.persons || []).filter((p) => p.discordId === discordId).map((p) => p.id));
  const own = (name) => ((tournament.teamSize || 1) > 1
    ? Object.hasOwn(tournament.members || {}, name) && tournament.members[name].some((id) => ids.has(id))
    : Object.hasOwn(tournament.playerIds || {}, name) && ids.has(tournament.playerIds[name]));
  return new Set(tournament.participants.flatMap((name, index) => (own(name) ? [index] : [])));
}

function mayReport(db, discordId, tournament, match) {
  const own = reportableSides(db, discordId, tournament);
  return [match.a, match.b].some((index) => Number.isInteger(index) && own.has(index));
}

// Per /ich selbst angelegte Personen sind nur beansprucht, nicht geprüft: Namensgleichheit bindet sie nie.
// Bestehende Bindungen (auch die bei /anmelden direkt gesetzte) bleiben, solange die Person so heißt.
function bindPlayers(db, tournament, refresh = false) {
  const old = tournament.playerIds || {};
  const person = (id) => (db.persons || []).find((p) => p.id === id);
  tournament.playerIds = Object.fromEntries(tournament.participants.map((name) => {
    const kept = Object.hasOwn(old, name) ? old[name] : undefined;
    if (kept !== undefined && (!refresh || (kept && (person(kept) || {}).name === name))) return [name, kept];
    return [name, ((db.persons || []).find((p) => p.name === name && p.selfClaimed !== true) || {}).id || null];
  }));
}

module.exports = { isMember, reportableSides, mayReport, bindPlayers };
