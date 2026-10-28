'use strict';
// Tickets: frei konfigurierbare Ticketarten (Preis, Kontingent, Verkaufszeitraum), Bestellungen
// mit einem Namen pro Ticket, Bezahlung per Überweisung (Admin bestätigt), Check-in, CSV-Export.
// Bezahlte Tickets landen als Teilnehmer in der Teilnehmerliste ihres Events.
// Ticketarten, Bestellungen und Verkaufseinstellungen gehören zum Event (db.ticketTypes/db.orders zeigen
// auf das Event der Anfrage, siehe lib/event.js) – so läuft der Vorverkauf fürs nächste Event parallel.
// Bankverbindung, Datenschutzhinweis und Discord-Mitgliedschaft gelten für alle Events.

const crypto = require('crypto');

const REF_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne 0/O/1/I – gut abtippbar
const randomCode = (n) => Array.from(crypto.randomBytes(n), (b) => REF_CHARS[b % REF_CHARS.length]).join('');

const DEFAULT_PRIVACY = 'Wir speichern deine Angaben (Name, Anschrift, E-Mail, Geburtsdatum) ausschließlich zur Organisation '
  + 'der LAN-Party: Ticketverwaltung, Einlass und Rückfragen. Sie sind nur für die Orga sichtbar und werden nicht weitergegeben. '
  + 'Nach der Veranstaltung werden sie gelöscht, soweit keine gesetzlichen Aufbewahrungspflichten bestehen. '
  + 'Du kannst dein Konto jederzeit selbst löschen.';

