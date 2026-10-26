'use strict';
// Catering bleibt im Event-Payload der bestehenden SQLite-Speicherung: keine Schema-/JSON-Rückmigration.
const crypto = require('node:crypto');

module.exports = function catering(ctx) {
  const { db, save, broadcast, send, readBody, requireAdmin, HttpError, str } = ctx;
  const newId = () => crypto.randomBytes(8).toString('hex');
  const now = () => new Date().toISOString();
  const changed = () => { save(); broadcast('catering'); };
  const state = (e) => e.catering || { offers: [], entries: [] };
  const persist = (e, data) => { e.catering = data; changed(); };
  const person = (id) => db.persons.find((p) => p.id === id);
  const guest = (p) => ({ key: `person:${p.id}`, name: p.name, personId: p.id, accountId: null });
  const accountGuest = (a) => ({ key: `account:${a.id}`, name: a.discordName || 'Gast', personId: null, accountId: a.id });

  function guests(e, account, admin = false) {
    const list = new Map();
    const add = (g) => list.set(g.key, g);
    if (admin) {
      for (const a of e.attendees) { const p = person(a.personId); if (p) add(guest(p)); }
      for (const a of db.accounts) {
        const p = db.persons.find((x) => x.discordId === a.id);
        add(p ? guest(p) : accountGuest(a));
      }
    } else if (account) {
      const linked = db.persons.filter((p) => p.discordId === account.id);
      for (const p of linked) add(guest(p));
      if (!linked.length) add(accountGuest(account));
      // Käufer dürfen die tatsächlichen Inhaber ihrer bezahlten Tickets anmelden, nicht fremde Namen wählen.
      for (const o of e.orders) if (o.status === 'paid' && o.accountId === account.id) {
        for (const t of o.tickets) { const p = person(t.personId); if (p) add(guest(p)); }
      }
    }
    return [...list.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }
  const keyOf = (entry) => entry.personId ? `person:${entry.personId}` : entry.accountId ? `account:${entry.accountId}` : null;
  function entryView(entry) {
    const name = entry.personId ? (person(entry.personId)?.name || 'Entfernter Gast')
      : (db.accounts.find((a) => a.id === entry.accountId)?.discordName || 'Gelöschtes Konto');
    return { id: entry.id, offerId: entry.offerId, guestKey: keyOf(entry), name, price: entry.price,
      paidAt: entry.paidAt, createdAt: entry.createdAt, version: entry.version };
  }
  function offerView(offer, data, e) {
    const entries = data.entries.filter((x) => x.offerId === offer.id);
    return { ...offer, registered: entries.length,
      available: offer.open && !ctx.event.isOver(e) && (!offer.deadline || Date.parse(offer.deadline) > Date.now())
        && (!offer.capacity || entries.length < offer.capacity) };
  }
  function summary(e, account, admin) {
    const data = state(e), targets = guests(e, account, admin), keys = new Set(targets.map((g) => g.key));
    return { offers: data.offers.map((o) => offerView(o, data, e)),
      guests: targets.map(({ key, name }) => ({ key, name })),
      entries: data.entries.filter((x) => admin || keys.has(keyOf(x)) || (account && x.accountId === account.id)).map(entryView),
      loggedIn: !!account, over: ctx.event.isOver(e) };
  }
  function integer(value, min, max, label) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new HttpError(400, label);
    return value;
  }
  function date(value) {
    if (value === null || value === '') return null;
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new HttpError(400, 'Ungültiger Zeitpunkt');
    return new Date(value).toISOString();
  }
  function clean(body, old = {}) {
    const title = str(body.title ?? old.title, 120);
    if (!title) throw new HttpError(400, 'Titel fehlt');
    const open = body.open ?? old.open ?? true;
    if (typeof open !== 'boolean') throw new HttpError(400, 'Anmeldestatus muss wahr oder falsch sein');
    return { title, description: str(body.description ?? old.description, 1000),
      price: integer(body.price ?? old.price ?? 0, 0, 1000000, 'Preis in ganzen Cent zwischen 0 und 1000000 erwartet'),
      capacity: integer(body.capacity ?? old.capacity ?? 0, 0, 10000, 'Ungültige Höchstzahl'), open,
      servingAt: date(body.servingAt !== undefined ? body.servingAt : old.servingAt || null),
      deadline: date(body.deadline !== undefined ? body.deadline : old.deadline || null) };
  }
  function version(body, item) {
    if (body.version !== item.version) throw new HttpError(409, 'Eintrag wurde inzwischen geändert – bitte neu laden');
  }
  function checkOpen(e, offer) {
    if (!offer) throw new HttpError(404, 'Angebot nicht gefunden');
    if (!offer.open || ctx.event.isOver(e) || (offer.deadline && Date.parse(offer.deadline) <= Date.now())) {
      throw new HttpError(400, 'Die Anmeldung für dieses Angebot ist geschlossen');
    }
  }
  function authorize(req, e, admin) {
    if (!ctx.event.all().includes(e)) throw new HttpError(409, 'Event wurde inzwischen entfernt');
    if (admin) { requireAdmin(req); return null; }
    const account = ctx.accounts.requireUser(req);
    if (!ctx.moduleOn('catering')) throw new HttpError(404, 'Nicht gefunden');
    if (!ctx.mayView(req, 'catering')) throw new HttpError(403, 'Nur für Teilnehmer mit Ticket');
    return account;
  }

  async function routes(req, res, parts, method) {
    if (parts[0] !== 'catering') return false;
    const e = ctx.event.scoped();
    if (parts.length === 1 && method === 'GET') {
      send(res, 200, summary(e, ctx.accounts.current(req), false)); return true;
    }
    if (parts.length === 2 && parts[1] === 'admin' && method === 'GET') {
      requireAdmin(req); send(res, 200, summary(e, null, true)); return true;
    }
    if (parts[1] === 'offers') {
      requireAdmin(req);
      if (!((parts.length === 2 && method === 'POST') || (parts.length === 3 && ['PUT', 'DELETE'].includes(method)))) return false;
      const body = await readBody(req);
      authorize(req, e, true);
      const data = state(e);
      if (parts.length === 2) {
        if (data.offers.length >= 100) throw new HttpError(400, 'Höchstens 100 Catering-Angebote pro Event');
        const offer = { id: newId(), ...clean(body), version: 1 };
        data.offers.push(offer); persist(e, data);
        send(res, 201, offerView(offer, data, e)); return true;
      }
      const offer = data.offers.find((x) => x.id === parts[2]);
      if (!offer) throw new HttpError(404, 'Angebot nicht gefunden');
      version(body, offer);
      const count = data.entries.filter((x) => x.offerId === offer.id).length;
      if (method === 'DELETE') {
        if (count) throw new HttpError(409, 'Angebot hat Anmeldungen – bitte schließen statt löschen');
        data.offers = data.offers.filter((x) => x !== offer); persist(e, data);
        send(res, 200, { ok: true }); return true;
      }
      const next = clean(body, offer);
      if (next.capacity && next.capacity < count) throw new HttpError(409, 'Höchstzahl liegt unter den vorhandenen Anmeldungen');
      Object.assign(offer, next, { version: offer.version + 1 }); changed();
      send(res, 200, offerView(offer, data, e)); return true;
    }
    if (parts[1] !== 'entries') return false;
    if (!((parts.length === 2 && method === 'POST') || (parts.length === 3 && ['PUT', 'DELETE'].includes(method)))) return false;
    const admin = ctx.isAdmin(req);
    authorize(req, e, admin);
    const body = await readBody(req);
    const account = authorize(req, e, admin); // Sitzung, Modul, Zugang und Event nach Upload erneut prüfen.
    const data = state(e);
    const targets = guests(e, account, admin);
    if (method === 'POST') {
      // Zahlung kommt ausschließlich über den Admin-Endpunkt, nie aus der Anmeldung.
      if (body.paid !== undefined || body.paidAt !== undefined || body.price !== undefined) throw new HttpError(400, 'Zahlungsdaten können bei der Anmeldung nicht gesetzt werden');
      const target = targets.find((x) => x.key === body.guestKey);
      if (!target) throw new HttpError(403, 'Diesen Gast darfst du nicht anmelden');
      const offer = data.offers.find((x) => x.id === body.offerId);
      if (!offer) throw new HttpError(404, 'Angebot nicht gefunden');
      if (!admin) checkOpen(e, offer);
      if (data.entries.some((x) => x.offerId === offer.id && (keyOf(x) === target.key
        || (target.personId && x.accountId && person(target.personId)?.discordId === x.accountId)))) {
        throw new HttpError(409, 'Gast ist für dieses Angebot bereits angemeldet');
      }
      if (offer.capacity && data.entries.filter((x) => x.offerId === offer.id).length >= offer.capacity) throw new HttpError(409, 'Angebot ist ausgebucht');
      if (data.entries.length >= 10000) throw new HttpError(400, 'Zu viele Catering-Anmeldungen');
      const entry = { id: newId(), offerId: offer.id, personId: target.personId, accountId: target.accountId,
        price: offer.price, paidAt: null, createdAt: now(), version: 1 };
      data.entries.push(entry); persist(e, data);
      send(res, 201, entryView(entry)); return true;
    }
    const entry = data.entries.find((x) => x.id === parts[2]);
    if (!entry) throw new HttpError(404, 'Anmeldung nicht gefunden');
    if (!admin && entry.accountId !== account.id && !targets.some((g) => g.key === keyOf(entry))) throw new HttpError(403, 'Nicht deine Anmeldung');
    if (method === 'PUT') {
      requireAdmin(req);
      version(body, entry);
      if (typeof body.paid !== 'boolean') throw new HttpError(400, 'Zahlungsstatus muss wahr oder falsch sein');
      entry.paidAt = body.paid ? (entry.paidAt || now()) : null;
      entry.version++; changed();
      send(res, 200, entryView(entry)); return true;
    }
    version(body, entry);
    if (entry.paidAt) throw new HttpError(409, 'Bezahlte Anmeldung: Erstattung zuerst mit der Orga klären; Zahlungsstatus nur durch Admin zurücksetzen');
    if (!admin) checkOpen(e, data.offers.find((x) => x.id === entry.offerId));
    data.entries = data.entries.filter((x) => x !== entry); persist(e, data);
    send(res, 200, { ok: true }); return true;
  }

  // Kontolöschung darf weder personenbezogene Kopien behalten noch eine spätere Wiederzuordnung erlauben.
  function onAccountDeleted(account) {
    for (const e of ctx.event.all()) for (const entry of state(e).entries) if (entry.accountId === account.id) {
      entry.accountId = null; entry.version++;
    }
  }
  function checkMerge(from, into) {
    for (const e of ctx.event.all()) {
      const entries = state(e).entries;
      if (entries.some((a) => a.personId === from.id && entries.some((b) => b.personId === into.id && b.offerId === a.offerId))) {
        throw new HttpError(409, 'Beide Personen sind beim selben Catering-Angebot angemeldet – zuerst mit der Orga klären');
      }
    }
  }
  function merge(from, into) {
    for (const e of ctx.event.all()) for (const entry of state(e).entries) if (entry.personId === from.id) {
      entry.personId = into.id; entry.version++;
    }
  }
  return { routes, onAccountDeleted, checkMerge, merge };
};
