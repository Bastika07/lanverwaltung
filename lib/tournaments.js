'use strict';
// Turniere: Teilnehmerlisten, Bindungen an Personen, Ergebnisse, Bestätigungen, Protokoll und Spielplan.
// Aufrufer wählen das Event ausdrücklich (of(event), siehe docs/adr/0001-explizites-event-im-turniermodul.md).
// Discord erfährt Änderungen nur über den notifier (lib/tournament-discord.js); dieses Modul kennt Discord nicht.

const crypto = require('crypto');
const Bracket = require('../public/bracket.js');
const Tmt = require('./tmt.js');

// Spielplan zeigt einen Sieger: Turnier läuft und ist vollständig ausgespielt
function isFinished(t) {
  if (t.status !== 'running') return false;
  const view = Bracket.compute(t);
  return !!(view && view.finished);
}

// Unentschieden nur bei „jeder gegen jeden“ und in Gruppenspielen
const drawAllowed = (t, m) => t.type === 'rr' || (t.type === 'groups' && m.id.startsWith('G'));
const clampInt = (v, min, max, def) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def; };

// ---------- Bindung von Turniereinträgen an Personen ----------
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

// Seite ('a' | 'b'), für die das Konto in diesem Spiel meldet, sonst null
function sideOf(db, discordId, tournament, match) {
  const own = reportableSides(db, discordId, tournament);
  if (Number.isInteger(match.a) && own.has(match.a)) return 'a';
  if (Number.isInteger(match.b) && own.has(match.b)) return 'b';
  return null;
}

// Turnierleiter: von der Orga ausgewählte Personen (feste Personen-IDs), nur für dieses Turnier
function isReferee(db, discordId, tournament) {
  if (!discordId || !Array.isArray(tournament.referees) || !tournament.referees.length) return false;
  const ids = new Set((db.persons || []).filter((p) => p.discordId === discordId).map((p) => p.id));
  return tournament.referees.some((id) => ids.has(id));
}

// Personen-IDs, die in einem Turnier angemeldet sind (Einzelplatz oder Teammitglied)
function personIn(tournament, personId) {
  if ((tournament.teamSize || 1) > 1) return Object.values(tournament.members || {}).some((ids) => Array.isArray(ids) && ids.includes(personId));
  return Object.values(tournament.playerIds || {}).includes(personId);
}

// Name ist keine Identität: Turniereinträge werden nur ausdrücklich gebunden – Personenauswahl der Orga (chosen,
// vom Aufrufer geprüft), /anmelden oder Teambeitritt. Bestehende Bindungen bleiben (bei refresh nur, solange die
// Person so heißt). Einzige Ausnahme: einmalige Migration alter Turniere ohne playerIds über gleichnamige,
// nicht selbst beanspruchte Personen.
function bindPlayers(db, tournament, refresh = false, chosen = {}) {
  const legacy = !tournament.playerIds;
  const old = tournament.playerIds || {};
  const person = (id) => (db.persons || []).find((p) => p.id === id);
  tournament.playerIds = Object.fromEntries(tournament.participants.map((name) => {
    if (Object.hasOwn(chosen, name)) return [name, chosen[name]];
    const kept = Object.hasOwn(old, name) ? old[name] : undefined;
    if (kept !== undefined && (!refresh || (kept && (person(kept) || {}).name === name))) return [name, kept];
    if (!legacy) return [name, null];
    return [name, ((db.persons || []).find((p) => p.name === name && p.selfClaimed !== true) || {}).id || null];
  }));
}

