'use strict';
// Teilnahme: Wer ist Teilnehmer eines Events, welches Konto hat Teilnehmerrechte, und wer sieht Module, die auf
// „nur Teilnehmer mit Ticket“ stehen (Begriffe siehe GLOSSARY.md). Eine Regel für Webseite, Discord und alle Module.
//
// Anzeigenamen und selbst angelegte Personen sind niemals ein Nachweis. Nur bezahlte Tickets einer bestehenden
// Ticketart, die als Teilnehmer zählt (z. B. kein Zuschauerticket), oder eine Orga-Freigabe zählen.

// deps: db (Personen). Akteur: { admin } bzw. { discordId } wie im Turniermodul; Events werden ausdrücklich übergeben.
module.exports = function participation({ db }) {
  const participantTypes = (e) => new Set((e.ticketTypes || []).filter((t) => t.participant !== false).map((t) => t.id));
  const personsOf = (discordId) => new Set((db.persons || []).filter((p) => p.discordId === discordId).map((p) => p.id));
  const paidParticipantTickets = (e) => {
    const types = participantTypes(e);
    return e.orders.filter((o) => o.status === 'paid').flatMap((o) => o.tickets.filter((t) => types.has(t.typeId)).map((t) => ({ o, t })));
  };
  const approved = (e, ids) => e.attendees.some((a) => a.approved === true && ids.has(a.personId));

  // Teilnehmer: Die Person hält selbst ein bezahltes Teilnehmerticket oder hat eine Orga-Freigabe.
  function takesPart(e, personId) {
    if (!e || !personId) return false;
    return paidParticipantTickets(e).some(({ t }) => t.personId === personId) || approved(e, new Set([personId]));
  }

  // Teilnehmerrechte eines Kontos: als Käufer eines bezahlten Teilnehmertickets oder über eine verknüpfte Person,
  // die Teilnehmer ist. Die Orga sieht zwar alles (mayView), hat dadurch aber keine Teilnehmerrechte.
  function hasRights(e, actor) {
    const discordId = actor && actor.discordId;
    if (!e || !discordId) return false;
    const ids = personsOf(discordId);
    return paidParticipantTickets(e).some(({ o, t }) => o.accountId === discordId || ids.has(t.personId)) || approved(e, ids);
  }

  // Zählt die Ticketart dieses Tickets als Teilnehmer? Unbekannte Ticketarten zählen nicht.
  const countsAsParticipant = (e, ticket) => participantTypes(e).has(ticket.typeId);

  // Sichtbarkeit eines Moduls im Event: 'public' oder 'tickets' (nur Teilnehmer mit Ticket)
  const visibility = (e, key) => (((e && e.access) || {})[key] === 'tickets' ? 'tickets' : 'public');

  const mayView = (actor, key, e) => visibility(e, key) === 'public' || !!(actor && actor.admin) || hasRights(e, actor);

  return { takesPart, hasRights, countsAsParticipant, visibility, mayView };
};
