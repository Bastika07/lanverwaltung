'use strict';
// Eventverwaltung: mehrere LAN-Events (z. B. „Seniorenlan #5“, „#6“). Jedes Event hat eigene Turniere,
// Programm, Infos, Ticketarten, Bestellungen, Teilnahmen und Module. Global bleiben Personen, Konten,
// Sitzplan-Layout, Bankdaten und die übrigen Einstellungen.
//
// Läuft ein Event (automatisch nach Zeitraum oder per Knopf), legt der Bot die Discord-Kategorie mit
// den Ansagekanälen und die Voice-Kanäle der Turniere an, zum Ende löscht er sie. Es läuft immer
// höchstens ein Event. Außerhalb eines laufenden Events gehen keine Ansagen nach Discord.
//
// Welches Event gilt? Webseite, Beamer und Discord zeigen das „aktuelle“ Event: das laufende, sonst das
// nächste geplante, sonst das zuletzt beendete. Der Admin kann ein anderes Event bearbeiten, Besucher
// können für ein anderes Event Tickets kaufen und seine Details ansehen (Header X-Event). Damit die Module nichts davon wissen
// müssen, zeigen db.tournaments, db.orders … per AsyncLocalStorage auf das Event der jeweiligen Anfrage.

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const SCOPED = ['tournaments', 'schedule', 'info', 'ticketTypes', 'orders'];
const SALE_KEYS = ['saleOpen', 'payDays', 'minAge', 'seatSelection'];
const blankInfo = () => ({ wifi: { ssid: '', password: '', note: '' }, servers: [], games: [], rules: '', extra: '' });
const clone = (v) => JSON.parse(JSON.stringify(v));

