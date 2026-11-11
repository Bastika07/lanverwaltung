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
  function pruneStale(t) {
    const view = Bracket.compute(t);
    if (!view) return;
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
  }

  // Protokoll je Spiel (nur Orga und Turnierleitung sehen es), die letzten 300 Einträge
  function logMatch(t, m, text, by) {
    t.log = (t.log || []).concat({ at: new Date().toISOString(), match: m ? m.id : null, label: m ? str(m.label, 80) : '', text: str(text, 200), by: str(by, 80) }).slice(-300);
  }

  // Für das Protokoll: Ergebnis bzw. wer kampflos gewinnt
  const scoreText = (t, m, r) => (r.wo ? `${t.participants[r.wo === 'a' ? m.b : m.a]} gewinnt kampflos` : `${r.a}:${r.b}`);

  const changed = (t) => { save(); broadcast('tournament', t.id); };

  // Ergebnis festschreiben (Meldung, Bestätigung, Orga, TMT2): Gewinner wandert weiter, abhängige Ergebnisse
  // verfallen, Discord erfährt es. view: Ansicht vor der Änderung.
  function commitResult(t, view, m, r, by, text) {
    const wasFinished = isFinished(t);
    const correction = m.status === 'done';
    t.results[m.id] = { ...r, pa: m.a, pb: m.b, at: new Date().toISOString() };
    if (t.pending) delete t.pending[m.id];
    if (t.playing) delete t.playing[m.id];
    pruneStale(t);
    logMatch(t, m, `${text} ${scoreText(t, m, r)}`, by);
    notifier.resultReported(t, { before: view, matchId: m.id, correction, wasFinished });
    changed(t);
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
      // Ergebnis aus TMT2 (lib/tmt.js): nur für ein offenes Spiel mit unveränderter Paarung, nie als Korrektur.
      // maps: gespielte Maps mit Rundenstand ({ name, a, b }), wird zur Anzeige am Ergebnis gespeichert.
      // Gibt null zurück oder einen Hinweis, warum nichts eingetragen wurde.
      reportResult(t, matchId, a, b, pa, pb, maps) {
        if (t.status !== 'running') return 'Turnier läuft nicht – Ergebnis bitte von Hand eintragen';
        const before = Bracket.compute(t);
        const m = before.matches.find((x) => x.id === matchId);
        if (!m) return 'Spiel nicht mehr im Turnierbaum – Ergebnis bitte von Hand eintragen';
        if (m.status === 'done') return m.score && m.score.a === a && m.score.b === b && m.a === pa && m.b === pb ? null : 'Im Turnier steht schon ein anderes Ergebnis';
        if (m.status !== 'ready' || m.a !== pa || m.b !== pb) return 'Die Paarung hat sich geändert – Ergebnis bitte von Hand eintragen';
        if (!Number.isInteger(a) || !Number.isInteger(b) || (!drawAllowed(t, m) && a === b)) return 'Kein eindeutiger Sieger – Ergebnis bitte von Hand eintragen';
        const played = (Array.isArray(maps) ? maps : []).slice(0, 9).map((x) => ({ name: str(x.name, 60), a: x.a, b: x.b }))
          .filter((x) => [x.a, x.b].every((n) => Number.isInteger(n) && n >= 0 && n <= 999));
        commitResult(t, before, m, { a, b, ...(played.length ? { maps: played } : {}) }, 'TMT2', 'Ergebnis aus TMT2:');
        return null;
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
    cleanParticipants, cleanType, cleanGroups, cleanTeamSize, cleanCs2, tournamentExtras, pruneStale, logMatch, commitResult,
    applyMembers, chosenPlayers, view, summary,
  };
};
Object.assign(module.exports, { isFinished, drawAllowed, clampInt });
