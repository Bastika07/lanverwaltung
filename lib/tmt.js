'use strict';
// CS2-Matches über TMT2 (Tournament Match Tracker 2, Fork von https://github.com/JensForstmann/tmt2, MIT).
// TMT2 läuft im LAN bei den CS2-Servern, die von außen nicht erreichbar sind. Dort fragt ein LAN-Client
// (agent/tmt2-agent.js) diese Seite regelmäßig nach Aufträgen, führt sie an TMT2 aus und meldet den Stand der
// Matches zurück – Verbindungen gehen nur vom LAN nach außen. Hier: Aufträge verwalten und das Endergebnis
// in den Turnierbaum übernehmen. Admin-Seite nur für die Orga, der Client meldet sich mit TMT2_AGENT_TOKEN an.
// Pro Event: event.cs2 = { mapPool, matches, stops }. Turniere mit t.cs2 = { format, finalFormat } werden automatisch
// abgeglichen: Jede spielbereite Paarung bekommt ein Match (auto), das bei geänderter Paarung wieder verschwindet.

const crypto = require('crypto');
const Bracket = require('../public/bracket.js');

const MAP_RE = /^(?:[a-z0-9_]{1,40}|\d{1,20}\/[\w .-]{1,40}|[a-z0-9_]{1,40}\/[\w .-]{1,40})$/i;
const FORMATS = { bo1: 1, bo3: 3, bo5: 5 };
const DEFAULT_POOL = ['de_ancient', 'de_anubis', 'de_dust2', 'de_inferno', 'de_mirage', 'de_nuke', 'de_train'];
const AGENT_ONLINE_MS = 60000;
const FINALS = new Set(['Finale', 'Grand Final', 'Grand Final – Reset']);
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();

// Ablauf der Mapwahl für TMT2: erst bis zu zwei Bans, dann abwechselnd Picks (Seite wählt der Gegner),
// dann die übrigen Bans und zuletzt die Entscheidungsmap mit Messerrunde. Team A beginnt.
function electionSteps(poolSize, format) {
  const games = FORMATS[format];
  if (!games) throw new Error('Unbekanntes Format');
  if (poolSize < games) throw new Error(`Für ${format.toUpperCase()} braucht der Mappool mindestens ${games} Maps`);
  const who = (i) => (i % 2 ? 'TEAM_B' : 'TEAM_A');
  const bans = poolSize - games;
  let b = 0;
  const ban = () => ({ map: { mode: 'BAN', who: who(b++) } });
  const steps = [];
  while (b < Math.min(2, bans)) steps.push(ban());
  for (let p = 0; p < games - 1; p++) steps.push({ map: { mode: 'PICK', who: who(p) }, side: { mode: 'PICK', who: who(p + 1) } });
  while (b < bans) steps.push(ban());
  steps.push({ map: { mode: 'RANDOM_PICK' }, side: { mode: 'KNIFE' } });
  return steps;
}

// Gewonnene Maps aus den Map-Ständen von TMT2 (nur fertige Maps zählen)
// TMT2 gibt einen Gameserver erst etwa eine Minute nach Matchende frei. Ist gerade keiner frei, wartet das Match
// (PENDING) und wird beim nächsten Abruf erneut angelegt – z. B. das Finale direkt nach dem letzten Halbfinale.
// „already in use“ meldet TMT2, wenn ein noch nicht freigegebenes Match den Server hält.
const NO_SERVER = /no free game ?server|game ?server already in use/i;
const WAITING = 'Wartet auf einen freien Gameserver in TMT2';

function wonMaps(maps) {
  let a = 0, b = 0;
  for (const m of maps) if (m.done && m.a !== m.b) { if (m.a > m.b) a++; else b++; }
  return { a, b };
}