module.exports = function event(ctx) {
  const { db, save, broadcast, send, readBody, requireAdmin, HttpError, str, settings, Discord } = ctx;
  const newId = () => crypto.randomBytes(5).toString('hex');
  const nowIso = () => new Date().toISOString();

  function blank(name) {
    return {
      id: newId(), name, start: null, end: null, active: false, startedAt: null, endedAt: null, error: null, createdAt: nowIso(),
      sale: { saleOpen: true, payDays: 14, minAge: 0, seatSelection: true },
      modules: { ...settings().modules }, // welche Module dieses Event nutzt
      access: {}, // Modul -> 'tickets': nur für Teilnehmer mit Ticket (sonst öffentlich)
      details: { location: '', address: '', capacity: null, spectatorFee: '', text: '' }, // Eventdetails (siehe lib/details.js)
      serverConfig: { domain: '', ipFrom: '', ipTo: '', open: true, maxPerAccount: 2 }, guestServers: [], // Gastserver (lib/servers.js)
      tournaments: [], schedule: [], info: blankInfo(), ticketTypes: [], orders: [], attendees: [],
      catering: { offers: [], entries: [] },
    };
  }

  // ---------- Umstellung von der Version mit nur einem Event ----------
  if (!Array.isArray(db.events)) {
    const e = blank(settings().eventName);
    const old = db.meta.event || {};
    for (const k of ['start', 'end', 'active', 'startedAt', 'endedAt', 'error']) if (old[k] !== undefined) e[k] = old[k];
    const ts = db.meta.ticketSettings || {};
    for (const k of SALE_KEYS) if (ts[k] !== undefined) e.sale[k] = ts[k];
    for (const k of SCOPED) if (db[k] !== undefined) e[k] = db[k];
    // Teilnehmer: Personen werden global, Platz und Teilnahme gehören zum Event
    db.persons = (db.people || []).map(({ seat, ...p }) => p);
    e.attendees = (db.people || []).map((p) => ({ personId: p.id, seat: p.seat || null }));
    for (const k of [...SCOPED, 'people']) delete db[k];
    delete db.meta.event;
    db.events = [e];
    save();
    console.log(`Daten auf Eventverwaltung umgestellt: Event „${e.name}“`);
  }
  for (const e of db.events) {
    const b = blank(e.name);
    for (const k of [...SCOPED, 'attendees']) e[k] = e[k] || b[k];
    e.sale = { ...b.sale, ...(e.sale || {}) };
    e.modules = { ...b.modules, ...(e.modules || {}) };
    e.access = e.access || {};
    e.details = { ...b.details, ...(e.details || {}) };
    e.serverConfig = { ...b.serverConfig, ...(e.serverConfig || {}) };
    e.guestServers = e.guestServers || [];
  }
  db.persons = db.persons || [];

  // ---------- Welches Event gilt ----------
  const time = (iso, def) => (iso ? Date.parse(iso) : def);
  const activeEvent = () => db.events.find((e) => e.active) || null;
  const isOver = (e, now = Date.now()) => !e.active && (!!e.endedAt || (!!e.end && Date.parse(e.end) <= now));
  function current() {
    const act = activeEvent();
    if (act) return act;
    const open = db.events.filter((e) => !isOver(e));
    if (open.length) return open.sort((a, b) => time(a.start, Infinity) - time(b.start, Infinity) || a.createdAt.localeCompare(b.createdAt))[0];
    const last = (e) => time(e.endedAt || e.end, 0) || Date.parse(e.createdAt);
    return db.events.slice().sort((a, b) => last(b) - last(a))[0];
  }

  const als = new AsyncLocalStorage();
  const scoped = () => { const s = als.getStore(); return (s && db.events.includes(s.event) && s.event) || current(); };
  const run = (e, fn) => als.run({ event: e }, fn);
  for (const k of SCOPED) {
    Object.defineProperty(db, k, { configurable: true, enumerable: false, get: () => scoped()[k], set: (v) => { scoped()[k] = v; } });
  }

  // Event einer Anfrage: Admin frei wählbar, Besucher nur für Tickets/Platzwahl (Vorverkauf), sonst das aktuelle
  function forRequest(req, url, admin) {
    const id = req.headers['x-event'] || url.searchParams.get('event');
    const e = id && db.events.find((x) => x.id === id);
    if (e && (admin || /^\/api\/(tickets|seats|details)(\/|$)/.test(url.pathname))) return e;
    return null;
  }

  const byId = (id) => db.events.find((e) => e.id === id) || null;
  const eventOf = (key, item) => db.events.find((e) => e[key].includes(item)) || null;

  const changed = () => { save(); broadcast('settings'); };

  // Discord-Schritte laufen in derselben Warteschlange wie alle Ansagen
  function discordStep(e, fn) {
    if (!Discord.enabled) return;
    ctx.discordQueue(async () => {
      try { await fn(); e.error = null; } catch (err) { console.error('Event (Discord):', err.message); e.error = err.message; }
      changed();
    });
  }

  function start(e, manual) {
    if (e.active) return;
    const other = activeEvent();
    if (other) end(other, false); // es läuft immer nur ein Event
    e.active = true;
    e.startedAt = nowIso();
    e.endedAt = null;
    if (manual && e.start && Date.parse(e.start) > Date.now()) e.start = e.startedAt; // früher gestartet
    changed();
    console.log(`Event „${e.name}“ gestartet`);
    discordStep(e, async () => {
      await Discord.setupEvent(db.meta, e.name);
      save();
      const until = e.end ? ` Es läuft bis <t:${Math.floor(Date.parse(e.end) / 1000)}:f>.` : '';
      const tournaments = await Discord.announceChannel(db.meta, 'tournaments', e.name);
      await Discord.post(await Discord.announceChannel(db.meta, 'general', e.name),
        `🎮 **${Discord.md(e.name)}** hat begonnen – viel Spaß!${until}\nHier kommen Durchsagen und das Programm, Turniere in <#${tournaments}>.`);
    });
    ctx.tournaments.syncDiscord(); // Voice-Kanäle der Turniere anlegen
    ctx.refreshCommands(); // Slash-Befehle nach den Modulen dieses Events
  }

  function end(e, manual) {
    if (!e.active) return;
    e.active = false;
    e.endedAt = nowIso();
    if (manual && e.end && Date.parse(e.end) > Date.now()) e.end = e.endedAt; // früher beendet
    changed();
    console.log(`Event „${e.name}“ beendet`);
    discordStep(e, async () => { await Discord.teardownEvent(db.meta); save(); });
    ctx.tournaments.syncDiscord(); // Voice-Kanäle der Turniere entfernen
    ctx.refreshCommands(); // Slash-Befehle nach den Modulen des nun aktuellen Events
  }

  // Automatik nach Zeitraum. Ein von Hand beendetes Event startet im selben Zeitraum nicht erneut.
  function tick() {
    const now = Date.now();
    for (const e of db.events) if (e.active && e.end && now >= Date.parse(e.end)) end(e, false);
    for (const e of db.events) {
      const s = e.start ? Date.parse(e.start) : null;
      const en = e.end ? Date.parse(e.end) : null;
      if (!e.active && s && now >= s && (!en || now < en) && !(e.endedAt && Date.parse(e.endedAt) >= s)) start(e, false);
    }
  }
  setInterval(tick, 15000).unref();
  setTimeout(tick, 1500).unref();

  function summary(e) {
    const paid = e.orders.filter((o) => o.status === 'paid');
    return {
      id: e.id, name: e.name, start: e.start, end: e.end, active: e.active, startedAt: e.startedAt, endedAt: e.endedAt,
      error: e.error, createdAt: e.createdAt, over: isOver(e), sale: e.sale, modules: e.modules, access: e.access,
      counts: {
        tournaments: e.tournaments.length, attendees: e.attendees.length, schedule: e.schedule.length,
        tickets: paid.reduce((n, o) => n + o.tickets.length, 0), orders: e.orders.filter((o) => o.status !== 'cancelled').length,
      },
    };
  }

  const date = (v) => {
    if (!v) return null;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new HttpError(400, 'Ungültiges Datum');
    return d.toISOString();
  };
  function setTimes(e, b) {
    const s = b.start !== undefined ? date(b.start) : e.start;
    const en = b.end !== undefined ? date(b.end) : e.end;
    if (s && en && Date.parse(en) <= Date.parse(s)) throw new HttpError(400, 'Das Ende muss nach dem Beginn liegen');
    if (s !== e.start || en !== e.end) e.endedAt = e.active ? e.endedAt : null; // neuer Zeitraum -> Automatik wieder scharf
    e.start = s;
    e.end = en;
  }

  async function routes(req, res, parts, method) {
    if (parts[0] !== 'event') return false;
    requireAdmin(req);
    if (parts.length === 1 && method === 'GET') {
      send(res, 200, { events: db.events.map(summary), currentId: current().id, activeId: (activeEvent() || {}).id || null });
      return true;
    }
    // Neues Event; Infos, Ticketarten und Verkaufseinstellungen vom Vorlage-Event übernehmen
    if (parts.length === 1 && method === 'POST') {
      const b = await readBody(req);
      const name = str(b.name, 60);
      if (!name) throw new HttpError(400, 'Name fehlt');
      const e = blank(name);
      setTimes(e, b);
      const from = b.copyFrom && byId(b.copyFrom);
      if (from) {
        e.info = clone(from.info);
        e.sale = clone(from.sale);
        e.modules = clone(from.modules);
        e.access = clone(from.access);
        e.details = clone(from.details);
        e.serverConfig = clone(from.serverConfig); // Domain und IP-Bereich, die Server selbst nicht
        e.catering.offers = (from.catering?.offers || []).map((o) => ({ ...clone(o), id: newId(), open: false, servingAt: null, deadline: null, version: 1 }));
        e.ticketTypes = from.ticketTypes.map((t) => ({ ...clone(t), id: newId(), saleStart: null, saleEnd: null }));
      }
      db.events.push(e);
      changed();
      ctx.security.log('event_created', req, { name: e.name });
      send(res, 201, summary(e));
      return true;
    }
    const e = byId(parts[1]);
    if (!e) throw new HttpError(404, 'Event nicht gefunden');
    if (parts.length === 2 && method === 'PUT') {
      const b = await readBody(req);
      if (b.name !== undefined) {
        const name = str(b.name, 60);
        if (!name) throw new HttpError(400, 'Name fehlt');
        if (name !== e.name) { e.name = name; if (e.active) discordStep(e, () => Discord.setupEvent(db.meta, e.name)); }
      }
      setTimes(e, b);
      changed();
      tick();
      send(res, 200, summary(e));
      return true;
    }
    if (parts.length === 2 && method === 'DELETE') {
      if (e.active) throw new HttpError(400, 'Ein laufendes Event kann nicht gelöscht werden');
      if (db.events.length === 1) throw new HttpError(400, 'Das letzte Event kann nicht gelöscht werden');
      if (e.orders.length) throw new HttpError(400, 'Für dieses Event gibt es Bestellungen – es bleibt als Archiv erhalten');
      if (e.catering?.entries.length) throw new HttpError(400, 'Für dieses Event gibt es Catering-Anmeldungen – es bleibt als Archiv erhalten');
      db.events = db.events.filter((x) => x !== e);
      changed();
      ctx.security.log('event_deleted', req, { name: e.name });
      send(res, 200, { ok: true });
      return true;
    }
    if (parts[2] === 'start' && method === 'POST') { start(e, true); send(res, 200, summary(e)); return true; }
    if (parts[2] === 'end' && method === 'POST') { end(e, true); send(res, 200, summary(e)); return true; }
    return false;
  }

  return {
    routes, run, forRequest, scoped, current, byId, eventOf,
    all: () => db.events,
    active: () => !!activeEvent(),
    activeEvent,
    isOver,
    // Für Discord-Ansagen: Name des laufenden Events
    activeName: () => (activeEvent() || current()).name,
    state: () => { const e = current(); return { id: e.id, name: e.name, start: e.start, end: e.end, active: e.active }; },
  };
};
