'use strict';
// Turniere: Teilnehmerlisten, Bindungen an Personen, Ergebnisse, Bestätigungen, Protokoll und Spielplan.
// Aufrufer wählen das Event ausdrücklich (of(event), siehe docs/adr/0001-explizites-event-im-turniermodul.md).
// Discord erfährt Änderungen nur über den notifier (lib/tournament-discord.js); dieses Modul kennt Discord nicht.

const Bracket = require('../public/bracket.js');
const Access = require('./access.js');
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

// deps: db (Personen), save, broadcast, HttpError, str, notifier, revision() (steigt mit jeder Speicherung)
module.exports = function tournaments({ db, save, broadcast, HttpError, str, notifier, revision }) {
  function cleanParticipants(list) {
    if (!Array.isArray(list)) throw new HttpError(400, 'Teilnehmerliste fehlt');
    const names = list.map((s) => String(s).trim()).filter(Boolean);
    if (names.length > 256) throw new HttpError(400, 'Maximal 256 Teilnehmer');
    if (names.some((n) => n.length > 60)) throw new HttpError(400, 'Namen dürfen höchstens 60 Zeichen lang sein');
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
    const referee = !admin && !!discordId && Access.isReferee(db, discordId, t);
    const person = discordId ? (db.persons || []).find((p) => p.discordId === discordId) : null;
    const name = admin ? 'Orga' : person ? person.name + (referee ? ' (Turnierleitung)' : '') : 'Unbekannt';
    return { tmt2: false, admin, referee, manage: admin || referee, discordId, name };
  }
  // Ohne Spielplanberechnung prüfbar: darf der Akteur dieses Turnier leiten?
  const canManage = (actor, t) => role(actor, t).manage;
  const requireManage = (me) => { if (!me.manage) throw new HttpError(401, 'Nur Orga oder Turnierleitung'); };
  const notTmt = (me) => { if (me.tmt2) throw new HttpError(403, 'Für TMT2 nicht erlaubt'); };

  // Spiel eines laufenden Turniers samt Ansicht davor; Spieler nur für eigene Spiele (side: 'a' | 'b')
  function matchFor(me, t, matchId) {
    if (t.status !== 'running') throw new HttpError(400, 'Turnier läuft nicht');
    const before = Bracket.compute(t);
    const m = before.matches.find((x) => x.id === matchId);
    if (!m) throw new HttpError(404, 'Spiel nicht gefunden');
    const side = me.manage ? null : Access.sideOf(db, me.discordId, t, m);
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
  function applyMembers(t, names, renames = {}) {
    if (!t.members) return;
    t.members = Object.fromEntries(Object.entries(t.members)
      .map(([team, ids]) => [Object.hasOwn(renames, team) ? renames[team] : team, ids])
      .filter(([name]) => names.includes(name)));
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

  // Turniere eines bestimmten Events
  function of(e) {
    return {
      // Offene Anmeldung: Entwurf mit Anmeldung, vor dem Anmeldeschluss
      openForSignup: () => e.tournaments.filter((t) => t.status === 'draft' && t.signup && !(t.signupUntil && Date.parse(t.signupUntil) <= Date.now())),
      list: () => e.tournaments, // Turniere des Events (Coins, siehe lib/commands.js)
      // Nur lesend (z. B. /jetzt): zwischengespeicherte Ansicht. isFinished bleibt frisch, weil Schreibpfade es vor save() aufrufen.
      running: () => e.tournaments.filter((t) => t.status === 'running' && !(view(t) || {}).finished),
      view,
      changed,
      setParticipants(t, names, bind = {}) {
        const clean = cleanParticipants(names);
        applyMembers(t, clean);
        t.participants = clean;
        // Selbstanmeldung: das Discord-Konto hat sich gerade selbst eingetragen – direkt an seine Person-ID binden.
        t.playerIds = Object.fromEntries([...Object.entries(t.playerIds || {}), ...Object.entries(bind)]);
        Access.bindPlayers(db, t);
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
  }

  return {
    of,
    // Bis die Routen hierher umziehen (Schritt 3), nutzt server.js diese Bausteine direkt.
    cleanParticipants, cleanType, cleanGroups, cleanTeamSize, cleanCs2, tournamentExtras, pruneStale, logMatch,
    applyMembers, chosenPlayers, view, summary, role, canManage,
  };
};
Object.assign(module.exports, { isFinished, drawAllowed, clampInt });