// deps: db (Personen), save, broadcast, HttpError, str, notifier, revision() (steigt mit jeder Speicherung),
// coinBudget() (Coins je Person und Event, 0 = aus), mayEnter(e, discordId) (darf sich zu Turnieren des Events
// anmelden: Teilnehmer mit Ticket, sofern das Event Tickets hat). Die HTTP-Seite (/api/tournaments) liegt in
// lib/tournament-http.js und ruft nur die Operationen aus of(e) auf.
module.exports = function tournaments({ db, save, broadcast, HttpError, str, notifier, revision, coinBudget = () => 0, mayEnter = () => true }) {
  function cleanParticipants(list) {
    if (!Array.isArray(list)) throw new HttpError(400, 'Teilnehmerliste fehlt');
    const names = list.map((s) => String(s).trim()).filter(Boolean);
    if (names.length > 256) throw new HttpError(400, 'Maximal 256 Teilnehmer');
    if (names.some((n) => n.length > Bracket.NAME_MAX)) throw new HttpError(400, `Namen dürfen höchstens ${Bracket.NAME_MAX} Zeichen lang sein`);
    const seen = new Set();
    for (const n of names) {
      const k = n.toLowerCase();
      if (seen.has(k)) throw new HttpError(400, `Teilnehmer doppelt: ${n}`);
      seen.add(k);
    }
    return names;
  }

  const cleanType = (v) => (['ko', 'de', 'rr', 'groups'].includes(v) ? v : 'ko');
  // Gruppenphase: Anzahl Gruppen und wie viele je Gruppe in die K.-o.-Runde kommen
  function cleanGroups(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { count: 4, advance: 2 };
    return { count: clampInt(v.count, 2, 16, 4), advance: clampInt(v.advance, 1, 4, 2) };
  }
  // Preise je Platz (Platz 1 zuerst), nur Text
  function cleanPrizes(v) {
    if (v == null) return [];
    if (!Array.isArray(v)) throw new HttpError(400, 'Preise: Liste erwartet');
    const list = v.slice(0, 16).map((x) => str(x, 100));
    while (list.length && !list[list.length - 1]) list.pop();
    return list;
  }
  // Startzeiten je Runde: { Rundenschlüssel: ISO-Zeit } (Schlüssel aus Bracket: r0, w1, l2, g0, gd0, kr0, p3, kp3, gf1, gf2)
  const ROUND_KEY = /^(?:(?:r|w|l|g|gd|kr)\d{1,2}|p3|kp3|gf1|gf2)$/;
  function cleanRoundTimes(v) {
    if (v == null) return {};
    if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'Rundenzeiten: Objekt erwartet');
    const out = {};
    for (const [k, iso] of Object.entries(v).slice(0, 80)) {
      if (!ROUND_KEY.test(k) || !iso) continue;
      const ms = Date.parse(String(iso));
      if (!Number.isFinite(ms)) throw new HttpError(400, 'Rundenzeiten: ungültige Uhrzeit');
      out[k] = new Date(ms).toISOString();
    }
    return out;
  }
  function cleanDate(v) {
    if (!v) return null;
    const ms = Date.parse(String(v));
    if (!Number.isFinite(ms)) throw new HttpError(400, 'Ungültiges Datum');
    return new Date(ms).toISOString();
  }
  // Turnierleiter: nur bestehende Personen (feste IDs)
  function cleanReferees(v) {
    if (v == null) return [];
    if (!Array.isArray(v)) throw new HttpError(400, 'Turnierleiter: Liste erwartet');
    const ids = [...new Set(v.filter((id) => typeof id === 'string'))].slice(0, 20);
    if (ids.some((id) => !db.persons.some((p) => p.id === id))) throw new HttpError(400, 'Turnierleiter: unbekannte Person');
    return ids;
  }
  // Optionale Turnierfelder (Anlegen, Bearbeiten). Gibt nur übergebene Felder zurück; alles wird vor dem Ändern geprüft.
  function tournamentExtras(body) {
    const out = {};
    if (body.groups !== undefined) out.groups = cleanGroups(body.groups);
    if (body.prizes !== undefined) out.prizes = cleanPrizes(body.prizes);
    if (body.roundTimes !== undefined) out.roundTimes = cleanRoundTimes(body.roundTimes);
    if (body.maxParticipants !== undefined) out.maxParticipants = clampInt(body.maxParticipants, 0, 256, 0);
    if (body.signupUntil !== undefined) out.signupUntil = cleanDate(body.signupUntil);
    if (body.seeds !== undefined) out.seeds = clampInt(body.seeds, 0, 256, 0);
    if (body.coins !== undefined) out.coins = clampInt(body.coins, 0, 99, 0);
    if (body.confirm !== undefined) out.confirm = !!body.confirm;
    if (body.confirmMinutes !== undefined) out.confirmMinutes = clampInt(body.confirmMinutes, 1, 120, 10);
    if (body.referees !== undefined) out.referees = cleanReferees(body.referees);
    return out;
  }
  const cleanTeamSize = (v) => { const n = Math.floor(Number(v)); return n >= 1 && n <= 20 ? n : 1; };
  // CS2-Turnier mit TMT2 abgleichen (lib/tmt.js): null = aus, sonst Format für alle Spiele und für das Finale
  function cleanCs2(v) {
    if (!v) return null;
    if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'Ungültige CS2-Einstellung');
    const ok = (f) => Object.hasOwn(Tmt.FORMATS, f);
    if (!ok(v.format) || (v.finalFormat != null && v.finalFormat !== '' && !ok(v.finalFormat))) throw new HttpError(400, 'Unbekanntes CS2-Format');
    return { format: v.format, finalFormat: ok(v.finalFormat) ? v.finalFormat : v.format };
  }

  // Ergebnisse entfernen, die nach einer Änderung nicht mehr zu den Paarungen passen.
  // Offene Meldungen und „läuft“ gelten nur für spielbereite Spiele mit unveränderter Paarung.
  // Gibt die Ansicht nach der Änderung zurück: Der Spielplan prüft jeden Eintrag gegen die aktuelle Paarung,
  // das Entfernen veralteter Einträge ändert sie also nicht.
  function pruneStale(t) {
    const view = Bracket.compute(t);
    if (!view) return view;
    const valid = new Set(view.matches.filter((m) => m.status === 'done').map((m) => m.id));
    for (const id of Object.keys(t.results)) if (!valid.has(id)) delete t.results[id];
    const ready = new Map(view.matches.filter((m) => m.status === 'ready').map((m) => [m.id, m]));
    for (const key of ['pending', 'playing']) {
      if (!t[key]) continue;
      for (const [id, x] of Object.entries(t[key])) {
        const m = ready.get(id);
        if (!m || x.pa !== m.a || x.pb !== m.b) delete t[key][id];
      }
    }
    return view;
  }

  // Protokoll je Spiel (nur Orga und Turnierleitung sehen es), die letzten 300 Einträge
  function logMatch(t, m, text, by) {
    t.log = (t.log || []).concat({ at: new Date().toISOString(), match: m ? m.id : null, label: m ? str(m.label, 80) : '', text: str(text, 200), by: str(by, 80) }).slice(-300);
  }

  // Für das Protokoll: Ergebnis bzw. wer kampflos gewinnt
  const scoreText = (t, m, r) => (r.wo ? `${t.participants[r.wo === 'a' ? m.b : m.a]} gewinnt kampflos` : `${r.a}:${r.b}`);

  const changed = (t) => { save(); broadcast('tournament', t.id); };

  // Ergebnis festschreiben (Meldung, Bestätigung, Orga, TMT2): Gewinner wandert weiter, abhängige Ergebnisse
  // verfallen, Discord erfährt es. before: Ansicht vor der Änderung (laufendes Turnier).
  function commitResult(t, before, m, r, by, text) {
    const correction = m.status === 'done';
    t.results[m.id] = { ...r, pa: m.a, pb: m.b, at: new Date().toISOString() };
    if (t.pending) delete t.pending[m.id];
    if (t.playing) delete t.playing[m.id];
    const after = pruneStale(t);
    logMatch(t, m, `${text} ${scoreText(t, m, r)}`, by);
    notifier.resultReported(t, { before, after, matchId: m.id, correction, wasFinished: !!before.finished });
    changed(t);
  }

  // ---------- Akteure und Spiele ----------
  // actor: { admin: true } (Orga), { discordId } (angemeldetes Konto) oder { tmt2: true }. Wer handelt, weist der
  // Aufrufer nach; was er darf, entscheidet dieses Modul.
  function role(actor, t) {
    if (actor.tmt2) return { tmt2: true, admin: false, referee: false, manage: false, discordId: null, name: 'TMT2' };
    const admin = !!actor.admin;
    const discordId = actor.discordId || null;
    const referee = !admin && !!discordId && isReferee(db, discordId, t);
    const person = discordId ? (db.persons || []).find((p) => p.discordId === discordId) : null;
    const name = admin ? 'Orga' : person ? person.name + (referee ? ' (Turnierleitung)' : '') : 'Unbekannt';
    return { tmt2: false, admin, referee, manage: admin || referee, discordId, name };
  }
  // Ohne Spielplanberechnung prüfbar: darf der Akteur dieses Turnier leiten?
  const canManage = (actor, t) => role(actor, t).manage;
  const requireManage = (me) => { if (!me.manage) throw new HttpError(401, 'Nur Orga oder Turnierleitung'); };
  const requireAdmin = (actor) => { if (!actor.admin) throw new HttpError(401, 'Admin-Login erforderlich'); };
  const notTmt = (me) => { if (me.tmt2) throw new HttpError(403, 'Für TMT2 nicht erlaubt'); };

  // Spiel eines laufenden Turniers samt Ansicht davor; Spieler nur für eigene Spiele (side: 'a' | 'b')
  function matchFor(me, t, matchId) {
    if (t.status !== 'running') throw new HttpError(400, 'Turnier läuft nicht');
    const before = Bracket.compute(t);
    const m = before.matches.find((x) => x.id === matchId);
    if (!m) throw new HttpError(404, 'Spiel nicht gefunden');
    const side = me.manage ? null : sideOf(db, me.discordId, t, m);
    if (!me.manage && !side) throw new HttpError(403, 'Nur beteiligte Spieler oder Teammitglieder dürfen das Ergebnis eintragen');
    return { before, m, side };
  }
  // Offene Meldung, solange die Paarung unverändert ist
  const pendingOf = (t, m) => { const p = t.pending && t.pending[m.id]; return p && p.pa === m.a && p.pb === m.b ? p : null; };
  const score = (v) => (['number', 'string'].includes(typeof v) ? Number(v) : NaN);

  // Ergebnis aus TMT2: nur für ein offenes Spiel mit unveränderter Paarung, nie als Korrektur, gilt sofort.
  // maps: gespielte Maps mit Rundenstand ({ name, a, b }), wird zur Anzeige am Ergebnis gespeichert.
  function reportFromTmt(t, matchId, { a, b, pa, pb, maps }) {
    const no = (text) => { throw new HttpError(409, `${text} – Ergebnis bitte von Hand eintragen`); };
    if (t.status !== 'running') no('Turnier läuft nicht');
    const before = Bracket.compute(t);
    const m = before.matches.find((x) => x.id === matchId);
    if (!m) no('Spiel nicht mehr im Turnierbaum');
    if (m.status === 'done') {
      if (m.score && m.score.a === a && m.score.b === b && m.a === pa && m.b === pb) return;
      throw new HttpError(409, 'Im Turnier steht schon ein anderes Ergebnis');
    }
    if (m.status !== 'ready' || m.a !== pa || m.b !== pb) no('Die Paarung hat sich geändert');
    if (!Number.isInteger(a) || !Number.isInteger(b) || (!drawAllowed(t, m) && a === b)) no('Kein eindeutiger Sieger');
    const played = (Array.isArray(maps) ? maps : []).slice(0, 9).map((x) => ({ name: str(x.name, 60), a: x.a, b: x.b }))
      .filter((x) => [x.a, x.b].every((n) => Number.isInteger(n) && n >= 0 && n <= 999));
    commitResult(t, before, m, { a, b, ...(played.length ? { maps: played } : {}) }, 'TMT2', 'Ergebnis aus TMT2:');
  }

  // Team-Mitglieder an geänderte Teilnehmerliste anpassen (umbenannt -> mitnehmen, entfernt -> löschen)
  // Teamnamen sind Nutzerdaten (auch „__proto__“): nur eigene Schlüssel lesen, per fromEntries als eigene Felder anlegen.
  // Captains und Beitrittsanfragen gehen mit.
  function applyMembers(t, names, renames = {}) {
    const to = (team) => (Object.hasOwn(renames, team) ? renames[team] : team);
    const keyed = (obj) => Object.fromEntries(Object.entries(obj).map(([team, v]) => [to(team), v]).filter(([name]) => names.includes(name)));
    if (t.members) t.members = keyed(t.members);
    if (t.captains) t.captains = keyed(t.captains);
    if (t.requests) t.requests = t.requests.map((r) => ({ ...r, team: to(r.team) })).filter((r) => names.includes(r.team));
  }

  // Personenauswahl der Orga im Turnierformular: { Eintragsname: Personen-ID | null }. Nur eigene Schlüssel,
  // nur Einträge dieses Turniers und nur Personen, die genau so heißen (keine veraltete oder abweichende Auswahl).
  function chosenPlayers(names, raw) {
    if (raw === undefined) return {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'Ungültige Personenauswahl');
    return Object.fromEntries(Object.entries(raw).filter(([name]) => names.includes(name)).map(([name, id]) => {
      if (id === null) return [name, null];
      const p = typeof id === 'string' && db.persons.find((x) => x.id === id);
      if (!p || p.name !== name) throw new HttpError(400, `Ausgewählte Person passt nicht zu „${name.slice(0, 60)}“`);
      return [name, p.id];
    }));
  }

  // Lesepfade berechnen den Spielplan nur nach Änderungen neu (Rundenturnier mit 256 Teilnehmern: 32.640 Spiele).
  // Die Ansicht wird zwischen Anfragen geteilt und darf nicht verändert werden; schreibende Pfade rechnen selbst.
  const viewCache = new WeakMap();
  function view(t) {
    const hit = viewCache.get(t);
    if (hit && hit.revision === revision()) return hit.view;
    const fresh = Bracket.compute(t);
    viewCache.set(t, { revision: revision(), view: fresh });
    return fresh;
  }

  function summary(t) {
    const v = t.status === 'running' ? view(t) : null;
    return {
      id: t.id, name: t.name, game: t.game, type: t.type, status: t.status,
      participants: t.participants.length, createdAt: t.createdAt,
      teamSize: t.teamSize || 1, signup: !!t.signup, coins: t.coins || 0,
      finished: !!(v && v.finished),
      champion: v && v.champion != null ? t.participants[v.champion] : null,
    };
  }

  // Was ein Akteur von einem Turnier sieht: Orga alles; Turnierleiter zusätzlich das Protokoll; Spieler ihre
  // meldbaren Spiele. Ohne eigene Teilnehmerplätze (z. B. anonym) entfällt die Spielplanberechnung ganz.
  function present(actor, t) {
    if (actor.admin) return t;
    const { discord, discordStatus, announceError, log, referees, requests, ...pub } = t; // Beitrittsanfragen nur über /signup
    if (actor.discordId && isReferee(db, actor.discordId, t)) return { ...pub, log: log || [], referee: true, reportableMatches: [], mySides: {} };
    const own = reportableSides(db, actor.discordId, t);
    const v = own.size ? view(t) : null;
    const mine = v ? v.matches.filter((m) => own.has(m.a) || own.has(m.b)) : [];
    return { ...pub, reportableMatches: mine.map((m) => m.id), mySides: Object.fromEntries(mine.map((m) => [m.id, own.has(m.a) ? 'a' : 'b'])) };
  }

  const newId = () => crypto.randomBytes(5).toString('hex');

  // ---------- Anmeldung (Discord) ----------
  // Ablehnung mit Grund (code) und Daten; Discord formuliert daraus eigene Texte (lib/commands.js).
  const refuse = (status, code, message, data = {}) => Object.assign(new HttpError(status, message), { code, data });
  const isTeam = (t) => (t.teamSize || 1) > 1;
  // Offene Anmeldung: Entwurf mit Anmeldung, vor dem Anmeldeschluss
  const isOpen = (t) => t.status === 'draft' && !!t.signup && !(t.signupUntil && Date.parse(t.signupUntil) <= Date.now());
  const named = (t, name) => t.participants.some((n) => n.toLowerCase() === name.toLowerCase());
  // Eigener Eintrag nur über die gebundene Personen-ID, nie über den (beanspruchbaren) Anzeigenamen
  const ownEntry = (t, p) => t.participants.find((n) => Object.hasOwn(t.playerIds || {}, n) && t.playerIds[n] === p.id);
  // Teamnamen sind frei wählbar (auch „__proto__“): nur eigene Einträge lesen, neue als eigene Felder anlegen.
  const teamIds = Bracket.teamMembers;
  const teamOf = (t, p) => Object.keys(t.members || {}).find((team) => teamIds(t, team).includes(p.id)) || null;
  const setOwn = (obj, key, value) => Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  const setTeam = (t, team, ids) => { t.members = t.members || {}; setOwn(t.members, team, ids); };
  const captainOf = Bracket.teamCaptain; // gespeichert, sonst das erste Mitglied
  const setCaptain = (t, team, id) => { t.captains = t.captains || {}; setOwn(t.captains, team, id); };
  // Beitrittsanfragen: [{ person, team, at }], je Person und Turnier höchstens eine
  const requestsOf = (t, team) => (t.requests || []).filter((r) => r.team === team);
  const dropRequests = (t, keep) => { if (t.requests) t.requests = t.requests.filter(keep); };
  const personById = (id) => (db.persons || []).find((x) => x.id === id) || null;
  // Team ganz entfernen (aufgelöst): Mitglieder sind abgemeldet und bekommen damit ihre Coins zurück
  function removeTeam(t, team) {
    const ids = teamIds(t, team);
    if (t.members) delete t.members[team];
    if (t.captains) delete t.captains[team];
    dropRequests(t, (r) => r.team !== team);
    t.participants = t.participants.filter((n) => n !== team);
    if (t.playerIds) delete t.playerIds[team];
    return ids;
  }
  // Teilnehmer mit Ticket? Ohne Ticketmodul im Event darf jeder (wie bisher).
  const entryCheck = (e, actor) => { if (!mayEnter(e, actor.discordId || null)) throw refuse(403, 'no-ticket', 'Anmelden können nur Teilnehmer mit Ticket für dieses Event.'); };
  // Wer sich anmeldet: actor.person() liefert die geprüfte Person des Aufrufers und darf sie anlegen. Deshalb erst
  // nach allen Prüfungen aufrufen; vorher nur nachsehen, ob es die Person schon gibt (known, legt nichts an).
  const known = (actor) => (actor.discordId && (db.persons || []).find((x) => x.discordId === actor.discordId)) || null;
  function personOf(actor) {
    const p = actor.person ? actor.person() : (actor.discordId && (db.persons || []).find((x) => x.discordId === actor.discordId)) || null;
    if (!p) throw refuse(401, 'no-person', 'Dein Discord-Konto ist noch mit keiner Person verknüpft – bitte bei der Orga melden.');
    return p;
  }
  function openCheck(t, team) {
    if (!isOpen(t)) throw refuse(409, 'closed', 'Für dieses Turnier ist die Anmeldung nicht (mehr) offen.');
    if (team && !isTeam(t)) throw refuse(400, 'single-tournament', 'Kein Teamturnier');
    if (!team && isTeam(t)) throw refuse(400, 'team-tournament', 'Teamturnier: Anmeldung nur als Team');
  }
  // Coins aller Turniere des Events, in denen die Person angemeldet ist (except: dieses Turnier nicht mitzählen).
  // Eine noch nicht angelegte Person (p = null) hat keine verbraucht.
  const coinsUsed = (e, p, except) => !p ? 0 : e.tournaments.filter((x) => x !== except && (x.coins || 0) > 0 && personIn(x, p.id))
    .reduce((sum, x) => sum + x.coins, 0);
  function signupCheck(e, t, p, newEntry) {
    if (newEntry && t.maxParticipants && t.participants.length >= t.maxParticipants)
      throw refuse(409, 'full', `Das Turnier ist voll (${t.maxParticipants} ${isTeam(t) ? 'Teams' : 'Plätze'}).`, { max: t.maxParticipants });
    const budget = coinBudget();
    if (!budget || !(t.coins > 0)) return;
    const left = budget - coinsUsed(e, p, t);
    if (left < t.coins) throw refuse(409, 'coins', `Dafür fehlen dir Coins: Das Turnier kostet ${t.coins}, du hast noch ${Math.max(0, left)} von ${budget}.`, { cost: t.coins, left: Math.max(0, left), budget });
  }

  function decide(actor, t, matchId, confirm) {
    const me = role(actor, t);
    notTmt(me);
    const { before, m, side } = matchFor(me, t, matchId);
    const pend = pendingOf(t, m);
    if (m.status !== 'ready' || !pend) throw new HttpError(400, 'Für dieses Spiel wartet keine Meldung auf Bestätigung');
    if (!me.manage && pend.by === side) throw new HttpError(403, 'Bestätigen muss die Gegenseite');
    if (!me.manage && pend.disputed) throw new HttpError(409, 'Das Ergebnis ist strittig – die Turnierleitung entscheidet.');
    if (confirm) return commitResult(t, before, m, { a: pend.a, b: pend.b }, me.name, 'Bestätigt:');
    pend.disputed = true;
    logMatch(t, m, `Meldung ${pend.a}:${pend.b} bestritten`, me.name);
    notifier.resultDisputed(t, m, pend);
    changed(t);
  }

  // Team, dessen Captain der Akteur ist (Orga: optional jedes, dann null)
  function captainTeam(actor, t, adminAny = false) {
    if (!isTeam(t)) throw refuse(400, 'single-tournament', 'Kein Teamturnier');
    if (actor.admin && adminAny) return null;
    const p = known(actor);
    const team = p && teamOf(t, p);
    if (!team || captainOf(t, team) !== p.id) throw refuse(403, 'not-captain', 'Das darf nur der Captain des Teams.');
    return team;
  }
  const draftCheck = (t) => { if (t.status !== 'draft') throw refuse(409, 'started', 'Das Turnier läuft schon – Änderungen nur noch über die Orga.'); };
  // Eintrag umbenennen (Team): Mitglieder, Captain, Anfragen, Bindung und Discord-Kanal gehen mit
  function renameEntry(t, from, to, by) {
    const name = String(to || '').trim();
    if (!name) throw refuse(400, 'team-name', 'Bitte einen Teamnamen angeben');
    if (name === from) return t;
    if (t.participants.some((n) => n !== from && n.toLowerCase() === name.toLowerCase())) throw refuse(409, 'team-exists', `Ein Team „${name}“ gibt es schon.`, { name });
    const names = cleanParticipants(t.participants.map((n) => (n === from ? name : n)));
    const renames = Object.create(null);
    renames[from] = name;
    applyMembers(t, names, renames);
    t.participants = names;
    if (t.playerIds && Object.hasOwn(t.playerIds, from)) t.playerIds = Object.fromEntries(Object.entries(t.playerIds).map(([k, v]) => [k === from ? name : k, v]));
    if (by) logMatch(t, null, `Team umbenannt: ${from} → ${name}`, by);
    notifier.changed(t, renames);
    changed(t);
    return t;
  }

  // Turniere eines bestimmten Events
  function of(e) {
    const ops = {
      // Offene Anmeldung: Entwurf mit Anmeldung, vor dem Anmeldeschluss
      openForSignup: () => e.tournaments.filter(isOpen),
      list: () => e.tournaments, // Turniere des Events (Coins, siehe lib/commands.js)
      // Nur lesend (z. B. /jetzt): zwischengespeicherte Ansicht. isFinished bleibt frisch, weil Schreibpfade es vor save() aufrufen.
      running: () => e.tournaments.filter((t) => t.status === 'running' && !(view(t) || {}).finished),
      view,
      setParticipants(t, names, bind = {}) {
        const clean = cleanParticipants(names);
        applyMembers(t, clean);
        t.participants = clean;
        // Selbstanmeldung: das Discord-Konto hat sich gerade selbst eingetragen – direkt an seine Person-ID binden.
        t.playerIds = Object.fromEntries([...Object.entries(t.playerIds || {}), ...Object.entries(bind)]);
        bindPlayers(db, t);
        notifier.changed(t);
        changed(t);
      },
      // CS2-Match ist in TMT2 angelegt (lib/tmt.js): Spiel läuft, Spieler bekommen den Server. Nur solange die
      // Paarung unverändert spielbereit ist.
      announceServer(t, matchId, pa, pb, server) {
        if (t.status !== 'running') return;
        const m = Bracket.compute(t).matches.find((x) => x.id === matchId);
        if (!m || m.status !== 'ready' || m.a !== pa || m.b !== pb) return;
        t.playing = t.playing || {};
        if (!t.playing[m.id]) { t.playing[m.id] = { pa, pb, at: new Date().toISOString() }; logMatch(t, m, 'Läuft (TMT2-Server zugeteilt)', 'TMT2'); changed(t); }
        notifier.serverReady(t, m, server);
      },
      // Ergebnis melden (Spieler), eintragen oder korrigieren (Turnierleitung) bzw. aus TMT2 übernehmen.
      // input: { a, b } bzw. für TMT2 { a, b, pa, pb, maps }. Bei eingeschalteter Bestätigung wartet eine
      // Spielermeldung auf die Gegenseite; gleiche Meldung beider Seiten gilt sofort, abweichende ist strittig.
      reportResult(actor, t, matchId, input = {}) {
        const me = role(actor, t);
        if (me.tmt2) return reportFromTmt(t, matchId, input);
        const { before, m, side } = matchFor(me, t, matchId);
        if (m.status === 'done' && !me.manage)
          throw new HttpError(409, 'Für dieses Spiel ist bereits ein Ergebnis eingetragen. Korrekturen nur durch die Turnierleitung.');
        if (m.status !== 'ready' && m.status !== 'done') throw new HttpError(400, 'Spiel ist noch nicht bereit');
        const a = score(input.a), b = score(input.b);
        if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a > 9999 || b > 9999)
          throw new HttpError(400, 'Bitte ganze Zahlen ≥ 0 eingeben');
        if (!drawAllowed(t, m) && a === b) throw new HttpError(400, 'Im K.-o.-System ist kein Unentschieden möglich');
        if (m.status === 'done' && m.score && m.score.a === a && m.score.b === b) return; // unverändert
        if (me.manage || !t.confirm) {
          return commitResult(t, before, m, { a, b }, me.name, m.status === 'done' ? 'Korrigiert:' : me.manage ? 'Eingetragen:' : 'Gemeldet:');
        }
        const pend = pendingOf(t, m);
        if (pend && pend.by !== side) {
          if (pend.a === a && pend.b === b) return commitResult(t, before, m, { a, b }, me.name, 'Beide Seiten gemeldet:');
          pend.disputed = true;
          pend.counter = { a, b };
          logMatch(t, m, `Abweichende Meldung ${a}:${b} (vorher ${pend.a}:${pend.b})`, me.name);
          notifier.resultDisputed(t, m, pend, { a, b });
          return changed(t);
        }
        if (pend && pend.disputed) throw new HttpError(409, 'Das Ergebnis ist strittig – die Turnierleitung entscheidet.');
        t.pending = t.pending || {};
        t.pending[m.id] = { a, b, pa: m.a, pb: m.b, by: side, at: new Date().toISOString() };
        logMatch(t, m, `Gemeldet ${a}:${b}, wartet auf Bestätigung`, me.name);
        notifier.resultPending(t, m, { a, b, other: side === 'a' ? m.b : m.a });
        changed(t);
      },
      // Offene Meldung bestätigen bzw. bestreiten (Gegenseite oder Turnierleitung)
      confirmResult(actor, t, matchId) { decide(actor, t, matchId, true); },
      disputeResult(actor, t, matchId) { decide(actor, t, matchId, false); },
      // Kampflos werten (Turnierleitung); loser: 'a' | 'b'
      forfeit(actor, t, matchId, loser) {
        const me = role(actor, t);
        requireManage(me);
        const { before, m } = matchFor(me, t, matchId);
        if (m.status !== 'ready' && m.status !== 'done') throw new HttpError(400, 'Spiel ist noch nicht bereit');
        if (loser !== 'a' && loser !== 'b') throw new HttpError(400, 'Wer hat verloren? side: "a" oder "b"');
        if (m.status === 'done' && m.wo === loser && !m.dq) return;
        commitResult(t, before, m, { a: 0, b: 0, wo: loser }, me.name, 'Gewertet:');
      },
      // „Spiel läuft“ setzen oder zurücknehmen (Beteiligte, Turnierleitung)
      setPlaying(actor, t, matchId, on) {
        const me = role(actor, t);
        notTmt(me);
        const { m } = matchFor(me, t, matchId);
        if (m.status !== 'ready') throw new HttpError(400, 'Spiel ist nicht spielbereit');
        t.playing = t.playing || {};
        if (on === false) delete t.playing[m.id];
        else t.playing[m.id] = { pa: m.a, pb: m.b, at: new Date().toISOString() };
        logMatch(t, m, on === false ? 'Läuft nicht mehr' : 'Spiel läuft', me.name);
        changed(t);
      },
      // Ergebnis löschen (Turnierleitung)
      clearResult(actor, t, matchId) {
        const me = role(actor, t);
        requireManage(me);
        const { before, m } = matchFor(me, t, matchId);
        if (!t.results[m.id]) throw new HttpError(400, 'Für dieses Spiel gibt es kein Ergebnis');
        delete t.results[m.id];
        pruneStale(t);
        logMatch(t, m, 'Ergebnis gelöscht', me.name);
        notifier.resultCleared(t, m, !!before.finished);
        changed(t);
      },
      // ---------- Selbstanmeldung (Discord und Webseite) ----------
      // Einzelturnier: anmelden (gebunden an die eigene Person) bzw. abmelden (nur den eigenen Eintrag)
      join(actor, t) {
        openCheck(t, false);
        entryCheck(e, actor);
        const pre = known(actor);
        if (pre && named(t, pre.name)) return { person: pre, already: true };
        signupCheck(e, t, pre, true);
        const p = personOf(actor);
        if (named(t, p.name)) return { person: p, already: true };
        signupCheck(e, t, p, true);
        ops.setParticipants(t, [...t.participants, p.name], { [p.name]: p.id });
        return { person: p };
      },
      leave(actor, t) {
        if (!isOpen(t)) throw refuse(409, 'closed-leave', 'Abmelden geht nur, solange die Anmeldung offen ist.');
        const p = actor.person ? actor.person() : null;
        const entry = p && !isTeam(t) && ownEntry(t, p);
        if (!entry) return { notSignedUp: true };
        ops.setParticipants(t, t.participants.filter((n) => n !== entry));
        return { person: p };
      },
      // Teamturnier: gründen (wird Captain), Beitritt anfragen, verlassen. Verlässt der Captain das Team, ist es
      // aufgelöst: Es gibt keine automatische Übergabe, die übrigen Mitglieder sind abgemeldet (Coins zurück).
      foundTeam(actor, t, teamName) {
        openCheck(t, true);
        entryCheck(e, actor);
        const pre = known(actor);
        const before = pre && teamOf(t, pre);
        if (before) throw refuse(409, 'in-team', `Du bist schon im Team „${before}“.`, { team: before });
        const name = String(teamName || '').trim();
        if (!name) throw refuse(400, 'team-name', 'Bitte einen Teamnamen angeben');
        if (named(t, name)) throw refuse(409, 'team-exists', `Ein Team „${name}“ gibt es schon.`, { name });
        signupCheck(e, t, pre, true);
        const names = cleanParticipants([...t.participants, name]); // vor jeder Änderung prüfen
        const p = personOf(actor);
        const mine = teamOf(t, p);
        if (mine) throw refuse(409, 'in-team', `Du bist schon im Team „${mine}“.`, { team: mine });
        signupCheck(e, t, p, true);
        dropRequests(t, (r) => r.person !== p.id); // eigene offene Anfrage erledigt sich
        setTeam(t, name, [p.id]);
        setCaptain(t, name, p.id);
        ops.setParticipants(t, names);
        return { person: p, team: name };
      },
      // Beitritt als Anfrage; der Captain bestätigt oder lehnt ab. Coins werden jetzt geprüft und erst mit der
      // Bestätigung verbraucht (sie zählen ab dann über die Mitgliedschaft). Eine neue Anfrage ersetzt die alte.
      requestJoin(actor, t, teamName) {
        openCheck(t, true);
        entryCheck(e, actor);
        const pre = known(actor);
        const before = pre && teamOf(t, pre);
        if (before) throw refuse(409, 'in-team', `Du bist schon im Team „${before}“.`, { team: before });
        const team = t.participants.find((n) => n.toLowerCase() === String(teamName || '').toLowerCase());
        if (!team) throw refuse(404, 'no-team', 'Dieses Team gibt es nicht.');
        if (teamIds(t, team).length >= t.teamSize) throw refuse(409, 'team-full', `Das Team „${team}“ ist schon voll.`, { team });
        signupCheck(e, t, pre, false);
        const p = personOf(actor);
        const mine = teamOf(t, p);
        if (mine) throw refuse(409, 'in-team', `Du bist schon im Team „${mine}“.`, { team: mine });
        signupCheck(e, t, p, false);
        const old = (t.requests || []).find((r) => r.person === p.id);
        if (old && old.team === team) return { person: p, team, already: true };
        dropRequests(t, (r) => r.person !== p.id);
        t.requests = [...(t.requests || []), { person: p.id, team, at: new Date().toISOString() }].slice(-500);
        notifier.joinRequested(t, team, p, personById(captainOf(t, team)));
        changed(t);
        return { person: p, team, replaced: old ? old.team : null };
      },
      cancelRequest(actor, t) {
        const p = known(actor);
        const old = p && (t.requests || []).find((r) => r.person === p.id);
        if (!old) return { none: true };
        dropRequests(t, (r) => r.person !== p.id);
        changed(t);
        return { team: old.team };
      },
      // Captain (oder Orga) beantwortet eine Anfrage. Bestätigen nur bei offener Anmeldung und mit allen Prüfungen
      // wie bei einer Anmeldung (Platz im Team, Coins des Anfragenden, Ticket); ablehnen geht bis zum Start.
      answerRequest(actor, t, personId, accept) {
        const team = captainTeam(actor, t, true);
        const req = (t.requests || []).find((r) => r.person === personId && (team === null || r.team === team));
        if (!req) throw refuse(404, 'no-request', 'Diese Anfrage gibt es nicht (mehr).');
        const p = personById(personId);
        if (!accept || !p) {
          dropRequests(t, (r) => r !== req);
          if (p) notifier.joinAnswered(t, req.team, p, false);
          changed(t);
          return { team: req.team, person: p, accepted: false };
        }
        openCheck(t, true);
        if (teamIds(t, req.team).length >= t.teamSize) throw refuse(409, 'team-full', `Das Team „${req.team}“ ist schon voll.`, { team: req.team });
        const other = teamOf(t, p);
        if (other) throw refuse(409, 'in-team', `Diese Person ist schon im Team „${other}“.`, { team: other });
        entryCheck(e, { discordId: p.discordId });
        signupCheck(e, t, p, false);
        setTeam(t, req.team, [...teamIds(t, req.team), p.id]);
        dropRequests(t, (r) => r.person !== p.id);
        notifier.joinAnswered(t, req.team, p, true);
        notifier.changed(t);
        changed(t);
        return { team: req.team, person: p, accepted: true };
      },
      leaveTeam(actor, t) {
        openCheck(t, true);
        const p = known(actor); // wer keine Person hat, ist in keinem Team: nichts anlegen
        const mine = p && teamOf(t, p);
        if (!mine) return { person: p, notInTeam: true };
        if (captainOf(t, mine) === p.id) {
          const ids = removeTeam(t, mine);
          ops.setParticipants(t, t.participants);
          return { person: p, team: mine, dissolved: true, removed: ids.filter((id) => id !== p.id) };
        }
        setTeam(t, mine, teamIds(t, mine).filter((id) => id !== p.id));
        notifier.changed(t);
        changed(t);
        return { person: p, team: mine };
      },
      // Captain: Team auflösen (wie Verlassen als Captain)
      dissolveTeam(actor, t) {
        const team = captainTeam(actor, t);
        openCheck(t, true);
        const ids = removeTeam(t, team);
        ops.setParticipants(t, t.participants);
        return { team, removed: ids };
      },
      // Captain: Team umbenennen bzw. Mitglied entfernen – bis zum Turnierstart. Die Orga nutzt teamAdmin.
      renameTeam(actor, t, newName) {
        const team = captainTeam(actor, t);
        draftCheck(t);
        renameEntry(t, team, newName);
        return { team: String(newName).trim() };
      },
      removeMember(actor, t, personId) {
        const team = captainTeam(actor, t);
        draftCheck(t);
        if (personId === captainOf(t, team)) throw refuse(400, 'captain-self', 'Als Captain verlässt du das Team über „Team auflösen“.');
        if (!teamIds(t, team).includes(personId)) throw refuse(404, 'no-member', 'Diese Person ist nicht in deinem Team.');
        setTeam(t, team, teamIds(t, team).filter((id) => id !== personId));
        notifier.changed(t);
        changed(t);
        return { team };
      },
      // Orga greift jederzeit ein, auch im laufenden Turnier: Mitglied hinzufügen/entfernen, Captain setzen,
      // umbenennen. Ein Austausch ändert den Turnierbaum nicht; Coins prüft die Orga hier bewusst nicht.
      teamAdmin(actor, t, body = {}) {
        requireAdmin(actor);
        if (!isTeam(t)) throw refuse(400, 'single-tournament', 'Kein Teamturnier');
        const team = t.participants.find((n) => n === body.team);
        if (!team) throw refuse(404, 'no-team', 'Team nicht gefunden');
        const p = typeof body.person === 'string' ? personById(body.person) : null;
        if (body.action !== 'rename' && !p) throw refuse(400, 'unknown-person', 'Unbekannte Person');
        if (body.action === 'add') {
          const other = teamOf(t, p);
          if (other) throw refuse(409, 'in-team', `${p.name} ist schon im Team „${other}“`, { team: other });
          if (teamIds(t, team).length >= t.teamSize) throw refuse(409, 'team-full', 'Das Team ist voll – erst jemanden entfernen', { team });
          setTeam(t, team, [...teamIds(t, team), p.id]);
          dropRequests(t, (r) => r.person !== p.id);
        } else if (body.action === 'remove') {
          if (!teamIds(t, team).includes(p.id)) throw refuse(404, 'no-member', 'Nicht in diesem Team');
          setTeam(t, team, teamIds(t, team).filter((id) => id !== p.id));
        } else if (body.action === 'captain') {
          if (!teamIds(t, team).includes(p.id)) throw refuse(400, 'no-member', 'Captain muss Mitglied des Teams sein');
          setCaptain(t, team, p.id);
        } else if (body.action === 'rename') {
          return renameEntry(t, team, body.name, 'Orga');
        } else throw refuse(400, 'unknown-action', 'Unbekannte Aktion');
        logMatch(t, null, `Team ${team}: ${{ add: 'hinzugefügt', remove: 'entfernt', captain: 'neuer Captain' }[body.action]} ${p.name}`, 'Orga');
        notifier.changed(t);
        changed(t);
        return t;
      },
      // Coins einer Person in diesem Event (p: Person oder null)
      coins(p) {
        const budget = coinBudget();
        const mine = p ? e.tournaments.filter((x) => (x.coins || 0) > 0 && personIn(x, p.id)) : [];
        const used = mine.reduce((sum, x) => sum + x.coins, 0);
        return { budget, used, left: Math.max(0, budget - used), tournaments: mine };
      },
      // Webseite „Meine Turniere“: Turniere mit Anmeldung (Entwurf) und alle, in denen die Person dabei ist.
      // Nur Namen, Größen und eigene Daten; Beitrittsanfragen sieht nur der Captain des Teams.
      signupView(actor) {
        const p = known(actor);
        const allowed = !!actor.discordId && mayEnter(e, actor.discordId);
        const name = (id) => (personById(id) || {}).name || '?';
        const list = e.tournaments.filter((t) => (t.status === 'draft' && t.signup) || (p && personIn(t, p.id)));
        return {
          allowed, person: p ? { id: p.id, name: p.name } : null,
          coins: ops.coins(p),
          tournaments: list.map((t) => {
            const team = isTeam(t);
            const mineTeam = p && team ? teamOf(t, p) : null;
            const captain = !!(mineTeam && captainOf(t, mineTeam) === p.id);
            const req = p && (t.requests || []).find((r) => r.person === p.id);
            const v = t.status === 'running' ? view(t) : null;
            return {
              id: t.id, name: t.name, game: t.game || '', type: t.type, teamSize: t.teamSize || 1, coins: t.coins || 0,
              status: t.status, finished: !!(v && v.finished), open: isOpen(t), signupUntil: t.signupUntil || null,
              maxParticipants: t.maxParticipants || 0, count: t.participants.length,
              entry: p && !team ? ownEntry(t, p) || null : null,
              team: mineTeam ? {
                name: mineTeam, captain,
                members: teamIds(t, mineTeam).map((id) => ({ id, name: name(id), captain: id === captainOf(t, mineTeam) })),
                requests: captain ? requestsOf(t, mineTeam).map((r) => ({ id: r.person, name: name(r.person), at: r.at })) : [],
              } : null,
              request: req ? req.team : null,
              teams: team ? t.participants.map((n) => ({ name: n, size: teamIds(t, n).length, captain: allowed && captainOf(t, n) ? name(captainOf(t, n)) : null,
                members: allowed ? teamIds(t, n).map(name) : [] })) : [],
            };
          }),
        };
      },

      // Einmalige Migration alter Turniere ohne Bindungen (siehe bindPlayers); speichert nicht selbst
      bindLegacy() { for (const t of e.tournaments) bindPlayers(db, t); },

      // ---------- Personen (Teil einer Personenänderung; speichert nicht selbst) ----------
      // Nur an diese Person gebundene Einzeleinträge folgen dem neuen Namen; gleichnamige fremde bzw. ungebundene bleiben.
      renamePerson(personId, previous, name) {
        for (const t of e.tournaments) {
          if (isTeam(t) || !Object.hasOwn(t.playerIds || {}, previous) || t.playerIds[previous] !== personId) continue;
          t.participants = t.participants.map((n) => (n === previous ? name : n));
          t.playerIds = Object.fromEntries(Object.entries(t.playerIds).map(([key, id]) => [key === previous ? name : key, id]));
          notifier.entryRenamed(t, previous, name);
        }
      },
      // Person gelöscht: ihre Einträge bleiben als ungebundene Namen stehen
      forgetPerson(personId) {
        for (const t of e.tournaments) {
          for (const key of Object.keys(t.playerIds || {})) if (t.playerIds[key] === personId) t.playerIds[key] = null;
          for (const team of Object.keys(t.members || {})) {
            if (teamIds(t, team).includes(personId)) setTeam(t, team, teamIds(t, team).filter((id) => id !== personId));
          }
          if (Array.isArray(t.referees)) t.referees = t.referees.filter((id) => id !== personId);
          dropRequests(t, (r) => r.person !== personId);
        }
      },
      // Konto gelöscht (lib/privacy.js): aus allen Turnieren vor dem Start austragen; ist die Person Captain, wird
      // das Team aufgelöst und die übrigen Mitglieder sind abgemeldet (Coins zurück). Laufende und beendete Turniere
      // behalten den pseudonymisierten Eintrag, damit Turnierbaum und Ergebnisse stimmen. Speichert nicht selbst.
      withdrawPerson(personId) {
        for (const t of e.tournaments) {
          const before = JSON.stringify([t.participants, t.members, t.requests]);
          dropRequests(t, (r) => r.person !== personId);
          if (t.status === 'draft') {
            for (const team of Object.keys(t.members || {})) {
              if (!teamIds(t, team).includes(personId)) continue;
              if (captainOf(t, team) === personId) removeTeam(t, team);
              else setTeam(t, team, teamIds(t, team).filter((id) => id !== personId));
            }
            if (!isTeam(t)) {
              const entry = ownEntry(t, { id: personId });
              if (entry) { t.participants = t.participants.filter((n) => n !== entry); delete t.playerIds[entry]; }
            }
          }
          if (JSON.stringify([t.participants, t.members, t.requests]) !== before) { notifier.changed(t); broadcast('tournament', t.id); }
        }
      },
      // Zwei Personen zusammenführen: Teammitgliedschaften und gebundene Einträge gehen an „into“
      mergePersons(fromId, intoId) {
        for (const t of e.tournaments) {
          for (const ids of Object.values(t.members || {})) {
            const i = ids.indexOf(fromId);
            if (i >= 0) { if (ids.includes(intoId)) ids.splice(i, 1); else ids[i] = intoId; }
          }
          for (const key of Object.keys(t.playerIds || {})) if (t.playerIds[key] === fromId) t.playerIds[key] = intoId;
          if (Array.isArray(t.referees) && t.referees.includes(fromId)) t.referees = [...new Set(t.referees.map((id) => (id === fromId ? intoId : id)))];
          for (const team of Object.keys(t.captains || {})) if (t.captains[team] === fromId) t.captains[team] = intoId;
          if (t.requests) {
            const inTeam = (id) => !!teamOf(t, { id });
            t.requests = t.requests.map((r) => (r.person === fromId ? { ...r, person: intoId } : r))
              .filter((r, i, all) => !inTeam(r.person) && all.findIndex((x) => x.person === r.person) === i);
          }
        }
      },

      // ---------- Lesen ----------
      // Übersicht: Entwürfe nur für die Orga
      overview: (actor) => e.tournaments.filter((t) => actor.admin || t.status !== 'draft').map(summary),
      show(actor, t) {
        if (t.status === 'draft' && !actor.admin) throw new HttpError(404, 'Turnier nicht gefunden');
        return present(actor, t);
      },
      present,

      // ---------- Verwalten (Orga) ----------
      create(actor, body) {
        requireAdmin(actor);
        const name = str(body.name);
        if (!name) throw new HttpError(400, 'Name fehlt');
        const t = {
          id: newId(),
          name,
          game: str(body.game),
          type: cleanType(body.type),
          thirdPlace: !!body.thirdPlace,
          gfReset: body.gfReset !== false,
          discordEnabled: body.discordEnabled !== false,
          teamSize: cleanTeamSize(body.teamSize),
          cs2: cleanCs2(body.cs2),
          signup: !!body.signup, // Anmeldung über Discord offen (solange Entwurf)
          confirm: false, confirmMinutes: 10, groups: cleanGroups(null),
          ...tournamentExtras(body),
          members: {},
          participants: cleanParticipants(body.participants || []),
          playerIds: {},
          order: [],
          results: {},
          status: 'draft',
          createdAt: new Date().toISOString(),
        };
        bindPlayers(db, t, false, chosenPlayers(t.participants, body.playerIds));
        e.tournaments.unshift(t);
        notifier.changed(t);
        changed(t);
        return t;
      },
      // Alle Eingaben vor jeder Änderung prüfen: eine abgelehnte Anfrage ändert nichts.
      update(actor, t, body) {
        requireAdmin(actor);
        const names = body.participants !== undefined ? cleanParticipants(body.participants) : null;
        const chosen = names ? chosenPlayers(names, body.playerIds) : {};
        if (names && t.status !== 'draft' && names.length !== t.participants.length)
          throw new HttpError(400, 'Während das Turnier läuft, können Teilnehmer nur umbenannt werden (gleiche Anzahl, gleiche Reihenfolge).');
        const name = body.name !== undefined ? str(body.name) : undefined;
        if (name === '') throw new HttpError(400, 'Name fehlt');
        const game = body.game !== undefined ? str(body.game) : undefined;
        const cs2 = body.cs2 !== undefined ? cleanCs2(body.cs2) : undefined;
        const extras = tournamentExtras(body);
        // Gruppenaufteilung, Setzplätze und Kosten stehen mit dem Start fest
        if (t.status !== 'draft') for (const k of ['groups', 'seeds', 'coins']) delete extras[k];
        if (name !== undefined) t.name = name;
        Object.assign(t, extras);
        if (extras.confirm === false && t.pending) t.pending = {};
        if (game !== undefined) t.game = game;
        const renames = Object.create(null); // für Discord: Kanäle umbenennen statt neu anlegen (Namen als reine Daten)
        if (names) {
          if (names.length === t.participants.length) {
            names.forEach((n, i) => { if (n !== t.participants[i]) renames[t.participants[i]] = n; });
          }
          applyMembers(t, names, renames);
          t.participants = names;
          bindPlayers(db, t, true, chosen);
        }
        if (body.discordEnabled !== undefined) t.discordEnabled = !!body.discordEnabled;
        if (cs2 !== undefined) t.cs2 = cs2;
        if (body.signup !== undefined) t.signup = !!body.signup;
        if (body.teamSize !== undefined && t.status === 'draft') t.teamSize = cleanTeamSize(body.teamSize);
        if (t.status === 'draft') {
          if (body.type !== undefined) t.type = cleanType(body.type);
          if (body.thirdPlace !== undefined) t.thirdPlace = !!body.thirdPlace;
          if (body.gfReset !== undefined) t.gfReset = !!body.gfReset;
        } else if (body.thirdPlace !== undefined && t.type === 'ko' && !!body.thirdPlace !== t.thirdPlace) {
          t.thirdPlace = !!body.thirdPlace;
          pruneStale(t);
        }
        notifier.changed(t, renames);
        changed(t);
        return t;
      },
      remove(actor, t) {
        requireAdmin(actor);
        e.tournaments = e.tournaments.filter((x) => x !== t);
        notifier.removed(t);
        changed(t);
      },
      // Kopie als neuer Entwurf (gleiche Teilnehmer und Einstellungen)
      duplicate(actor, t) {
        requireAdmin(actor);
        const copy = {
          id: newId(),
          name: (t.name + ' (Kopie)').slice(0, 100),
          game: t.game, type: t.type, thirdPlace: t.thirdPlace, gfReset: t.gfReset,
          discordEnabled: t.discordEnabled !== false,
          teamSize: t.teamSize || 1, signup: false, cs2: t.cs2 ? { ...t.cs2 } : null,
          groups: cleanGroups(t.groups), prizes: (t.prizes || []).slice(), coins: t.coins || 0, maxParticipants: t.maxParticipants || 0,
          seeds: t.seeds || 0, confirm: !!t.confirm, confirmMinutes: t.confirmMinutes || 10, referees: (t.referees || []).slice(),
          members: JSON.parse(JSON.stringify(t.members || {})),
          participants: t.participants.slice(), playerIds: { ...(t.playerIds || {}) },
          order: [], results: {}, status: 'draft',
          createdAt: new Date().toISOString(),
        };
        e.tournaments.unshift(copy);
        notifier.changed(copy);
        changed(copy);
        return copy;
      },
      // Setzliste festlegen und starten: feste Setzplätze (die ersten N) bleiben, der Rest wird auf Wunsch ausgelost
      start(actor, t, { shuffle, seeds: wanted } = {}) {
        requireAdmin(actor);
        if (t.participants.length < 2) throw new HttpError(400, 'Mindestens 2 Teilnehmer nötig');
        if (t.type === 'groups' && t.participants.length < 2 * cleanGroups(t.groups).count)
          throw new HttpError(400, `Für ${cleanGroups(t.groups).count} Gruppen braucht es mindestens ${2 * cleanGroups(t.groups).count} Teilnehmer`);
        const order = t.participants.map((_, i) => i);
        bindPlayers(db, t, true);
        const seeds = wanted !== undefined ? clampInt(wanted, 0, order.length, 0) : Math.min(t.seeds || 0, order.length);
        if (shuffle) {
          for (let i = order.length - 1; i > seeds; i--) {
            const j = seeds + crypto.randomInt(i - seeds + 1);
            [order[i], order[j]] = [order[j], order[i]];
          }
        }
        t.seeds = seeds;
        t.order = order;
        t.results = {}; t.pending = {}; t.playing = {}; t.disqualified = [];
        t.status = 'running';
        logMatch(t, null, shuffle ? `Gestartet (Auslosung${seeds ? `, ${seeds} gesetzt` : ''})` : 'Gestartet (Setzliste)', 'Orga');
        notifier.started(t);
        changed(t);
        return t;
      },
      // Zurück in den Entwurf
      reset(actor, t) {
        requireAdmin(actor);
        const wasFinished = isFinished(t);
        t.order = [];
        t.results = {}; t.pending = {}; t.playing = {}; t.disqualified = [];
        t.status = 'draft';
        logMatch(t, null, 'Zurück auf Entwurf', 'Orga');
        notifier.reset(t, wasFinished);
        changed(t);
        return t;
      },
      // Teams aus Einzelanmeldungen auslosen (Entwurf). balanced: nach Setzliste im Schlangenmuster, sonst zufällig
      drawTeams(actor, t, { size: wanted, balanced } = {}) {
        requireAdmin(actor);
        if (t.status !== 'draft') throw new HttpError(400, 'Teams lassen sich nur im Entwurf auslosen');
        if ((t.teamSize || 1) > 1) throw new HttpError(400, 'Das Turnier hat schon Teams – auslosen geht aus Einzelanmeldungen');
        const size = clampInt(wanted, 2, 20, 2);
        const players = t.participants.slice();
        const count = Math.ceil(players.length / size);
        if (count < 2) throw new HttpError(400, `Für Teams à ${size} braucht es mindestens ${size + 1} Spieler`);
        if (!balanced) {
          for (let i = players.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [players[i], players[j]] = [players[j], players[i]]; }
        }
        const teams = Bracket.groupSplit(players, count); // gleich große, ausgeglichene Teams
        const names = teams.map((list, i) => { const n = list.join(' & '); return n.length <= 60 ? n : `Team ${i + 1}`; });
        const bound = t.playerIds || {};
        t.members = Object.fromEntries(teams.map((list, i) => [names[i], list.map((p) => (Object.hasOwn(bound, p) ? bound[p] : null)).filter(Boolean)]));
        t.teamSize = size;
        t.participants = names;
        t.playerIds = {};
        bindPlayers(db, t);
        logMatch(t, null, `${count} Teams à bis zu ${size} ausgelost${balanced ? ' (nach Setzliste)' : ''}`, 'Orga');
        notifier.changed(t);
        changed(t);
        return t;
      },
      // Discord-Kanäle von Hand abgleichen; wartet auf Discord
      async syncDiscord(actor, t) {
        requireAdmin(actor);
        if (!notifier.available()) throw new HttpError(400, 'Discord ist nicht konfiguriert');
        await notifier.sync(t);
        return t;
      },
      // Disqualifizieren bzw. zurücknehmen (Turnierleitung): offene Spiele gehen kampflos an den Gegner,
      // gespielte Ergebnisse bleiben.
      disqualify(actor, t, index, on = true) {
        const me = role(actor, t);
        if (!me.manage) throw new HttpError(403, 'Nur Orga oder Turnierleitung');
        if (t.status !== 'running') throw new HttpError(400, 'Turnier läuft nicht');
        const idx = Number(index);
        if (!Number.isInteger(idx) || idx < 0 || idx >= t.participants.length) throw new HttpError(400, 'Unbekannter Teilnehmer');
        const before = Bracket.compute(t);
        const set = new Set(t.disqualified || []);
        if (on === false) set.delete(idx); else set.add(idx);
        t.disqualified = [...set].sort((x, y) => x - y);
        const after = pruneStale(t);
        logMatch(t, null, `${t.participants[idx]} ${on === false ? 'nicht mehr disqualifiziert' : 'disqualifiziert'}`, me.name);
        notifier.disqualified(t, { index: idx, on: on !== false, before, after, wasFinished: !!before.finished });
        changed(t);
        return t;
      },

      // Offene Meldungen ohne Einspruch gelten nach t.confirmMinutes automatisch
      autoConfirm(now = Date.now()) {
        for (const t of e.tournaments) {
          if (t.status !== 'running' || !t.pending || !Object.keys(t.pending).length) continue;
          const limit = (t.confirmMinutes || 10) * 60000;
          for (const [id, p] of Object.entries(t.pending)) {
            if (p.disputed || now - Date.parse(p.at) < limit) continue;
            const before = Bracket.compute(t);
            const m = before && before.matches.find((x) => x.id === id);
            if (!m || m.status !== 'ready' || m.a !== p.pa || m.b !== p.pb) { delete t.pending[id]; continue; }
            commitResult(t, before, m, { a: p.a, b: p.b }, 'System', 'Ohne Einspruch automatisch bestätigt:');
          }
        }
      },
    };
    return ops;
  }

  return {
    of,
    view, role, canManage,
  };
};
Object.assign(module.exports, { isFinished, drawAllowed, clampInt, bindPlayers, reportableSides, mayReport, sideOf, isReferee, personIn });
