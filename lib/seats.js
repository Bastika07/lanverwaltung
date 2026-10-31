'use strict';
// Sitzplätze: Selbstreservierung durch Ticketkäufer und Defragmentierung durch den Admin.
// Der belegte Platz steht an der Teilnahme der Person am Event (people.list()[].seat), das Layout
// gilt für alle Events. Bezahlte Tickets haben eine Person (siehe tickets.syncPeople), darüber
// hängen Ticket, Bestellung und Sitzplatz zusammen. Alles bezieht sich auf das Event der Anfrage.

module.exports = function seats(ctx) {
  const { db, save, broadcast, send, readBody, requireAdmin, HttpError } = ctx;
  const seating = () => db.seating;
  const changed = () => { save(); broadcast('people'); };

  // Natürliche Reihenfolge der Plätze: nach Bezeichnung ("2" vor "10"), sonst Zeile/Spalte
  const collator = new Intl.Collator('de', { numeric: true });
  const ordered = (list) => list.slice().sort((a, b) => collator.compare(a.label || '', b.label || '') || a.y - b.y || a.x - b.x);

  const typeOf = (t) => db.ticketTypes.find((x) => x.id === t.typeId);
  // Erlaubte Kategorien eines Tickets: null = alle, [] = keins (kein Teilnehmerplatz)
  function allowed(t) {
    const type = typeOf(t);
    if (!type || type.participant === false) return [];
    return type.seatCategories && type.seatCategories.length ? type.seatCategories : null;
  }
  const seatOk = (seat, cats) => !seat.locked && (cats === null || cats.includes(seat.category));
  const occupant = (seatId) => ctx.people.list().find((p) => p.seat === seatId) || null;

  // Bestellung zu einer Person (für Gruppen bei der Defragmentierung)
  function orderOfPerson(personId) {
    return db.orders.find((o) => o.status === 'paid' && o.tickets.some((t) => t.personId === personId)) || null;
  }

  // Eigene, bezahlte Tickets mit Person und Platz
  function myTickets(account) {
    const out = [];
    let created = false;
    for (const o of db.orders.filter((x) => x.accountId === account.id && x.status === 'paid')) {
      created = ctx.tickets.syncPeople(o) || created; // falls Teilnehmer fehlen (z. B. Modul später eingeschaltet)
      for (const t of o.tickets) {
        const cats = allowed(t);
        if (cats && !cats.length) continue; // Ticket ohne Sitzplatz (z. B. Tagesgast)
        const p = t.personId && ctx.people.byId(t.personId);
        if (!p) continue;
        out.push({ ticketId: t.id, ref: o.ref, holder: t.holder, typeName: t.typeName, personId: p.id, seat: p.seat, allowed: cats });
      }
    }
    if (created) changed(); // nur echte Nachträge speichern
    return out;
  }

  const isOpen = () => ctx.moduleOn('seating') && ctx.tickets.settings().seatSelection && !ctx.event.isOver(ctx.event.scoped());

  // ---------- Defragmentierung ----------
  // Pro Kategorie: belegte (nicht fixierte) Plätze lückenlos von vorne auffüllen,
  // Personen derselben Bestellung direkt nebeneinander, Reihenfolge der Gruppen bleibt.
  function plan() {
    const all = seating().seats;
    const moves = [];
    const cats = [...new Set(all.map((s) => s.category || null))];
    for (const cat of cats) {
      const list = ordered(all.filter((s) => (s.category || null) === cat && !s.locked));
      const groups = new Map(); // Schlüssel -> { first, people[] }
      list.forEach((s, i) => {
        const p = occupant(s.id);
        if (!p) return;
        const o = orderOfPerson(p.id);
        const key = o ? 'o:' + o.id : 'p:' + p.id;
        if (!groups.has(key)) groups.set(key, { first: i, people: [] });
        groups.get(key).people.push(p);
      });
      let i = 0;
      for (const g of [...groups.values()].sort((a, b) => a.first - b.first)) {
        for (const p of g.people) {
          const to = list[i++];
          if (p.seat !== to.id) moves.push({ personId: p.id, name: p.name, from: p.seat, to: to.id });
        }
      }
    }
    const label = (id) => (seating().seats.find((s) => s.id === id) || {}).label || '?';
    return moves.map((m) => ({ ...m, fromLabel: label(m.from), toLabel: label(m.to) }));
  }

  function apply(moves) {
    for (const m of moves) {
      const p = ctx.people.byId(m.personId);
      if (p) p.seat = m.to; // alle gleichzeitig – Tausche sind damit kein Problem
    }
    changed();
    // Käufer per Discord informieren (eine Nachricht je Bestellung)
    const byAccount = new Map();
    for (const m of moves) {
      const o = orderOfPerson(m.personId);
      if (!o || !o.accountId) continue;
      if (!byAccount.has(o.accountId)) byAccount.set(o.accountId, []);
      byAccount.get(o.accountId).push(`${m.name}: ${m.fromLabel} → **${m.toLabel}**`);
    }
    for (const [accountId, lines] of byAccount) {
      ctx.tickets.dm(accountId, `💺 Der Sitzplan wurde neu sortiert, damit keine Lücken bleiben und Gruppen zusammensitzen. Neue Plätze:\n${lines.join('\n')}`);
    }
  }

  async function routes(req, res, parts, method) {
    if (parts[0] !== 'seats') return false;

    // Platzwahl für den angemeldeten Käufer
    if (parts[1] === 'mine' && method === 'GET') {
      const a = ctx.accounts.requireUser(req);
      if (!ctx.isAdmin(req) && (!ctx.moduleOn('seating') || !ctx.mayView(req, 'seating') || !ctx.mayView(req, 'people'))) {
        throw new HttpError(403, 'Sitzplan nur für berechtigte Teilnehmer');
      }
      const mine = myTickets(a);
      const myPeople = new Set(mine.map((t) => t.personId));
      const occ = {};
      for (const p of ctx.people.list()) if (p.seat) occ[p.seat] = { name: p.name, clan: p.clan || '', mine: myPeople.has(p.id) };
      send(res, 200, { open: isOpen(), seating: seating(), occupied: occ, tickets: mine });
      return true;
    }

    if (parts[1] === 'reserve' && method === 'POST') {
      ctx.security.rateLimit(req, 'seat', 60, 60000);
      const a = ctx.accounts.requireUser(req);
      if (!isOpen()) throw new HttpError(400, 'Die Platzwahl ist gerade geschlossen');
      const b = await readBody(req);
      ctx.accounts.requireUser(req);
      if (!isOpen()) throw new HttpError(400, 'Die Platzwahl ist gerade geschlossen');
      const t = myTickets(a).find((x) => x.ticketId === b.ticketId);
      if (!t) throw new HttpError(403, 'Dieses Ticket gehört nicht zu deinen bezahlten Tickets');
      const p = ctx.people.byId(t.personId);
      if (!b.seatId) { p.seat = null; changed(); send(res, 200, { ok: true }); return true; }
      const seat = seating().seats.find((s) => s.id === b.seatId);
      if (!seat) throw new HttpError(404, 'Platz gibt es nicht');
      if (!seatOk(seat, t.allowed)) {
        throw new HttpError(400, seat.locked ? 'Dieser Platz ist reserviert' : `Mit „${t.typeName}“ kannst du nur in den freigegebenen Bereichen sitzen`);
      }
      const other = occupant(seat.id);
      if (other && other.id !== p.id) throw new HttpError(409, `Platz ${seat.label} ist schon belegt`);
      p.seat = seat.id;
      changed();
      send(res, 200, { ok: true, seat: seat.label });
      return true;
    }

    // Admin: Defragmentierung – Vorschau und Übernehmen
    if (parts[1] === 'defrag' && method === 'POST') {
      requireAdmin(req);
      const b = await readBody(req);
      const moves = plan();
      if (b.apply) { apply(moves); ctx.security.log('seats_defragmented', req, { moves: moves.length }); }
      send(res, 200, { moves, applied: !!b.apply });
      return true;
    }
    return false;
  }

  return { routes, moduleKey: 'tickets', plan };
};
