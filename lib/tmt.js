'use strict';
// CS2-Matches über TMT2 (Tournament Match Tracker 2, Fork von https://github.com/JensForstmann/tmt2, MIT).
// TMT2 läuft als eigener Container; hier nur die Brücke: Matches für Turnierpaarungen anlegen, Stand abgleichen
// und das Endergebnis in den Turnierbaum übernehmen. Nur für Admins, das TMT2-Token bleibt auf dem Server.
// Pro Event: event.cs2 = { mapPool, matches }. Ergebnisse kommen per Webhook oder über „Abgleichen“.

const crypto = require('crypto');
const Bracket = require('../public/bracket.js');

const MAP_RE = /^(?:[a-z0-9_]{1,40}|\d{1,20}\/[\w .-]{1,40}|[a-z0-9_]{1,40}\/[\w .-]{1,40})$/i;
const FORMATS = { bo1: 1, bo3: 3, bo5: 5 };
const DEFAULT_POOL = ['de_ancient', 'de_anubis', 'de_dust2', 'de_inferno', 'de_mirage', 'de_nuke', 'de_train'];
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
function wonMaps(maps) {
  let a = 0, b = 0;
  for (const m of maps) if (m.done && m.a !== m.b) { if (m.a > m.b) a++; else b++; }
  return { a, b };
}