module.exports = function tickets(ctx) {
  const { db, save, broadcast, send, readBody, requireAdmin, isAdmin, HttpError, str, Discord } = ctx;
  const SALE_KEYS = ['saleOpen', 'payDays', 'minAge', 'seatSelection']; // pro Event (event.sale)
  db.meta.ticketSettings = {
    requireMember: true, privacy: DEFAULT_PRIVACY,
    ...(db.meta.ticketSettings || {}),
    bank: { holder: '', iban: '', bic: '', bank: '', ...((db.meta.ticketSettings || {}).bank || {}) },
  };
  for (const k of SALE_KEYS) delete db.meta.ticketSettings[k]; // stehen seit der Eventverwaltung am Event
  // Globale Einstellungen + Verkaufseinstellungen des Events der Anfrage (nur lesen; ändern über PUT /tickets/settings)
  const settings = () => ({ ...db.meta.ticketSettings, ...ctx.event.scoped().sale });

  // Bestellungen aller Events (Verwendungszwecke und Ticketcodes sind eventübergreifend eindeutig)
  const allOrders = () => ctx.event.all().flatMap((e) => e.orders);
  const eventOfOrder = (o) => ctx.event.eventOf('orders', o);
  const changed = () => { save(); broadcast('tickets'); };
  const newId = () => crypto.randomBytes(5).toString('hex');
  const euro = (cents) => (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

  // ---------- Kontingente ----------
  const live = (o) => o.status === 'paid' || (o.status === 'pending' && Date.parse(o.dueAt) > Date.now());
  const sold = (typeId) => db.orders.filter(live).reduce((n, o) => n + o.tickets.filter((t) => t.typeId === typeId).length, 0);
  const available = (type) => (type.quota == null ? null : Math.max(0, type.quota - sold(type.id)));
  function onSale(type, now = Date.now()) {
    if (!settings().saleOpen || !type.active || ctx.event.isOver(ctx.event.scoped(), now)) return false;
    if (type.saleStart && now < Date.parse(type.saleStart)) return false;
    if (type.saleEnd && now >= Date.parse(type.saleEnd)) return false;
    return available(type) !== 0;
  }
  const publicType = (t) => ({
    id: t.id, name: t.name, description: t.description, price: t.price, maxPerOrder: t.maxPerOrder,
    available: available(t), quota: t.quota, saleStart: t.saleStart, saleEnd: t.saleEnd, onSale: onSale(t),
  });

  function cleanType(b, old = {}) {
    const name = str(b.name ?? old.name, 80);
    if (!name) throw new HttpError(400, 'Name der Ticketart fehlt');
    const priceIn = b.price ?? old.price / 100;
    const price = Math.round(Number(String(priceIn).replace(',', '.')) * 100); // "5,50" oder 5.5
    if (!Number.isFinite(price) || price < 0 || price > 100000) throw new HttpError(400, 'Ungültiger Preis');
    const quotaRaw = b.quota !== undefined ? b.quota : old.quota;
    const quota = quotaRaw === null || quotaRaw === '' || quotaRaw === undefined ? null : Math.floor(Number(quotaRaw));
    if (quota !== null && (!Number.isFinite(quota) || quota < 0)) throw new HttpError(400, 'Ungültiges Kontingent');
    const date = (v) => { if (!v) return null; const d = new Date(v); if (Number.isNaN(d.getTime())) throw new HttpError(400, 'Ungültiges Datum'); return d.toISOString(); };
    const saleStart = date(b.saleStart !== undefined ? b.saleStart : old.saleStart);
    const saleEnd = date(b.saleEnd !== undefined ? b.saleEnd : old.saleEnd);
    if (saleStart && saleEnd && saleEnd <= saleStart) throw new HttpError(400, 'Verkaufsende muss nach dem Verkaufsstart liegen');
    const maxPerOrder = Math.min(Math.max(Math.floor(Number(b.maxPerOrder ?? old.maxPerOrder ?? 10)) || 1, 1), 50);
    return {
      name, price, quota, saleStart, saleEnd, maxPerOrder,
      description: str(b.description ?? old.description, 300),
      active: b.active !== undefined ? !!b.active : old.active !== false,
      participant: b.participant !== undefined ? !!b.participant : old.participant !== false, // zählt als LAN-Teilnehmer
      // Sitzplatz-Kategorien, in denen reserviert werden darf (leer = alle)
      seatCategories: (Array.isArray(b.seatCategories) ? b.seatCategories : old.seatCategories || [])
        .filter((id) => (db.seating.categories || []).some((c) => c.id === id)),
    };
  }

  // ---------- Teilnehmerliste ----------
  // Bezahlte Tickets -> Teilnehmer im Event der Bestellung (bekannte Person wird übernommen, sonst
  // neu angelegt); das Ticket merkt sich die Person.
  function syncPeople(order) {
    const e = eventOfOrder(order);
    if (!ctx.people || order.status !== 'paid' || !e) return;
    ctx.event.run(e, () => syncPeopleHere(order));
  }
  function syncPeopleHere(order) {
    const ownerId = order.accountId || order.ownerKey || `order:${order.id}`;
    for (const t of order.tickets) {
      const type = db.ticketTypes.find((x) => x.id === t.typeId);
      if (type && type.participant === false) continue;
      const existing = t.personId && ctx.people.personById(t.personId);
      const p = (existing && existing.ticketOwnerId === ownerId && ctx.people.attend(existing.id))
        || ctx.people.createTicketPerson(t.holder, ownerId);
      t.personId = p.id;
    }
  }

  // Discord-Direktnachricht an den Käufer (falls Discord aktiv und DMs erlaubt) – nur ein Hinweis, kein Muss
  async function dm(accountId, text) {
    if (!Discord.enabled) return;
    try {
      const ch = await Discord.call('POST', '/users/@me/channels', { recipient_id: accountId });
      await Discord.post(ch.id, text);
    } catch (err) { console.error('Ticket-DM:', err.message); }
  }

  function paymentText(o) {
    const b = settings().bank;
    return `Bitte überweise **${euro(o.total)}** bis <t:${Math.floor(Date.parse(o.dueAt) / 1000)}:D>`
      + (b.iban ? ` an ${Discord.md(b.holder)}, IBAN \`${b.iban}\`` : '') + ` – Verwendungszweck: \`${o.ref}\``;
  }

  function orderView(o, withBuyer) {
    const e = eventOfOrder(o);
    const clanOf = (t) => { const p = t.personId && ctx.people && ctx.people.personById(t.personId); return p ? p.clan || '' : ''; };
    const { buyerProfile, ...fields } = o; // Manuelle Anschrift niemals in Nicht-Admin-Ansichten ausgeben.
    const v = { ...fields, tickets: o.tickets.map((t) => ({ ...t, clan: clanOf(t) })), eventId: e && e.id, eventName: e && e.name };
    if (withBuyer) {
      const a = ctx.accounts.find(o.accountId);
      v.buyer = a ? { name: a.discordName, username: a.username, profile: a.profile, age: a.profile ? ctx.accounts.age(a.profile.birthdate) : null }
        : { name: o.buyerName || '(gelöscht)', profile: buyerProfile || null, age: buyerProfile ? ctx.accounts.age(buyerProfile.birthdate) : null };
    }
    return v;
  }

  function findOrder(id) {
    const o = allOrders().find((x) => x.id === id);
    if (!o) throw new HttpError(404, 'Bestellung nicht gefunden');
    return o;
  }

  function cancel(o) {
    if (o.status === 'cancelled') return;
    o.status = 'cancelled';
    o.cancelledAt = new Date().toISOString();
  }

  // Konto gelöscht: offene Bestellungen stornieren, Bezug zum Konto entfernen
  function onAccountDeleted(a) {
    const ownerKey = `deleted:${crypto.randomBytes(16).toString('hex')}`;
    for (const p of db.persons) if (p.ticketOwnerId === a.id) p.ticketOwnerId = ownerKey;
    for (const o of allOrders().filter((x) => x.accountId === a.id)) {
      if (o.status === 'pending') cancel(o);
      o.buyerName = '(gelöscht)';
      o.accountId = null;
      o.ownerKey = ownerKey;
    }
  }

  function csv(rows) {
    const cell = (v) => {
      let s = v == null ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // Formel-Injection in Excel/LibreOffice verhindern
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n'); // BOM + Semikolon für Excel
  }

  async function routes(req, res, parts, method) {
    if (parts[0] !== 'tickets') return false;
    const S = settings();

    // Öffentlich: Ticketarten des gewählten Events und alle Events, für die es Tickets gibt
    if (parts.length === 1 && method === 'GET') {
      const e = ctx.event.scoped();
      const pubEvent = (x) => ({ id: x.id, name: x.name, start: x.start, end: x.end, active: x.active });
      send(res, 200, {
        event: pubEvent(e),
        events: ctx.event.all().filter((x) => x === e
          || (!ctx.event.isOver(x) && ctx.eventModuleOn(x, 'tickets') && x.ticketTypes.some((t) => t.active))).map(pubEvent),
        saleOpen: S.saleOpen, payDays: S.payDays, privacy: S.privacy, minAge: S.minAge, requireMember: S.requireMember,
        types: db.ticketTypes.filter((t) => t.active).map(publicType),
      });
      return true;
    }

    // Eigene Bestellungen (aller Events)
    if (parts[1] === 'mine' && method === 'GET') {
      const a = ctx.accounts.requireUser(req);
      send(res, 200, { bank: S.bank, orders: allOrders().filter((o) => o.accountId === a.id).map((o) => orderView(o)).reverse() });
      return true;
    }

    // Bestellen
    if (parts[1] === 'orders' && parts.length === 2 && method === 'POST') {
      ctx.security.rateLimit(req, 'order', 10, 10 * 60000);
      ctx.accounts.requireUser(req);
      const b = await readBody(req);
      const a = ctx.accounts.requireUser(req); // Sitzung kann während des Body-Uploads widerrufen werden.
      const currentSale = settings();
      if (!ctx.accounts.complete(a)) throw new HttpError(400, 'Bitte zuerst deine Daten vollständig hinterlegen');
      if (currentSale.minAge > 0 && ctx.accounts.age(a.profile.birthdate) < currentSale.minAge) throw new HttpError(400, `Die Teilnahme ist erst ab ${currentSale.minAge} Jahren möglich`);
      if (db.orders.filter((o) => o.accountId === a.id && o.status === 'pending' && live(o)).length >= 3) {
        throw new HttpError(429, 'Höchstens drei offene Bestellungen pro Konto – bitte zuerst bezahlen oder stornieren');
      }
      if (!Array.isArray(b.items) || !b.items.length) throw new HttpError(400, 'Bitte mindestens ein Ticket auswählen');
      if (b.items.length > 50) throw new HttpError(400, 'Zu viele Tickets auf einmal');
      const count = {};
      const items = b.items.map((it) => {
        if (!it || typeof it !== 'object' || Array.isArray(it)) throw new HttpError(400, 'Ungültiger Ticketeintrag');
        const type = db.ticketTypes.find((t) => t.id === it.typeId);
        if (!type || !onSale(type)) throw new HttpError(400, 'Diese Ticketart ist gerade nicht erhältlich');
        const holder = str(it.holder, 60);
        if (!holder) throw new HttpError(400, 'Bitte für jedes Ticket einen Namen angeben');
        count[type.id] = (count[type.id] || 0) + 1;
        return { type, holder };
      });
      for (const [typeId, n] of Object.entries(count)) {
        const type = db.ticketTypes.find((t) => t.id === typeId);
        if (n > type.maxPerOrder) throw new HttpError(400, `Höchstens ${type.maxPerOrder} × „${type.name}“ pro Bestellung`);
        const left = available(type);
        if (left !== null && n > left) {
          throw new HttpError(409, !left ? `„${type.name}“ ist ausverkauft` : `Von „${type.name}“ ${left === 1 ? 'ist' : 'sind'} nur noch ${left} übrig`);
        }
      }
      let ref;
      do ref = `LAN-${randomCode(6)}`; while (allOrders().some((o) => o.ref === ref));
      const now = Date.now();
      const o = {
        id: newId(), ref, accountId: a.id, createdAt: new Date(now).toISOString(),
        dueAt: new Date(now + currentSale.payDays * 864e5).toISOString(), status: 'pending',
        tickets: items.map(({ type, holder }) => ({ id: newId(), code: crypto.randomBytes(16).toString('hex').toUpperCase(), typeId: type.id, typeName: type.name, price: type.price, holder })),
      };
      o.total = o.tickets.reduce((s, t) => s + t.price, 0);
      if (o.total === 0) { o.status = 'paid'; o.paidAt = o.createdAt; } // Gratis-Tickets sofort gültig
      db.orders.push(o);
      if (o.status === 'paid') syncPeople(o);
      changed();
      dm(a.id, `🎟️ Danke für deine Bestellung **${o.ref}** (${o.tickets.length} Ticket${o.tickets.length === 1 ? '' : 's'}).\n`
        + (o.status === 'paid' ? 'Deine Tickets sind bestätigt.' : paymentText(o)));
      send(res, 201, orderView(o));
      return true;
    }

    // Namen auf Tickets ändern (Käufer oder Admin)
    if (parts[1] === 'orders' && parts[3] === 'holders' && method === 'PUT') {
      const o = findOrder(parts[2]);
      if (!isAdmin(req) && o.accountId !== ctx.accounts.requireUser(req).id) throw new HttpError(403, 'Nicht deine Bestellung');
      if (o.status === 'cancelled') throw new HttpError(400, 'Bestellung ist storniert');
      const b = await readBody(req);
      if (!isAdmin(req) && o.accountId !== ctx.accounts.requireUser(req).id) throw new HttpError(403, 'Nicht deine Bestellung');
      if (o.status === 'cancelled') throw new HttpError(400, 'Bestellung ist storniert');
      syncPeople(o);
      for (const t of o.tickets) {
        const name = b.holders && str(b.holders[t.id], 60);
        if (name && name !== t.holder) {
          t.holder = name;
          const p = t.personId && ctx.people.personById(t.personId);
          if (p) ctx.people.rename(p, ctx.people.ticketName(name, p));
        }
      }
      syncPeople(o);
      // Clan je Ticket (an der Person, also nur bei bezahlten Tickets mit Teilnehmer)
      for (const t of o.tickets) if (b.clans && b.clans[t.id] !== undefined && t.personId) ctx.people.setClan(t.personId, b.clans[t.id]);
      changed();
      send(res, 200, orderView(o));
      return true;
    }

    // Stornieren: Käufer (nur offene) oder Admin
    if (parts[1] === 'orders' && parts[3] === 'cancel' && method === 'POST') {
      const o = findOrder(parts[2]);
      const admin = isAdmin(req);
      if (!admin) {
        if (o.accountId !== ctx.accounts.requireUser(req).id) throw new HttpError(403, 'Nicht deine Bestellung');
        if (o.status !== 'pending') throw new HttpError(400, 'Bezahlte Bestellungen kann nur die Orga stornieren');
      }
      cancel(o);
      changed();
      ctx.security.log('order_cancelled', req, { ref: o.ref, by: admin ? 'admin' : 'buyer' });
      send(res, 200, orderView(o, admin));
      return true;
    }

    // ---------- ab hier nur Admin ----------
    requireAdmin(req);

    // Abendkasse: unabhängig vom Vorverkaufsfenster, aber nie von Alter, Kontingent oder Eventende.
    if (parts[1] === 'admin' && parts[2] === 'orders' && parts.length === 3 && method === 'POST') {
      const b = await readBody(req);
      requireAdmin(req); // Sitzung kann während des Uploads widerrufen werden.
      const currentSale = settings();
      if (typeof b.paid !== 'boolean') throw new HttpError(400, 'Zahlungsstatus muss ein Boolean sein');
      if (b.privacyConfirmed !== true) throw new HttpError(400, 'Bitte den Datenschutzhinweis bestätigen');
      if (!b.buyerProfile || typeof b.buyerProfile !== 'object' || Array.isArray(b.buyerProfile)) throw new HttpError(400, 'Käuferdaten fehlen');
      const buyerProfile = ctx.accounts.cleanProfile(b.buyerProfile);
      if (currentSale.minAge > 0 && ctx.accounts.age(buyerProfile.birthdate) < currentSale.minAge) throw new HttpError(400, `Die Teilnahme ist erst ab ${currentSale.minAge} Jahren möglich`);
      if (ctx.event.isOver(ctx.event.scoped())) throw new HttpError(400, 'Das Event ist bereits beendet');
      if (!Array.isArray(b.items) || !b.items.length || b.items.length > 50) throw new HttpError(400, 'Bitte 1 bis 50 Tickets auswählen');
      const count = new Map();
      const items = b.items.map((it) => {
        if (!it || typeof it !== 'object' || Array.isArray(it)) throw new HttpError(400, 'Ungültiger Ticketeintrag');
        const type = db.ticketTypes.find((t) => t.id === it.typeId);
        if (!type || !type.active) throw new HttpError(400, 'Diese Ticketart ist gerade nicht erhältlich');
        const holder = str(it.holder, 60);
        if (!holder) throw new HttpError(400, 'Bitte für jedes Ticket einen Namen angeben');
        count.set(type, (count.get(type) || 0) + 1);
        return { type, holder };
      });
      for (const [type, n] of count) {
        if (n > type.maxPerOrder) throw new HttpError(400, `Höchstens ${type.maxPerOrder} × „${type.name}“ pro Bestellung`);
        const left = available(type);
        if (left !== null && n > left) throw new HttpError(409, 'Kontingent reicht für die Bestellung nicht aus');
      }
      // Keine weiteren awaits zwischen Kontingentprüfung und Speicherung: parallele Anfragen sehen die Reservierung.
      let ref;
      do ref = `LAN-${randomCode(6)}`; while (allOrders().some((o) => o.ref === ref));
      const now = Date.now();
      const o = {
        id: newId(), ref, accountId: null, source: 'box_office', buyerProfile,
        buyerName: `${buyerProfile.firstName} ${buyerProfile.lastName}`, version: 1,
        privacyConfirmedAt: new Date(now).toISOString(), createdAt: new Date(now).toISOString(),
        dueAt: new Date(now + currentSale.payDays * 864e5).toISOString(), status: 'pending', paymentMethod: null,
        tickets: items.map(({ type, holder }) => ({ id: newId(), code: crypto.randomBytes(16).toString('hex').toUpperCase(), typeId: type.id, typeName: type.name, price: type.price, holder })),
      };
      o.total = o.tickets.reduce((sum, ticket) => sum + ticket.price, 0);
      if (b.paid || o.total === 0) {
        o.status = 'paid'; o.paidAt = o.createdAt;
        o.paymentMethod = b.paid && o.total > 0 ? 'cash' : null;
      }
      db.orders.push(o);
      if (o.status === 'paid') syncPeople(o);
      changed();
      ctx.security.log('box_office_order_created', req, { ref: o.ref });
      send(res, 201, orderView(o, true));
      return true;
    }

    if (parts[1] === 'orders' && parts.length === 4 && parts[3] === 'buyer' && method === 'PUT') {
      const b = await readBody(req);
      requireAdmin(req);
      const o = db.orders.find((x) => x.id === parts[2]); // Selected event only.
      if (!o) throw new HttpError(404, 'Bestellung nicht gefunden');
      if (o.source !== 'box_office') throw new HttpError(400, 'Nur Kontaktdaten manueller Buchungen können hier bearbeitet werden');
      if (!Number.isSafeInteger(b.version) || b.version !== o.version) throw new HttpError(409, 'Die Daten wurden inzwischen geändert. Bitte den aktuellen Stand neu laden.');
      if (!b.buyerProfile || typeof b.buyerProfile !== 'object' || Array.isArray(b.buyerProfile)) throw new HttpError(400, 'Käuferdaten fehlen');
      const buyerProfile = ctx.accounts.cleanProfile(b.buyerProfile);
      const minAge = settings().minAge;
      if (minAge > 0 && ctx.accounts.age(buyerProfile.birthdate) < minAge) throw new HttpError(400, `Die Teilnahme ist erst ab ${minAge} Jahren möglich`);
      o.buyerProfile = buyerProfile;
      o.buyerName = `${buyerProfile.firstName} ${buyerProfile.lastName}`;
      o.version++;
      changed();
      ctx.security.log('box_office_buyer_updated', req, { ref: o.ref });
      send(res, 200, orderView(o, true));
      return true;
    }

    if (parts[1] === 'admin' && method === 'GET') {
      const types = db.ticketTypes.map((t) => ({ ...t, sold: sold(t.id), available: available(t), onSale: onSale(t) }));
      const orders = db.orders.map((o) => orderView(o, true)).reverse();
      const paid = db.orders.filter((o) => o.status === 'paid');
      const e = ctx.event.scoped();
      send(res, 200, {
        event: { id: e.id, name: e.name }, settings: S, types, orders,
        stats: {
          tickets: db.orders.filter(live).reduce((n, o) => n + o.tickets.length, 0),
          paidTickets: paid.reduce((n, o) => n + o.tickets.length, 0),
          revenue: paid.reduce((s, o) => s + o.total, 0),
          open: db.orders.filter((o) => o.status === 'pending').reduce((s, o) => s + o.total, 0),
          checkedIn: paid.reduce((n, o) => n + o.tickets.filter((t) => t.checkedInAt).length, 0),
        },
      });
      return true;
    }

    if (parts[1] === 'settings' && method === 'PUT') {
      const b = await readBody(req);
      const G = db.meta.ticketSettings; // für alle Events
      const E = ctx.event.scoped().sale; // nur dieses Event
      if (b.saleOpen !== undefined) E.saleOpen = !!b.saleOpen;
      if (b.requireMember !== undefined) G.requireMember = !!b.requireMember;
      if (b.seatSelection !== undefined) E.seatSelection = !!b.seatSelection;
      if (b.payDays !== undefined) E.payDays = Math.min(Math.max(Math.floor(Number(b.payDays)) || 14, 1), 90);
      if (b.minAge !== undefined) E.minAge = Math.min(Math.max(Math.floor(Number(b.minAge)) || 0, 0), 99);
      if (b.privacy !== undefined) G.privacy = str(b.privacy, 3000) || DEFAULT_PRIVACY;
      if (b.bank) {
        const iban = str(b.bank.iban, 40).replace(/\s+/g, '').toUpperCase();
        if (iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) throw new HttpError(400, 'Die IBAN sieht ungültig aus');
        G.bank = { holder: str(b.bank.holder, 70), iban, bic: str(b.bank.bic, 11).toUpperCase(), bank: str(b.bank.bank, 70) };
      }
      changed();
      send(res, 200, settings());
      return true;
    }

    if (parts[1] === 'types') {
      if (parts.length === 2 && method === 'POST') {
        const t = { id: newId(), ...cleanType(await readBody(req)) };
        db.ticketTypes.push(t);
        changed();
        send(res, 201, t);
        return true;
      }
      const t = db.ticketTypes.find((x) => x.id === parts[2]);
      if (!t) throw new HttpError(404, 'Ticketart nicht gefunden');
      if (method === 'PUT') {
        Object.assign(t, cleanType(await readBody(req), t));
        changed();
        send(res, 200, t);
        return true;
      }
      if (method === 'DELETE') {
        if (db.orders.some((o) => o.tickets.some((x) => x.typeId === t.id))) throw new HttpError(400, 'Es gibt schon Bestellungen – bitte stattdessen deaktivieren');
        db.ticketTypes = db.ticketTypes.filter((x) => x !== t);
        changed();
        send(res, 200, { ok: true });
        return true;
      }
    }

    // Zahlung bestätigen / zurücknehmen
    if (parts[1] === 'orders' && parts[3] === 'paid' && method === 'POST') {
      const o = findOrder(parts[2]);
      const b = await readBody(req);
      if (b.paid) {
        if (o.status === 'paid') { send(res, 200, orderView(o, true)); return true; }
        const event = eventOfOrder(o);
        for (const typeId of new Set(o.tickets.map((t) => t.typeId))) {
          const type = event.ticketTypes.find((t) => t.id === typeId);
          if (!type || type.quota == null) continue;
          const others = event.orders.filter((x) => x !== o && live(x)).reduce((n, x) => n + x.tickets.filter((t) => t.typeId === typeId).length, 0);
          if (others + o.tickets.filter((t) => t.typeId === typeId).length > type.quota) throw new HttpError(409, 'Kontingent reicht für die Zahlungsbestätigung nicht aus');
        }
        o.status = 'paid';
        o.paidAt = new Date().toISOString();
        syncPeople(o);
        if (o.accountId) {
          dm(o.accountId, `✅ Zahlung für **${o.ref}** ist eingegangen – ${o.tickets.length === 1 ? 'dein Ticket ist' : `deine ${o.tickets.length} Tickets sind`} bestätigt.\n`
            + `🎫 Die QR-Codes für den Einlass findest du hier: <${ctx.baseUrl(req)}/#/tickets> – bis bald!`);
        }
      } else {
        o.status = 'pending';
        o.paidAt = null;
        if (o.source === 'box_office') o.paymentMethod = null;
      }
      changed();
      ctx.security.log(b.paid ? 'order_paid' : 'order_unpaid', req, { ref: o.ref });
      send(res, 200, orderView(o, true));
      return true;
    }

    // Ticket zu einem Code (Check-in-Seite nach dem Scannen)
    if (parts[1] === 'code' && parts[2] && method === 'GET') {
      const code = String(parts[2]).toUpperCase();
      const o = allOrders().find((x) => x.tickets.some((t) => t.code === code));
      if (!o) throw new HttpError(404, 'Ticketcode unbekannt');
      const t = o.tickets.find((x) => x.code === code);
      const a = ctx.accounts.find(o.accountId);
      const e = eventOfOrder(o);
      send(res, 200, {
        eventName: e.name, otherEvent: e !== ctx.event.current(), // Ticket für ein anderes als das aktuelle Event
        code: t.code, holder: t.holder, typeName: t.typeName, checkedInAt: t.checkedInAt || null,
        ref: o.ref, status: o.status, buyer: a ? a.discordName : o.buyerName || '',
        others: o.tickets.filter((x) => x !== t).map((x) => ({ code: x.code, holder: x.holder, checkedInAt: x.checkedInAt || null })),
      });
      return true;
    }

    // Check-in per Ticketcode
    if (parts[1] === 'checkin' && parts[2] && method === 'POST') {
      const code = String(parts[2]).toUpperCase();
      const o = allOrders().find((x) => x.tickets.some((t) => t.code === code));
      if (!o) throw new HttpError(404, 'Ticketcode unbekannt');
      const t = o.tickets.find((x) => x.code === code);
      if (o.status !== 'paid') throw new HttpError(400, o.status === 'cancelled' ? 'Ticket ist storniert' : 'Ticket ist noch nicht bezahlt');
      const b = await readBody(req);
      if (o.status !== 'paid') throw new HttpError(400, o.status === 'cancelled' ? 'Ticket ist storniert' : 'Ticket ist noch nicht bezahlt');
      t.checkedInAt = b.undo ? null : (t.checkedInAt || new Date().toISOString());
      changed();
      ctx.security.log(b.undo ? 'checkin_undone' : 'checkin', req, { code: t.code });
      send(res, 200, { holder: t.holder, typeName: t.typeName, checkedInAt: t.checkedInAt, ref: o.ref, eventName: eventOfOrder(o).name });
      return true;
    }

    // Export für Tabellenkalkulation
    if (parts[1] === 'export.csv' && method === 'GET') {
      ctx.security.log('export_personal_data', req);
      const rows = [['Bestellung', 'Status', 'Bestellt am', 'Bezahlt am', 'Ticketart', 'Preis', 'Ticket-Code', 'Name auf Ticket', 'Eingecheckt',
        'Käufer (Discord)', 'Vorname', 'Nachname', 'Straße', 'PLZ', 'Ort', 'E-Mail', 'Geburtsdatum']];
      const statusText = { pending: 'offen', paid: 'bezahlt', cancelled: 'storniert' };
      for (const o of db.orders) {
        const a = ctx.accounts.find(o.accountId);
        const p = (a && a.profile) || o.buyerProfile || {};
        for (const t of o.tickets) {
          rows.push([o.ref, statusText[o.status], o.createdAt.slice(0, 10), (o.paidAt || '').slice(0, 10), t.typeName,
            (t.price / 100).toFixed(2).replace('.', ','), t.code, t.holder, t.checkedInAt ? 'ja' : '',
            a ? a.discordName : o.buyerName || '', p.firstName, p.lastName, p.street, p.zip, p.city, p.email, p.birthdate]);
        }
      }
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="tickets-${ctx.event.scoped().name.replace(/[^\w-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.csv"`,
        'Cache-Control': 'no-store',
      });
      res.end(csv(rows));
      return true;
    }
    return false;
  }

  // Für Discord (/ticket): eigene Bestellungen für laufende und kommende Events
  const ordersOf = (accountId) => allOrders()
    .filter((o) => o.accountId === accountId && o.status !== 'cancelled' && !ctx.event.isOver(eventOfOrder(o)))
    .map((o) => orderView(o));

  return { routes, settings, onAccountDeleted, ordersOf, paymentText, euro, syncPeople, dm };
};
