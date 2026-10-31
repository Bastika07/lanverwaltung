'use strict';
// Teilnehmer: Personen sind global (Name, Discord-Verknüpfung, Steam, Notiz) und bleiben über alle
// Events erhalten – so muss niemand bei jedem Event neu angelegt werden, und es gibt Statistiken,
// wer wie oft dabei war. Pro Event steht nur, wer teilnimmt und auf welchem Platz (event.attendees).
// Sitzplan: ein Layout für alle Events – Raster aus Spalten x Zeilen mit frei platzierten Plätzen
// und beschrifteten Flächen (Bereiche wie Bühne oder WC, Wände, Eingänge, Notausgänge).

const crypto = require('crypto');

const PERSON_KEYS = ['id', 'name', 'discordId', 'discordName', 'steam', 'note', 'clan', 'selfClaimed'];
const AREA_KINDS = ['area', 'wall', 'door', 'exit'];

module.exports = function people(ctx) {
  const { db, save, broadcast, send, readBody, requireAdmin, HttpError, str } = ctx;
  db.persons = db.persons || [];
  db.seating = db.seating || { cols: 12, rows: 8, seats: [] };
  db.seating.categories = db.seating.categories || []; // [{ id, name, short, color }] – z. B. "Loge" mit Kürzel "L"
  db.seating.areas = db.seating.areas || []; // [{ id, x, y, w, h, label, color, kind }]

  const newId = () => crypto.randomBytes(5).toString('hex');
  const changed = () => { save(); broadcast('people'); };
  const ev = () => ctx.event.scoped();
  const personById = (id) => db.persons.find((p) => p.id === id) || null;
  const personByName = (name) => db.persons.find((p) => p.name.toLowerCase() === String(name).trim().toLowerCase()) || null;

  // Teilnehmer eines Events = Person + Teilnahme. Die Sicht leitet Zugriffe weiter: Name, Discord usw.
  // an die Person, der Platz an die Teilnahme. Pro Teilnahme immer dieselbe Sicht (Vergleich mit ===).
  const views = new WeakMap();
  function view(a) {
    let v = views.get(a);
    if (v) return v;
    v = {};
    for (const k of PERSON_KEYS) {
      Object.defineProperty(v, k, {
        enumerable: true,
        get: () => (personById(a.personId) || {})[k],
        set: (x) => { const p = personById(a.personId); if (p) p[k] = x; },
      });
    }
    Object.defineProperty(v, 'seat', { enumerable: true, get: () => a.seat, set: (x) => { a.seat = x; } });
    Object.defineProperty(v, 'approved', { enumerable: true, get: () => a.approved === true, set: (x) => { a.approved = x === true; } });
    views.set(a, v);
    return v;
  }

  const list = () => ev().attendees.filter((a) => personById(a.personId)).map(view);
  const byId = (id) => {
    const a = ev().attendees.find((x) => x.personId === id);
    return a && personById(id) ? view(a) : null;
  };
  const byName = (name) => { const p = personByName(name); return p ? byId(p.id) : null; };

  function checkUnique(name, self) {
    const other = personByName(name);
    if (other && other.id !== (self && self.id)) throw new HttpError(400, `„${name}“ gibt es schon`);
  }

  // Person nimmt am Event teil (falls noch nicht)
  function attend(personId, approved = false) {
    if (!personById(personId)) return null;
    let a = ev().attendees.find((x) => x.personId === personId);
    if (!a) { a = { personId, seat: null, approved: false }; ev().attendees.push(a); }
    if (approved) a.approved = true;
    return view(a);
  }

  // Vorhandene Person (gleicher Name) zum Event hinzufügen, sonst neu anlegen
  function add(body) {
    const name = str(body.name, 60);
    if (!name) throw new HttpError(400, 'Name fehlt');
    let p = personByName(name);
    if (!p) {
      p = { id: newId(), name, discordId: null, discordName: '', steam: str(body.steam, 200), note: str(body.note, 200), clan: str(body.clan, 40) };
      db.persons.push(p);
    }
    return attend(p.id);
  }

  // Discord-Konto mit einer Person verknüpfen (über /ich); ein Konto gehört zu höchstens einer Person.
  function linkDiscord(person, user) {
    if (person.discordId && person.discordId !== user.id) throw new HttpError(409, 'Person ist bereits mit einem anderen Discord-Konto verknüpft');
    for (const p of db.persons) if (p.discordId === user.id && p.id !== person.id) { p.discordId = null; p.discordName = ''; }
    const p = personById(person.id);
    p.discordId = user.id;
    p.discordName = user.name;
    changed();
  }

  // Neue Ticketpersonen werden nicht anhand ihres frei wählbaren Namens zusammengeführt.
  function ticketName(name, self) {
    const base = str(name, 50) || 'Teilnehmer';
    let unique = base, i = 2;
    while (personByName(unique) && personByName(unique).id !== (self && self.id)) unique = `${base} (${i++})`;
    return unique;
  }
  function createTicketPerson(name, ownerId) {
    const p = { id: newId(), name: ticketName(name), discordId: null, discordName: '', steam: '', note: '', clan: '', ticketOwnerId: ownerId };
    db.persons.push(p);
    return attend(p.id);
  }

  function selfLink(user, name, code = '') {
    const linked = db.persons.find((p) => p.discordId === user.id);
    const target = personByName(name);
    if (linked && linked === target) return attendAndSave(linked.id);
    if (!target) {
      if (code) throw new HttpError(403, 'Name und gültiger Ticketcode passen nicht zusammen');
      if (linked) throw new HttpError(409, 'Du bist bereits verknüpft – Änderungen bitte über die Orga');
      const p = add({ name }); // unbestätigte Teilnahme, keine geschützten Rechte
      personById(p.id).selfClaimed = true; // nur beansprucht: bindet weder Turniernamen noch Sammelübernahmen
      linkDiscord(p, user);
      return p;
    }
    const proof = ev().orders.some((o) => o.status === 'paid' && o.tickets.some((t) => t.personId === target.id
      && (o.accountId === user.id || (code && t.code === String(code).trim().toUpperCase()))));
    if (!proof) throw new HttpError(403, 'Bestehende Person nur mit eigenem bezahltem Ticket oder Ticketcode verknüpfen – sonst bitte zur Orga');
    linkDiscord(target, user);
    return attendAndSave(target.id);
  }

  // Person zum Discord-Konto; join: am aktuellen Event teilnehmen lassen
  function byDiscord(discordId, join) {
    const p = db.persons.find((x) => x.discordId === discordId);
    if (!p) return null;
    return join ? attend(p.id) : byId(p.id);
  }

  function setSteam(p, v) {
    const steam = str(v, 200);
    if (steam && /^[a-z][a-z0-9+.-]*:/i.test(steam) && !/^https?:\/\//i.test(steam)) throw new HttpError(400, 'Steam: nur http(s)-Links, SteamID oder Profilname');
    p.steam = steam;
  }

  // Gemeinsame Felder einer Person (Teilnehmer- und Personenverwaltung)
  function updatePerson(p, b) {
    if (b.name !== undefined) {
      const name = str(b.name, 60);
      if (!name) throw new HttpError(400, 'Name fehlt');
      checkUnique(name, p);
      rename(p, name);
    }
    if (b.steam !== undefined) setSteam(p, b.steam);
    if (b.note !== undefined) p.note = str(b.note, 200);
    if (b.clan !== undefined) p.clan = str(b.clan, 40);
    if (b.unlinkDiscord) { p.discordId = null; p.discordName = ''; }
    if (b.discordId !== undefined && b.discordId) {
      const id = str(b.discordId, 25);
      if (!/^\d{5,25}$/.test(id)) throw new HttpError(400, 'Ungültige Discord-ID');
      linkDiscord(p, { id, name: str(b.discordName, 80) || p.name });
    }
  }

  function rename(p, name) {
    const previous = p.name;
    p.name = name;
    for (const e of ctx.event.all()) for (const t of e.tournaments) {
      if ((t.teamSize || 1) <= 1) {
        t.participants = t.participants.map((n) => n === previous ? name : n);
        if (Object.hasOwn(t.playerIds || {}, previous)) {
          t.playerIds = Object.fromEntries(Object.entries(t.playerIds).map(([key, id]) => [key === previous ? name : key, id]));
        }
        if (t.discord && Object.hasOwn(t.discord.channels || {}, previous)) {
          t.discord.channels = Object.fromEntries(Object.entries(t.discord.channels).map(([key, id]) => [key === previous ? name : key, id]));
        }
      }
    }
  }

  // Statistik: an welchen Events war jemand dabei (Teilnahme), wie oft eingecheckt
  function stats(p) {
    const events = ctx.event.all().filter((e) => e.attendees.some((a) => a.personId === p.id));
    const checkedIn = ctx.event.all().filter((e) => e.orders.some((o) => o.status === 'paid' && o.tickets.some((t) => t.personId === p.id && t.checkedInAt)));
    const account = (db.accounts || []).some((a) => a.id === p.discordId);
    return { events: events.map((e) => ({ id: e.id, name: e.name, start: e.start })), checkedIn: checkedIn.length, account };
  }

  // Zwei Einträge derselben Person zusammenführen (z. B. „Anna“ und „Anna B.“)
  function merge(from, into) {
    if (ctx.catering) ctx.catering.checkMerge(from, into);
    const owners = new Set(ctx.event.all().flatMap((e) => e.orders.flatMap((o) =>
      o.tickets.filter((t) => [from.id, into.id].includes(t.personId)).map(() => o.accountId || o.ownerKey || `order:${o.id}`))));
    if (owners.size > 1) throw new HttpError(409, 'Personen verschiedener Ticketkäufer können nicht zusammengeführt werden');
    if (from.discordId && into.discordId && from.discordId !== into.discordId) throw new HttpError(409, 'Zuerst Discord-Verknüpfungen prüfen');
    if (owners.size) into.ticketOwnerId = [...owners][0];
    for (const e of ctx.event.all()) {
      const a = e.attendees.find((x) => x.personId === from.id);
      if (a) {
        const b = e.attendees.find((x) => x.personId === into.id);
        if (b) { b.seat = b.seat || a.seat; b.approved = b.approved === true || a.approved === true; e.attendees = e.attendees.filter((x) => x !== a); } else a.personId = into.id;
      }
      for (const o of e.orders) for (const t of o.tickets) if (t.personId === from.id) t.personId = into.id;
      for (const t of e.tournaments) for (const ids of Object.values(t.members || {})) {
        const i = ids.indexOf(from.id);
        if (i >= 0) { if (ids.includes(into.id)) ids.splice(i, 1); else ids[i] = into.id; }
      }
      for (const t of e.tournaments) for (const key of Object.keys(t.playerIds || {})) if (t.playerIds[key] === from.id) t.playerIds[key] = into.id;
    }
    if (!into.discordId && from.discordId) { into.discordId = from.discordId; into.discordName = from.discordName; }
    if (from.selfClaimed !== true) delete into.selfClaimed; // bewusste Zusammenführung mit einer geprüften Person
    if (!into.steam) into.steam = from.steam;
    if (!into.note) into.note = from.note;
    if (ctx.catering) ctx.catering.merge(from, into);
    db.persons = db.persons.filter((x) => x !== from);
  }

  // Only persisted Discord links and ticket person IDs establish access to buyer data.
  function ticketAccounts(p) {
    const targets = new Map();
    const accountTarget = (id, relationship) => {
      const a = ctx.accounts.find(id);
      if (!a || targets.has(`account:${a.id}`)) return;
      targets.set(`account:${a.id}`, { kind: 'account', id: a.id, relationship, name: a.discordName,
        profile: a.profile || null, consentAt: a.consentAt || null,
        version: crypto.createHash('sha256').update(JSON.stringify([a.profile || null, a.consentAt || null])).digest('hex') });
    };
    if (p.discordId) accountTarget(p.discordId, 'own');
    for (const e of ctx.event.all()) for (const o of e.orders) {
      if (!o.tickets.some((t) => t.personId === p.id)) continue;
      if (o.source === 'box_office') {
        targets.set(`order:${o.id}`, { kind: 'order', id: o.id, relationship: 'box_office', name: o.buyerName,
          profile: o.buyerProfile || null, version: o.version, eventId: e.id, eventName: e.name, ref: o.ref });
      } else if (o.accountId) accountTarget(o.accountId, 'buyer');
    }
    return [...targets.values()];
  }

  async function routes(req, res, parts, method) {
    if (parts[0] === 'seating' && method === 'PUT') {
      requireAdmin(req);
      const b = await readBody(req);
      const cols = Math.min(Math.max(Number(b.cols) || 12, 2), 80);
      const rows = Math.min(Math.max(Number(b.rows) || 8, 2), 60);
      if (!Array.isArray(b.seats) || b.seats.length > 1000) throw new HttpError(400, 'Ungültige Plätze');
      // Kategorien (Bereiche mit Farbe)
      const cats = Array.isArray(b.categories) ? b.categories.slice(0, 20) : db.seating.categories;
      const categories = [];
      for (const c of cats) {
        const name = str(c.name, 40);
        if (!name) continue;
        categories.push({
          id: /^[a-f0-9]{10}$/.test(c.id) ? c.id : newId(), name, short: str(c.short, 2),
          color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color.toLowerCase() : '#4f8cff',
        });
      }
      const catIds = new Set(categories.map((c) => c.id));
      const seen = new Set();
      const seats = [];
      for (const s of b.seats) {
        const x = Number(s.x), y = Number(s.y);
        if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= cols || y >= rows) continue;
        if (seen.has(`${x},${y}`)) continue;
        seen.add(`${x},${y}`);
        seats.push({
          id: /^[a-f0-9]{10}$/.test(s.id) ? s.id : newId(), x, y, label: str(s.label, 12),
          category: catIds.has(s.category) ? s.category : null,
          locked: !!s.locked, // fixiert: nicht selbst buchbar, Defragmentierung lässt ihn stehen
        });
      }
      // Flächen: Rechtecke im Raster, ganz innerhalb des Plans
      const areas = [];
      for (const a of (Array.isArray(b.areas) ? b.areas : db.seating.areas).slice(0, 150)) {
        const x = Math.floor(Number(a.x)), y = Math.floor(Number(a.y));
        const w = Math.floor(Number(a.w)), h = Math.floor(Number(a.h));
        if (![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w < 1 || h < 1 || x + w > cols || y + h > rows) continue;
        areas.push({
          id: /^[a-f0-9]{10}$/.test(a.id) ? a.id : newId(), x, y, w, h, label: str(a.label, 40),
          kind: AREA_KINDS.includes(a.kind) ? a.kind : 'area',
          color: /^#[0-9a-f]{6}$/i.test(a.color) ? a.color.toLowerCase() : '#6b7a99',
        });
      }
      db.seating = { cols, rows, seats, categories, areas };
      const ids = new Set(seats.map((s) => s.id));
      // Das Layout gilt für alle Events: entfernte Plätze überall freigeben
      for (const e of ctx.event.all()) for (const a of e.attendees) if (a.seat && !ids.has(a.seat)) a.seat = null;
      changed();
      send(res, 200, db.seating);
      return true;
    }

    // ---------- Personenverwaltung (global, nur Admin) ----------
    if (parts[0] === 'persons') {
      requireAdmin(req);
      if (parts.length === 1 && method === 'GET') {
        send(res, 200, db.persons.map((p) => ({ ...p, ...stats(p) })));
        return true;
      }
      const p = personById(parts[1]);
      if (!p) throw new HttpError(404, 'Person nicht gefunden');
      if (parts.length === 3 && parts[2] === 'ticket-accounts' && method === 'GET') {
        send(res, 200, { person: { id: p.id, name: p.name }, targets: ticketAccounts(p) });
        return true;
      }
      if (parts.length === 5 && parts[2] === 'ticket-accounts' && method === 'PUT') {
        const b = await readBody(req);
        requireAdmin(req);
        const current = personById(parts[1]);
        if (!current) throw new HttpError(404, 'Person nicht gefunden');
        const target = ticketAccounts(current).find((x) => x.kind === parts[3] && x.id === parts[4]);
        if (!target) throw new HttpError(404, 'Verknüpfte Ticketdaten nicht gefunden');
        if (b.version !== target.version) throw new HttpError(409, 'Die Daten wurden inzwischen geändert. Bitte den aktuellen Stand neu laden.');
        if (!b.profile || typeof b.profile !== 'object' || Array.isArray(b.profile)) throw new HttpError(400, 'Käuferdaten fehlen');
        const profile = ctx.accounts.cleanProfile(b.profile);
        if (target.kind === 'account') {
          ctx.accounts.find(target.id).profile = profile;
        } else {
          const e = ctx.event.all().find((x) => x.id === target.eventId);
          const o = e.orders.find((x) => x.id === target.id);
          const minAge = e.sale.minAge;
          if (minAge > 0 && ctx.accounts.age(profile.birthdate) < minAge) throw new HttpError(400, `Die Teilnahme ist erst ab ${minAge} Jahren möglich`);
          o.buyerProfile = profile;
          o.buyerName = `${profile.firstName} ${profile.lastName}`;
          o.version++;
        }
        save();
        for (const type of ['accounts', 'tickets', 'people']) broadcast(type);
        ctx.security.log('person_ticket_account_updated', req, { personId: current.id, kind: target.kind, id: target.id });
        send(res, 200, ticketAccounts(current).find((x) => x.kind === target.kind && x.id === target.id));
        return true;
      }
      if (parts.length === 2 && method === 'PUT') {
        updatePerson(p, await readBody(req));
        changed();
        send(res, 200, { ...p, ...stats(p) });
        return true;
      }
      if (parts.length === 2 && method === 'DELETE') {
        for (const e of ctx.event.all()) e.attendees = e.attendees.filter((a) => a.personId !== p.id);
        db.persons = db.persons.filter((x) => x !== p);
        changed();
        ctx.security.log('person_deleted', req);
        send(res, 200, { ok: true });
        return true;
      }
      if (parts[2] === 'merge' && method === 'POST') {
        const into = personById((await readBody(req)).into);
        if (!into || into === p) throw new HttpError(400, 'Bitte eine andere Person wählen');
        merge(p, into);
        changed();
        send(res, 200, { ...into, ...stats(into) });
        return true;
      }
      return false;
    }

    // ---------- Teilnehmer des Events ----------
    if (parts[0] !== 'people') return false;
    if (parts.length === 1 && method === 'GET') {
      const admin = ctx.isAdmin(req);
      const seatsVisible = admin || (ctx.moduleOn('seating') && ctx.mayView(req, 'seating'));
      const people = admin ? list() : list().map((p) => ({ id: p.id, name: p.name, discordName: p.discordName,
        steam: p.steam, clan: p.clan || '', seat: seatsVisible ? p.seat : null }));
      send(res, 200, { people, seating: seatsVisible ? db.seating : { cols: 12, rows: 8, seats: [], categories: [], areas: [] } });
      return true;
    }
    requireAdmin(req);

    if (parts.length === 1 && method === 'POST') {
      const b = await readBody(req);
      // Mehrere auf einmal: neue Namen (eine Zeile pro Name) und/oder bekannte Personen
      if (Array.isArray(b.names) || Array.isArray(b.personIds)) {
        const added = [];
        // Namenslisten bestätigen keine selbst beanspruchten Personen – das bleibt eine bewusste Freigabe.
        for (const n of b.names || []) if (str(n, 60)) { const p = add({ name: n }); if (!claimed(p.id)) p.approved = true; added.push(p); }
        for (const id of b.personIds || []) if (personById(id)) { confirm(id); added.push(attend(id, true)); }
        changed();
        send(res, 201, added);
      } else {
        if (byName(b.name)) throw new HttpError(400, `„${str(b.name, 60)}“ ist schon dabei`);
        const p = add(b);
        if (!claimed(p.id)) p.approved = true;
        changed();
        send(res, 201, p);
      }
      return true;
    }

    const p = byId(parts[1]);
    if (!p) throw new HttpError(404, 'Teilnehmer nicht gefunden');
    if (parts.length === 2 && method === 'PUT') {
      const b = await readBody(req);
      updatePerson(personById(p.id), b);
      if (b.approved !== undefined) p.approved = b.approved === true;
      if (b.approved === true) confirm(p.id);
      if (b.seat !== undefined) {
        if (b.seat && !db.seating.seats.some((s) => s.id === b.seat)) throw new HttpError(400, 'Platz gibt es nicht');
        for (const o of list()) if (b.seat && o.seat === b.seat && o !== p) o.seat = null; // Platz wechselt
        p.seat = b.seat || null;
      }
      changed();
      send(res, 200, p);
      return true;
    }
    // Nur aus diesem Event entfernen – die Person bleibt in der Personenverwaltung
    if (parts.length === 2 && method === 'DELETE') {
      ev().attendees = ev().attendees.filter((a) => a.personId !== p.id);
      changed();
      send(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  const seatOf = (p) => db.seating.seats.find((s) => s.id === p.seat) || null;

  const addAndSave = (body) => { const p = add(body); changed(); return p; };
  // Clan einer Person setzen (global; z. B. /clan oder auf der Ticketseite)
  function setClan(personId, clan) {
    const p = personById(personId);
    if (!p) return null;
    p.clan = str(clan, 40);
    changed();
    return p;
  }
  // Speichert nur, wenn die Teilnahme neu entsteht – lesende Abrufe (z. B. „Meine Plätze“) schreiben sonst nicht.
  const attendAndSave = (id) => { const had = ev().attendees.some((x) => x.personId === id); const p = attend(id); if (p && !had) changed(); return p; };
  // Bewusste Orga-Entscheidung (Freigabe oder Auswahl genau dieser Person) macht eine beanspruchte Person geprüft.
  const confirm = (id) => { const p = personById(id); if (p) delete p.selfClaimed; };
  const claimed = (id) => (personById(id) || {}).selfClaimed === true;

  const personByDiscord = (discordId) => db.persons.find((p) => p.discordId === discordId) || null;

  return { routes, add: addAndSave, attend: attendAndSave, byName, byId, byDiscord, personByDiscord, linkDiscord, selfLink, createTicketPerson, ticketName, rename, seatOf, list, setClan, personById };
};