module.exports = function tmt(ctx) {
  const { db, save, broadcast, send, readBody, requireAdmin, HttpError, str } = ctx;
  const env = process.env;
  const BASE = String(env.TMT2_URL || '').replace(/\/+$/, '');
  const PUBLIC = String(env.TMT2_PUBLIC_URL || '').replace(/\/+$/, '');
  const HOOK = String(env.TMT2_WEBHOOK_URL || '').replace(/\/+$/, '');
  let TOKEN = env.TMT2_TOKEN || '';
  if (!TOKEN && env.TMT2_TOKEN_FILE) TOKEN = require('fs').readFileSync(env.TMT2_TOKEN_FILE, 'utf8').trim();
  for (const [name, v] of [['TMT2_URL', BASE], ['TMT2_PUBLIC_URL', PUBLIC], ['TMT2_WEBHOOK_URL', HOOK]]) {
    if (v && !/^https?:\/\/[^\s/]+/i.test(v)) throw new Error(`${name} muss mit http:// oder https:// beginnen`);
  }
  const configured = () => !!(BASE && TOKEN);

  for (const e of db.events) e.cs2 = { mapPool: DEFAULT_POOL.slice(), matches: [], ...(e.cs2 || {}) };
  const data = (e) => (e.cs2 = e.cs2 || { mapPool: DEFAULT_POOL.slice(), matches: [] });
  const ev = () => ctx.event.scoped();
  const changed = () => { save(); broadcast('cs2'); };

  // ---------- TMT2-API ----------
  async function call(method, pathname, body) {
    if (!configured()) throw new HttpError(400, 'TMT2 ist nicht eingerichtet (TMT2_URL und TMT2_TOKEN)');
    let r;
    try {
      r = await fetch(BASE + pathname, {
        method, redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      console.error('TMT2 nicht erreichbar:', err.name === 'TimeoutError' ? 'Zeitüberschreitung' : err.message);
      throw new HttpError(502, 'TMT2 ist nicht erreichbar');
    }
    const text = (await r.text()).slice(0, 1024 * 1024);
    let value = null;
    try { value = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
    if (!r.ok) {
      const msg = String((value && (value.message || value.error)) || '').replace(/\s+/g, ' ').slice(0, 200);
      const err = new HttpError(r.status === 404 ? 404 : 502, `TMT2 meldet ${r.status}${msg ? `: ${msg}` : ''}`);
      err.tmtStatus = r.status;
      throw err;
    }
    return value;
  }

  // ---------- Daten ----------
  const allMatches = () => db.events.flatMap((e) => data(e).matches.map((m) => ({ e, m })));
  const tournamentOf = (e, m) => (m.tournamentId && e.tournaments.find((t) => t.id === m.tournamentId)) || null;
  const open = (m) => !['FINISHED', 'STOPPED'].includes(m.state);

  function view(e, m) {
    const t = tournamentOf(e, m);
    return {
      id: m.id, tmtId: m.tmtId, format: m.format, teamA: m.teamA, teamB: m.teamB, state: m.state,
      maps: m.maps, wonA: m.wonA, wonB: m.wonB, tournament: t ? { id: t.id, name: t.name } : null, label: m.label || '',
      reported: !!m.reported, note: m.note || '', createdAt: m.createdAt, updatedAt: m.updatedAt,
      link: PUBLIC && m.tmtId ? `${PUBLIC}/matches/${encodeURIComponent(m.tmtId)}` : null,
    };
  }

  // Spielbereite Turnierpaarungen dieses Events, für die es noch kein offenes CS2-Match gibt
  function candidates(e) {
    const busy = new Set(data(e).matches.filter(open).map((m) => `${m.tournamentId}:${m.matchId}`));
    return e.tournaments.filter((t) => t.status === 'running').flatMap((t) => {
      const v = ctx.tournaments.view(t);
      return v ? Bracket.playable(v).filter((x) => !busy.has(`${t.id}:${x.id}`))
        .map((x) => ({ tournamentId: t.id, tournament: t.name, matchId: x.id, label: x.label, teamA: t.participants[x.a], teamB: t.participants[x.b] })) : [];
    });
  }

  // Endergebnis in den Turnierbaum übernehmen – nur einmal und nur, solange die Paarung unverändert offen ist.
  function report(e, m) {
    if (m.reported || m.state !== 'FINISHED') return;
    const t = tournamentOf(e, m);
    if (!t) return;
    const note = ctx.tournaments.reportResult(t, m.matchId, m.wonA, m.wonB, m.pa, m.pb);
    if (note) m.note = note;
    else { m.reported = true; m.note = ''; }
  }

  // Stand aus der TMT2-Matchansicht übernehmen (für „Abgleichen“)
  function applyMatch(m, x) {
    m.maps = (Array.isArray(x.matchMaps) ? x.matchMaps : []).slice(0, 9).map((mm) => ({
      name: str(mm.name, 60), a: score(mm.score && mm.score.teamA), b: score(mm.score && mm.score.teamB), done: mm.state === 'FINISHED',
    }));
    const w = wonMaps(m.maps);
    m.wonA = w.a; m.wonB = w.b;
    if (x.state === 'FINISHED') m.state = 'FINISHED';
    else if (x.isStopped) m.state = 'STOPPED';
    else if (['ELECTION', 'MATCH_MAP'].includes(x.state)) m.state = x.state;
  }
  const score = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 999 ? n : 0; };

  // Webhook-Ereignis von TMT2 (Typen siehe common/types/events.ts im TMT2-Repository)
  function applyEvent(m, b) {
    if (b.type === 'MAP_ELECTION_END' && Array.isArray(b.mapNames)) {
      m.maps = b.mapNames.slice(0, 9).map((name) => ({ name: str(name, 60), a: 0, b: 0, done: false }));
      m.state = 'MATCH_MAP';
    } else if (b.type === 'MAP_START' || b.type === 'MAP_END' || b.type === 'ROUND_END') {
      const i = Number(b.mapIndex);
      if (!Number.isInteger(i) || i < 0 || i > 8) return false;
      while (m.maps.length <= i) m.maps.push({ name: '', a: 0, b: 0, done: false });
      const mm = m.maps[i];
      if (b.mapName) mm.name = str(b.mapName, 60);
      if (b.type !== 'MAP_START') { mm.a = score(b.scoreTeamA); mm.b = score(b.scoreTeamB); }
      if (b.type === 'MAP_END') mm.done = true;
      m.state = 'MATCH_MAP';
    } else if (b.type === 'MATCH_END') {
      if (Array.isArray(b.mapResults)) {
        m.maps = b.mapResults.slice(0, 9).map((r) => ({ name: str(r.mapName, 60), a: score(r.scoreTeamA), b: score(r.scoreTeamB), done: true }));
      }
      m.wonA = score(b.wonMapsTeamA); m.wonB = score(b.wonMapsTeamB);
      m.state = 'FINISHED';
      return true;
    } else if (b.type === 'MATCH_STOP') {
      if (m.state !== 'FINISHED') m.state = 'STOPPED';
    } else return false;
    const w = wonMaps(m.maps);
    m.wonA = w.a; m.wonB = w.b;
    return true;
  }

  function hookOk(m, req) {
    const auth = String(req.headers.authorization || '');
    const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    return !!m.hookHash && !!tok && crypto.timingSafeEqual(hash(tok), Buffer.from(m.hookHash, 'hex'));
  }

  // ---------- Routen ----------
  async function routes(req, res, parts, method) {
    if (parts[0] !== 'cs2') return false;

    // Webhook von TMT2: ohne Admin-Sitzung, aber mit dem Geheimnis dieses Matches
    if (parts[1] === 'webhook' && parts[2] && parts.length === 3 && method === 'POST') {
      ctx.security.rateLimit(req, 'cs2_webhook', 1200, 60000);
      const hit = allMatches().find((x) => x.m.id === parts[2]);
      if (!hit || !ctx.eventModuleOn(hit.e, 'cs2') || !hookOk(hit.m, req)) {
        ctx.security.log('cs2_webhook_rejected', req);
        ctx.security.rateLimit(req, 'cs2_webhook_fail', 30, 10 * 60000);
        throw new HttpError(403, 'Nicht berechtigt');
      }
      const b = await readBody(req);
      const { e, m } = hit;
      if (!data(e).matches.includes(m)) throw new HttpError(404, 'Match nicht gefunden'); // während des Uploads gelöscht
      if (typeof b.matchId === 'string' && m.tmtId && b.matchId !== m.tmtId) throw new HttpError(400, 'Falsches Match');
      if (applyEvent(m, b)) {
        m.updatedAt = new Date().toISOString();
        report(e, m);
        changed();
      }
      send(res, 200, { ok: true });
      return true;
    }

    requireAdmin(req);
    const e = ev();
    const d = data(e);

    if (parts.length === 1 && method === 'GET') {
      send(res, 200, {
        event: { id: e.id, name: e.name }, configured: configured(), webhook: !!HOOK, publicUrl: PUBLIC || null,
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

    // Neues Match in TMT2 anlegen – aus einer Turnierpaarung oder mit freien Teamnamen
    if (parts[1] === 'matches' && parts.length === 2 && method === 'POST') {
      const b = await readBody(req);
      const format = Object.hasOwn(FORMATS, b.format) ? b.format : 'bo1';
      let steps;
      try { steps = electionSteps(d.mapPool.length, format); } catch (err) { throw new HttpError(400, err.message); }
      const m = { id: crypto.randomBytes(6).toString('hex'), tmtId: null, format, state: 'ELECTION', maps: [], wonA: 0, wonB: 0,
        reported: false, note: '', createdAt: new Date().toISOString(), updatedAt: null };
      if (b.tournamentId) {
        const c = candidates(e).find((x) => x.tournamentId === b.tournamentId && x.matchId === b.matchId);
        if (!c) throw new HttpError(400, 'Diese Paarung ist nicht spielbereit oder hat schon ein offenes CS2-Match');
        const t = e.tournaments.find((x) => x.id === c.tournamentId);
        const bm = Bracket.playable(ctx.tournaments.view(t)).find((x) => x.id === c.matchId);
        Object.assign(m, { tournamentId: t.id, matchId: bm.id, pa: bm.a, pb: bm.b, label: str(bm.label, 60), teamA: c.teamA, teamB: c.teamB });
      } else {
        m.teamA = str(b.teamA, 60); m.teamB = str(b.teamB, 60);
        if (!m.teamA || !m.teamB) throw new HttpError(400, 'Bitte beide Teamnamen angeben');
        if (m.teamA.toLowerCase() === m.teamB.toLowerCase()) throw new HttpError(400, 'Die Teams müssen verschieden heißen');
      }
      const secret = crypto.randomBytes(32).toString('hex');
      m.hookHash = hash(secret).toString('hex');
      const x = await call('POST', '/api/matches', {
        passthrough: m.id, mapPool: d.mapPool.slice(), electionSteps: steps,
        teamA: { name: m.teamA, passthrough: 'A' }, teamB: { name: m.teamB, passthrough: 'B' },
        gameServer: null, // freier Server aus der Gameserver-Verwaltung von TMT2 – RCON-Passwörter bleiben dort
        mode: 'SINGLE', canClinch: true,
        webhookUrl: HOOK ? `${HOOK}/api/cs2/webhook/${m.id}` : null,
        webhookHeaders: HOOK ? { Authorization: `Bearer ${secret}` } : null,
      });
      requireAdmin(req); // TMT2 kann länger brauchen; widerrufene Sitzungen speichern nichts
      m.tmtId = x && typeof x.id === 'string' ? x.id.slice(0, 64) : null;
      if (!m.tmtId) throw new HttpError(502, 'TMT2 hat keine Match-ID zurückgegeben');
      d.matches.unshift(m);
      changed();
      ctx.security.log('cs2_match_created', req);
      send(res, 201, view(e, m));
      return true;
    }

    const m = parts[1] === 'matches' && parts[2] && d.matches.find((x) => x.id === parts[2]);
    if (!m) throw new HttpError(404, 'Nicht gefunden');

    // Stand von TMT2 holen und ggf. Ergebnis übernehmen
    if (parts[3] === 'sync' && parts.length === 4 && method === 'POST') {
      let x;
      try { x = await call('GET', `/api/matches/${encodeURIComponent(m.tmtId)}`); }
      catch (err) { if (err.tmtStatus !== 404) throw err; x = { isStopped: true, matchMaps: [] }; }
      requireAdmin(req);
      if (!d.matches.includes(m)) throw new HttpError(404, 'Nicht gefunden');
      if (x && x.matchMaps && x.matchMaps.length) applyMatch(m, x);
      else if (x && x.isStopped && m.state !== 'FINISHED') m.state = 'STOPPED';
      m.updatedAt = new Date().toISOString();
      report(e, m);
      changed();
      send(res, 200, view(e, m));
      return true;
    }

    // Match in TMT2 beenden und hier entfernen (ein übernommenes Ergebnis bleibt im Turnier)
    if (parts.length === 3 && method === 'DELETE') {
      if (m.tmtId) {
        try { await call('DELETE', `/api/matches/${encodeURIComponent(m.tmtId)}`); }
        catch (err) { if (err.tmtStatus !== 404) throw err; }
      }
      requireAdmin(req);
      d.matches = d.matches.filter((x) => x !== m);
      changed();
      ctx.security.log('cs2_match_deleted', req);
      send(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  return { routes };
};
module.exports.electionSteps = electionSteps;
module.exports.wonMaps = wonMaps;
module.exports.DEFAULT_POOL = DEFAULT_POOL;