module.exports = function tmt(ctx) {
  const { db, save, broadcast, send, readBody, requireAdmin, HttpError, str } = ctx;
  const env = process.env;
  const PUBLIC = String(env.TMT2_PUBLIC_URL || '').replace(/\/+$/, '');
  if (PUBLIC && !/^https?:\/\/[^\s/]+/i.test(PUBLIC)) throw new Error('TMT2_PUBLIC_URL muss mit http:// oder https:// beginnen');
  let TOKEN = env.TMT2_AGENT_TOKEN || '';
  if (!TOKEN && env.TMT2_AGENT_TOKEN_FILE) TOKEN = require('fs').readFileSync(env.TMT2_AGENT_TOKEN_FILE, 'utf8').trim();
  if (TOKEN && TOKEN.length < 32) throw new Error('TMT2_AGENT_TOKEN muss mindestens 32 Zeichen lang sein');
  const tokenHash = TOKEN ? hash(TOKEN) : null;
  let agentSeen = 0; // nur im Speicher: jede Abfrage würde sonst die Datenbank schreiben

  const blank = () => ({ mapPool: DEFAULT_POOL.slice(), matches: [], stops: [] });
  for (const e of db.events) e.cs2 = { ...blank(), ...(e.cs2 || {}) };
  const data = (e) => { e.cs2 = e.cs2 || blank(); e.cs2.stops = e.cs2.stops || []; return e.cs2; };
  const ev = () => ctx.event.scoped();
  const changed = () => { save(); broadcast('cs2'); };
  const enabledEvents = () => db.events.filter((e) => ctx.eventModuleOn(e, 'cs2'));

  // ---------- Daten ----------
  const tournamentOf = (e, m) => (m.tournamentId && e.tournaments.find((t) => t.id === m.tournamentId)) || null;
  const open = (m) => !['FINISHED', 'STOPPED', 'ERROR'].includes(m.state);

  function view(e, m) {
    const t = tournamentOf(e, m);
    return {
      id: m.id, tmtId: m.tmtId, format: m.format, teamA: m.teamA, teamB: m.teamB, state: m.state,
      maps: m.maps, wonA: m.wonA, wonB: m.wonB, tournament: t ? { id: t.id, name: t.name } : null, label: m.label || '',
      reported: !!m.reported, auto: !!m.auto, note: m.note || '', createdAt: m.createdAt, updatedAt: m.updatedAt,
      link: PUBLIC && m.tmtId ? `${PUBLIC}/matches/${encodeURIComponent(m.tmtId)}` : null,
    };
  }

  // Spielbereite Turnierpaarungen dieses Events, für die es noch kein offenes CS2-Match gibt (Turniere mit
  // automatischem Abgleich ausgenommen)
  function candidates(e) {
    const busy = new Set(data(e).matches.filter(open).map((m) => `${m.tournamentId}:${m.matchId}`));
    return e.tournaments.filter((t) => t.status === 'running' && !t.cs2).flatMap((t) => {
      const v = ctx.tournaments.view(t);
      return v ? Bracket.playable(v).filter((x) => !busy.has(`${t.id}:${x.id}`))
        .map((x) => ({ tournamentId: t.id, tournament: t.name, matchId: x.id, label: x.label, teamA: t.participants[x.a], teamB: t.participants[x.b] })) : [];
    });
  }

  // Endergebnis in den Turnierbaum übernehmen – nur einmal und nur, solange die Paarung unverändert offen ist.
  // Bei einer Map steht der Rundenstand im Baum (13:9), sonst die gewonnenen Maps (2:1); die Rundenstände je Map
  // werden mitgespeichert.
  function report(e, m) {
    if (m.reported || m.state !== 'FINISHED') return;
    const t = tournamentOf(e, m);
    if (!t) return;
    const played = m.maps.filter((x) => x.done);
    const single = m.maps.length === 1 && played.length === 1;
    const a = single ? played[0].a : m.wonA, b = single ? played[0].b : m.wonB;
    const note = ctx.tournaments.reportResult(t, m.matchId, a, b, m.pa, m.pb, played.map(({ name, a, b }) => ({ name, a, b })));
    if (note) m.note = note;
    else { m.reported = true; m.note = ''; }
  }

  // Neues Match-Objekt; teams/tournament werden vom Aufrufer ergänzt
  const newMatch = (d, format, extra) => ({ id: crypto.randomBytes(6).toString('hex'), tmtId: null, format, mapPool: d.mapPool.slice(), state: 'PENDING', maps: [], wonA: 0, wonB: 0,
    reported: false, note: '', createdAt: new Date().toISOString(), updatedAt: null, ...extra });
  const pairing = (t, bm) => ({ tournamentId: t.id, matchId: bm.id, pa: bm.a, pb: bm.b, label: str(bm.label, 60), teamA: str(t.participants[bm.a], 60), teamB: str(t.participants[bm.b], 60) });
  const sameKey = (m, t, bm) => m.tournamentId === t.id && m.matchId === bm.id && m.pa === bm.a && m.pb === bm.b;

  // Turniere mit CS2-Abgleich: für jede spielbereite Paarung genau ein Match anlegen – egal in welchem Zustand ein
  // vorhandenes ist (ein abgebrochenes oder fehlerhaftes entfernt die Orga, dann entsteht ein neues). Offene
  // automatische Matches, deren Paarung nicht mehr spielbereit ist (Korrektur, Zurücksetzen, Turnier gelöscht,
  // Ergebnis von Hand), werden entfernt und in TMT2 beendet. Abschalten des Abgleichs lässt laufende Matches weiterlaufen. Läuft bei jedem Abruf des LAN-Clients, daher idempotent.
  // Ein beendetes Match ohne eindeutigen Sieger (Unentschieden) zählt dabei als offen: TMT2 lädt die Map danach neu
  // und hält den Gameserver, bis das Match dort beendet wird.
  function autoSync(e) {
    const d = data(e);
    let dirty = false;
    const ready = new Map(); // Turnier-ID -> spielbereite Spiele
    for (const t of e.tournaments) {
      if (t.status !== 'running') continue;
      const v = ctx.tournaments.view(t);
      ready.set(t.id, v ? v.matches.filter((x) => x.status === 'ready') : []);
    }
    d.matches = d.matches.filter((m) => {
      if (!m.auto || !(open(m) || (m.state === 'FINISHED' && !m.reported))) return true;
      const t = tournamentOf(e, m);
      if (t && (ready.get(t.id) || []).some((bm) => sameKey(m, t, bm))) return true;
      if (m.tmtId && !d.stops.includes(m.tmtId)) d.stops.push(m.tmtId);
      dirty = true;
      return false;
    });
    for (const t of e.tournaments) {
      if (!t.cs2 || t.status !== 'running') continue;
      for (const bm of Bracket.playable(ctx.tournaments.view(t))) {
        if (d.matches.some((m) => sameKey(m, t, bm))) continue;
        const format = (FINALS.has(bm.label) && t.cs2.finalFormat) || t.cs2.format;
        const m = newMatch(d, Object.hasOwn(FORMATS, format) ? format : 'bo1', { auto: true, ...pairing(t, bm) });
        try { electionSteps(m.mapPool.length, m.format); } catch (err) { m.state = 'ERROR'; m.note = err.message; }
        d.matches.unshift(m);
        dirty = true;
      }
    }
    return dirty;
  }

  // Stand aus der TMT2-Matchansicht übernehmen; ein beendetes Match bleibt beendet
  const score = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 999 ? n : 0; };
  function applyMatch(m, x) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw new HttpError(400, 'Ungültiger Matchstand');
    if (m.state === 'FINISHED') return;
    const maps = Array.isArray(x.matchMaps) ? x.matchMaps.slice(0, 9) : [];
    m.maps = maps.map((mm) => ({
      name: str(mm && mm.name, 60), a: score(mm && mm.score && mm.score.teamA), b: score(mm && mm.score && mm.score.teamB), done: !!mm && mm.state === 'FINISHED',
    }));
    const w = wonMaps(m.maps);
    m.wonA = w.a; m.wonB = w.b;
    if (x.state === 'FINISHED') m.state = 'FINISHED';
    else if (x.isStopped) m.state = 'STOPPED';
    else if (['ELECTION', 'MATCH_MAP'].includes(x.state)) m.state = x.state;
  }

  // Anlage-Auftrag für TMT2. Der Client übernimmt nur diese Felder und setzt gameServer immer auf null.
  function createBody(m) {
    return {
      passthrough: m.id, mapPool: m.mapPool, electionSteps: electionSteps(m.mapPool.length, m.format),
      teamA: { name: m.teamA, passthrough: 'A' }, teamB: { name: m.teamB, passthrough: 'B' }, mode: 'SINGLE', canClinch: true,
    };
  }

  // ---------- LAN-Client ----------
  function requireAgent(req) {
    const auth = String(req.headers.authorization || '');
    const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!tokenHash || !tok || !crypto.timingSafeEqual(hash(tok), tokenHash)) {
      ctx.security.log('cs2_agent_rejected', req);
      ctx.security.rateLimit(req, 'cs2_agent_fail', 30, 10 * 60000);
      throw new HttpError(403, 'Nicht berechtigt');
    }
    agentSeen = Date.now();
  }

  // Aufträge: anlegen (PENDING), beenden (stops) und den Stand aller offenen Matches beobachten (watch)
  function jobs() {
    const out = { create: [], stop: [], watch: [] };
    let dirty = false;
    for (const e of enabledEvents()) {
      if (autoSync(e)) dirty = true;
      const d = data(e);
      for (const m of d.matches) {
        // Ältere Stände: wegen belegter Server als Fehler markierte Matches wieder anlegen lassen
        if (m.state === 'ERROR' && NO_SERVER.test(m.note || '')) { m.state = 'PENDING'; m.note = WAITING; dirty = true; }
        if (m.state === 'PENDING') out.create.push({ id: m.id, body: createBody(m) });
        else if (m.tmtId && open(m)) out.watch.push({ id: m.id, tmtId: m.tmtId });
      }
      out.stop.push(...d.stops);
    }
    if (dirty) changed();
    return out;
  }

  function findMatch(id) {
    for (const e of enabledEvents()) {
      const m = data(e).matches.find((x) => x.id === id);
      if (m) return { e, m };
    }
    return null;
  }

  // Rückmeldung des Clients; unbekannte IDs (z. B. inzwischen gelöscht) werden übergangen
  function applyReport(b) {
    const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
    let dirty = false;
    for (const c of list(b.created, 100)) {
      const hit = c && typeof c.id === 'string' && findMatch(c.id);
      const tmtId = c && typeof c.tmtId === 'string' && /^[\w-]{1,64}$/.test(c.tmtId) ? c.tmtId : null;
      if (!hit || hit.m.state !== 'PENDING') {
        // Während der Anlage gelöscht: das neue TMT2-Match gleich wieder beenden
        const d = data(ctx.event.current());
        if (tmtId && !(hit && hit.m.tmtId === tmtId) && !d.stops.includes(tmtId)) { d.stops.push(tmtId); dirty = true; }
        continue;
      }
      if (tmtId) { hit.m.tmtId = tmtId; hit.m.state = 'ELECTION'; hit.m.note = ''; }
      else if (NO_SERVER.test(str(c.error, 200))) hit.m.note = WAITING; // bleibt PENDING: nächster Abruf versucht es erneut
      else { hit.m.state = 'ERROR'; hit.m.note = `TMT2: ${str(c.error, 200) || 'Anlegen fehlgeschlagen'}`; }
      hit.m.updatedAt = new Date().toISOString();
      dirty = true;
    }
    const stopped = new Set(list(b.stopped, 500).filter((x) => typeof x === 'string'));
    for (const e of enabledEvents()) {
      const d = data(e);
      const rest = d.stops.filter((x) => !stopped.has(x));
      if (rest.length !== d.stops.length) { d.stops = rest; dirty = true; }
    }
    for (const s of list(b.matches, 200)) {
      const hit = s && typeof s.id === 'string' && findMatch(s.id);
      if (!hit || !hit.m.tmtId || !open(hit.m)) continue;
      const before = JSON.stringify([hit.m.state, hit.m.maps]);
      if (s.match === null) hit.m.state = 'STOPPED'; // in TMT2 nicht mehr vorhanden
      else applyMatch(hit.m, s.match);
      if (before !== JSON.stringify([hit.m.state, hit.m.maps])) { hit.m.updatedAt = new Date().toISOString(); dirty = true; }
      report(hit.e, hit.m);
    }
    if (dirty) changed();
  }

  // ---------- Routen ----------
  async function routes(req, res, parts, method) {
    if (parts[0] !== 'cs2') return false;

    if (parts[1] === 'agent' && parts.length === 3) {
      ctx.security.rateLimit(req, 'cs2_agent', 600, 60000);
      requireAgent(req);
      if (parts[2] === 'poll' && method === 'GET') {
        send(res, 200, { ...jobs(), pollSeconds: 5 });
        return true;
      }
      if (parts[2] === 'report' && method === 'POST') {
        const b = await readBody(req);
        requireAgent(req);
        applyReport(b);
        send(res, 200, { ok: true });
        return true;
      }
      throw new HttpError(404, 'Nicht gefunden');
    }

    requireAdmin(req);
    const e = ev();
    const d = data(e);

    if (parts.length === 1 && method === 'GET') {
      send(res, 200, {
        event: { id: e.id, name: e.name }, configured: !!tokenHash, agentOnline: Date.now() - agentSeen < AGENT_ONLINE_MS,
        agentSeenAt: agentSeen ? new Date(agentSeen).toISOString() : null, publicUrl: PUBLIC || null,
        mapPool: d.mapPool, matches: d.matches.map((m) => view(e, m)), candidates: candidates(e),
      });
      return true;
    }

    if (parts[1] === 'config' && parts.length === 2 && method === 'PUT') {
      const b = await readBody(req);
      if (!Array.isArray(b.mapPool)) throw new HttpError(400, 'Mappool fehlt');
      const pool = [...new Set(b.mapPool.map((x) => str(x, 64)).filter(Boolean))];
      if (!pool.length || pool.length > 20) throw new HttpError(400, 'Der Mappool braucht 1 bis 20 Maps');
      const bad = pool.find((x) => !MAP_RE.test(x));
      if (bad) throw new HttpError(400, `Ungültiger Mapname: ${bad.slice(0, 64)}`);
      d.mapPool = pool;
      changed();
      send(res, 200, { mapPool: d.mapPool });
      return true;
    }

    // Neues Match – aus einer Turnierpaarung oder mit freien Teamnamen. Der LAN-Client legt es in TMT2 an.
    if (parts[1] === 'matches' && parts.length === 2 && method === 'POST') {
      if (!tokenHash) throw new HttpError(400, 'Der LAN-Client ist nicht eingerichtet (TMT2_AGENT_TOKEN)');
      const b = await readBody(req);
      const format = Object.hasOwn(FORMATS, b.format) ? b.format : 'bo1';
      try { electionSteps(d.mapPool.length, format); } catch (err) { throw new HttpError(400, err.message); }
      const m = newMatch(d, format);
      if (b.tournamentId) {
        const c = candidates(e).find((x) => x.tournamentId === b.tournamentId && x.matchId === b.matchId);
        if (!c) throw new HttpError(400, 'Diese Paarung ist nicht spielbereit oder hat schon ein offenes CS2-Match');
        const t = e.tournaments.find((x) => x.id === c.tournamentId);
        Object.assign(m, pairing(t, Bracket.playable(ctx.tournaments.view(t)).find((x) => x.id === c.matchId)));
      } else {
        m.teamA = str(b.teamA, 60); m.teamB = str(b.teamB, 60);
        if (!m.teamA || !m.teamB) throw new HttpError(400, 'Bitte beide Teamnamen angeben');
        if (m.teamA.toLowerCase() === m.teamB.toLowerCase()) throw new HttpError(400, 'Die Teams müssen verschieden heißen');
      }
      d.matches.unshift(m);
      changed();
      ctx.security.log('cs2_match_created', req);
      send(res, 201, view(e, m));
      return true;
    }

    // Entfernen: Läuft das Match schon in TMT2, beendet der LAN-Client es dort beim nächsten Abruf.
    // Ein schon übernommenes Ergebnis bleibt im Turnier.
    const m = parts[1] === 'matches' && parts[2] && d.matches.find((x) => x.id === parts[2]);
    if (m && parts.length === 3 && method === 'DELETE') {
      if (m.tmtId && open(m) && !d.stops.includes(m.tmtId)) d.stops.push(m.tmtId);
      d.matches = d.matches.filter((x) => x !== m);
      changed();
      ctx.security.log('cs2_match_deleted', req);
      send(res, 200, { ok: true });
      return true;
    }
    throw new HttpError(404, 'Nicht gefunden');
  }

  // Der LAN-Client meldet sich ohne Admin-Sitzung an; die Routen prüfen Modul und Zugang selbst.
  return { routes, alwaysOn: true };
};
module.exports.electionSteps = electionSteps;
module.exports.wonMaps = wonMaps;
module.exports.DEFAULT_POOL = DEFAULT_POOL;
module.exports.FORMATS = FORMATS;
