'use strict';
// LAN-Client für CS2-Matches: läuft im LAN neben TMT2 (Fork von https://github.com/JensForstmann/tmt2, MIT)
// und den CS2-Servern. Er fragt die LAN-Verwaltung regelmäßig nach Aufträgen (Match anlegen, beenden),
// führt sie an TMT2 aus und meldet den Stand der offenen Matches zurück. Verbindungen gehen nur vom LAN nach
// außen; im LAN muss kein Port geöffnet werden. Nur Node-Bordmittel.
// Start: LAN_URL=https://lan.example.org TMT2_AGENT_TOKEN=… TMT2_URL=http://tmt2:8080 TMT2_TOKEN=… node agent/tmt2-agent.js

const fs = require('fs');

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

function config(env = process.env) {
  const secret = (name) => env[name] || (env[`${name}_FILE`] ? fs.readFileSync(env[`${name}_FILE`], 'utf8').trim() : '');
  const c = {
    lanUrl: String(env.LAN_URL || '').replace(/\/+$/, ''), agentToken: secret('TMT2_AGENT_TOKEN'),
    tmtUrl: String(env.TMT2_URL || 'http://tmt2:8080').replace(/\/+$/, ''), tmtToken: secret('TMT2_TOKEN'),
  };
  for (const [k, v] of Object.entries(c)) if (!v) throw new Error(`${{ lanUrl: 'LAN_URL', agentToken: 'TMT2_AGENT_TOKEN', tmtUrl: 'TMT2_URL', tmtToken: 'TMT2_TOKEN' }[k]} fehlt`);
  const lan = new URL(c.lanUrl);
  // Das Token geht ins Internet: nur per HTTPS, außer für lokale Tests
  if (lan.protocol !== 'https:' && !(lan.protocol === 'http:' && (LOCAL_HOSTS.includes(lan.hostname) || env.ALLOW_HTTP === '1'))) {
    throw new Error('LAN_URL muss mit https:// beginnen (http nur für localhost oder mit ALLOW_HTTP=1)');
  }
  if (!/^https?:$/.test(new URL(c.tmtUrl).protocol)) throw new Error('TMT2_URL muss mit http:// oder https:// beginnen');
  return c;
}

class RemoteError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

function createAgent({ lanUrl, agentToken, tmtUrl, tmtToken, log = console }) {
  async function call(base, token, method, pathname, body) {
    const r = await fetch(base + pathname, {
      method, redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = (await r.text()).slice(0, 2 * 1024 * 1024);
    let value = null;
    try { value = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
    if (!r.ok) {
      const msg = String((value && (value.message || value.error)) || '').replace(/\s+/g, ' ').slice(0, 200);
      throw new RemoteError(`${r.status}${msg ? `: ${msg}` : ''}`, r.status);
    }
    return value;
  }
  const lan = (method, pathname, body) => call(lanUrl, agentToken, method, pathname, body);
  const tmt = (method, pathname, body) => call(tmtUrl, tmtToken, method, pathname, body);
  const list = (v) => (Array.isArray(v) ? v : []);

  // Nur bekannte Felder an TMT2 weitergeben: kein eigener Gameserver, keine RCON-Befehle, keine Webhooks
  function createBody(id, b) {
    const team = (t) => ({ name: String(t && t.name || '').slice(0, 60), passthrough: t && t.passthrough === 'B' ? 'B' : 'A' });
    return {
      passthrough: id, mapPool: list(b.mapPool).map(String).slice(0, 20), electionSteps: list(b.electionSteps).slice(0, 20),
      teamA: team(b.teamA), teamB: team(b.teamB), gameServer: null, mode: 'SINGLE', canClinch: b.canClinch !== false,
    };
  }

  // Nur was die LAN-Verwaltung braucht – nie Passwörter, Spieler oder Logs
  const snapshot = (x) => ({
    state: x.state, isStopped: !!x.isStopped,
    matchMaps: list(x.matchMaps).slice(0, 9).map((mm) => ({ name: mm.name, state: mm.state, score: { teamA: mm.score && mm.score.teamA, teamB: mm.score && mm.score.teamB } })),
  });

  // Ein Durchlauf: Aufträge holen, an TMT2 ausführen, Ergebnis melden. Gibt die gewünschte Pause in Sekunden zurück.
  async function cycle() {
    const jobs = await lan('GET', '/api/cs2/agent/poll') || {};
    const out = { created: [], stopped: [], matches: [] };
    for (const j of list(jobs.create)) {
      if (!j || typeof j.id !== 'string' || !j.body) continue;
      try {
        // Nach einem Absturz zwischen Anlegen und Melden kein zweites Match anlegen
        const existing = list(await tmt('GET', `/api/matches?passthrough=${encodeURIComponent(j.id)}`)).find((m) => m.passthrough === j.id && !m.isStopped);
        const m = existing || await tmt('POST', '/api/matches', createBody(j.id, j.body));
        if (!m || typeof m.id !== 'string') throw new RemoteError('keine Match-ID erhalten', 502);
        out.created.push({ id: j.id, tmtId: m.id });
        log.log(`TMT2-Match ${m.id} angelegt (${j.id})`);
      } catch (err) {
        if (!(err instanceof RemoteError)) throw err; // TMT2 nicht erreichbar: beim nächsten Durchlauf erneut
        out.created.push({ id: j.id, error: err.message });
      }
    }
    for (const id of list(jobs.stop)) {
      if (typeof id !== 'string') continue;
      try { await tmt('DELETE', `/api/matches/${encodeURIComponent(id)}`); }
      catch (err) { if (!(err instanceof RemoteError) || err.status !== 404) { log.error(`TMT2-Match ${id} beenden: ${err.message}`); continue; } }
      out.stopped.push(id);
    }
    for (const w of list(jobs.watch)) {
      if (!w || typeof w.id !== 'string' || typeof w.tmtId !== 'string') continue;
      try { out.matches.push({ id: w.id, match: snapshot(await tmt('GET', `/api/matches/${encodeURIComponent(w.tmtId)}`) || {}) }); }
      catch (err) {
        if (err instanceof RemoteError && err.status === 404) out.matches.push({ id: w.id, match: null });
        else log.error(`TMT2-Match ${w.tmtId} abfragen: ${err.message}`);
      }
    }
    await lan('POST', '/api/cs2/agent/report', out);
    const n = Number(jobs.pollSeconds);
    return Number.isFinite(n) ? Math.min(Math.max(n, 2), 60) : 5;
  }

  return { cycle };
}

async function main() {
  const agent = createAgent(config());
  console.log('TMT2-LAN-Client gestartet');
  let fails = 0, stop = false;
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stop = true; process.exit(0); });
  while (!stop) {
    let wait;
    try { wait = await agent.cycle(); fails = 0; }
    catch (err) {
      fails++;
      wait = Math.min(5 * 2 ** Math.min(fails, 4), 60); // bei Störungen seltener nachfragen
      console.error(`Durchlauf fehlgeschlagen (${err.name === 'TimeoutError' ? 'Zeitüberschreitung' : err.message}), neuer Versuch in ${wait} s`);
    }
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

if (require.main === module) main().catch((err) => { console.error(err.message); process.exit(1); });
module.exports = { createAgent, config };
