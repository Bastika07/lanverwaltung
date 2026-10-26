'use strict';
// Discord-Gateway: dauerhafte Verbindung, damit Slash-Befehle (/announce, /ich, /anmelden …)
// beim Bot ankommen. Nutzt das in Node 22 eingebaute WebSocket, keine Zusatzpakete.
// Es werden keine privilegierten Intents benötigt.

const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11 };
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]); // z. B. falsches Token -> nicht erneut versuchen

module.exports = function gateway(Discord, handlers, log = console) {
  let ws = null, seq = null, sessionId = null, resumeUrl = null, heartbeat = null, firstBeat = null, acked = true, stopped = false;
  let appId = null;

  // Slash-Befehle (der aktiven Module) beim Discord-Server registrieren
  async function refresh() {
    if (!Discord.enabled) return;
    try {
      appId = appId || (await Discord.call('GET', '/oauth2/applications/@me')).id;
      const list = handlers.commands();
      await Discord.call('PUT', `/applications/${appId}/guilds/${Discord.GUILD}/commands`, list);
      log.log(`Discord: ${list.length} Slash-Befehle registriert`);
    } catch (err) {
      log.error('Discord: Befehle konnten nicht registriert werden:', err.message);
    }
  }

  async function start() {
    if (!Discord.enabled || typeof WebSocket === 'undefined') return;
    await refresh();
    connect(false);
  }

  async function connect(resume) {
    if (stopped) return;
    clearInterval(heartbeat);
    clearTimeout(firstBeat);
    let url = resume && resumeUrl;
    if (!url) {
      try { url = (await Discord.call('GET', '/gateway/bot')).url; }
      catch (err) { log.error('Discord-Gateway:', err.message); return retry(false, 10000); }
    }
    const sock = new WebSocket(`${url}/?v=10&encoding=json`);
    ws = sock;
    sock.addEventListener('message', (ev) => onMessage(sock, JSON.parse(ev.data), resume));
    sock.addEventListener('close', (ev) => {
      if (ws !== sock) return;
      clearInterval(heartbeat);
      clearTimeout(firstBeat);
      if (FATAL_CLOSE.has(ev.code)) { log.error(`Discord-Gateway beendet (Code ${ev.code}: ${ev.reason})`); return; }
      retry(ev.code !== 1000 && !!sessionId, 2000);
    });
    sock.addEventListener('error', () => {}); // close folgt
  }

  function retry(resume, ms) {
    if (!resume) { sessionId = null; seq = null; }
    setTimeout(() => connect(resume), ms + Math.random() * 1000).unref();
  }

  const sendOp = (sock, op, d) => { if (sock.readyState === 1) sock.send(JSON.stringify({ op, d })); };

  function onMessage(sock, msg, resume) {
    if (msg.s != null) seq = msg.s;
    switch (msg.op) {
      case OP.HELLO: {
        acked = true;
        const beat = () => {
          if (ws !== sock) return;
          if (!acked) { sock.close(4000, 'kein Heartbeat-ACK'); return; } // Verbindung tot
          acked = false;
          sendOp(sock, OP.HEARTBEAT, seq);
        };
        firstBeat = setTimeout(beat, msg.d.heartbeat_interval * Math.random());
        heartbeat = setInterval(beat, msg.d.heartbeat_interval);
        if (resume && sessionId) sendOp(sock, OP.RESUME, { token: Discord.TOKEN, session_id: sessionId, seq });
        else sendOp(sock, OP.IDENTIFY, { token: Discord.TOKEN, intents: 0, properties: { os: 'linux', browser: 'lan-system', device: 'lan-system' } });
        break;
      }
      case OP.HEARTBEAT_ACK: acked = true; break;
      case OP.HEARTBEAT: sendOp(sock, OP.HEARTBEAT, seq); break;
      case OP.RECONNECT: sock.close(4000, 'reconnect'); break;
      case OP.INVALID_SESSION:
        if (!msg.d) { sessionId = null; seq = null; }
        setTimeout(() => sock.close(4000, 'invalid session'), 1000 + Math.random() * 4000);
        break;
      case OP.DISPATCH:
        if (msg.t === 'READY') {
          sessionId = msg.d.session_id;
          resumeUrl = msg.d.resume_gateway_url;
          log.log(`Discord-Gateway verbunden als ${msg.d.user.username}`);
        } else if (msg.t === 'INTERACTION_CREATE') {
          onInteraction(msg.d).catch((err) => log.error('Discord-Befehl:', err.message));
        }
        break;
      default: break;
    }
  }

  // ---------- Interaktionen ----------
  const reply = (i, content, ephemeral = true) => Discord.call('POST', `/interactions/${i.id}/${i.token}/callback`, {
    type: 4, data: { content, flags: ephemeral ? 64 : 0, allowed_mentions: { parse: [] } },
  });
  const choices = (i, list) => Discord.call('POST', `/interactions/${i.id}/${i.token}/callback`, {
    type: 8, data: { choices: list.slice(0, 25).map((c) => ({ name: String(c.name).slice(0, 100), value: String(c.value).slice(0, 100) })) },
  });

  async function onInteraction(i) {
    if (i.guild_id !== Discord.GUILD) return;
    const user = i.member ? i.member.user : i.user;
    // Unterbefehle (/team gruenden …): Optionen stecken eine Ebene tiefer
    let options = i.data.options || [];
    let sub = null;
    if (options[0] && options[0].type === 1) { sub = options[0].name; options = options[0].options || []; }
    const ctx = {
      user: { id: user.id, name: (i.member && i.member.nick) || user.global_name || user.username },
      member: i.member,
      sub,
      opts: Object.fromEntries(options.map((o) => [o.name, o.value])),
      focused: options.find((o) => o.focused),
    };
    const h = handlers.find(i.data.name);
    if (!h) return;
    const name = `/${i.data.name}${sub ? ` ${sub}` : ''}`;
    if (i.type === 4) { // Autovervollständigung
      try { await choices(i, h.autocomplete ? await h.autocomplete(ctx) : []); }
      catch (err) {
        // Tippt jemand weiter, verwirft Discord die ältere Anfrage -> 404, harmlos
        if (err.status !== 404) logFailure(i, `${name} (Autovervollständigung)`, err);
      }
      return;
    }
    if (i.type !== 2) return;
    let out;
    try { out = await h.run(ctx); }
    catch (err) { out = `⚠️ ${err.message}`; }
    if (typeof out === 'string') out = { content: out };
    // Nur einmal antworten: scheitert die Antwort selbst, hilft ein zweiter Versuch nicht
    try { await reply(i, out.content, out.ephemeral !== false); }
    catch (err) { logFailure(i, name, err); }
  }

  // Alter der Interaktion aus ihrer ID (Snowflake): Discord erlaubt 3 s bis zur Antwort
  const DISCORD_EPOCH = 1420070400000;
  const ageMs = (i) => Date.now() - (Number(BigInt(i.id) >> 22n) + DISCORD_EPOCH);

  function logFailure(i, name, err) {
    const age = ageMs(i);
    let hint = '';
    if (err.status === 404 && age > 3000) hint = ' – Antwort kam zu spät (über 3 s)';
    else if (err.status === 404 || (err.status === 400 && /acknowledged/i.test(err.message)))
      hint = ' – schon anderweitig beantwortet, läuft der Bot mit demselben Token noch woanders?';
    log.error(`Discord-Befehl ${name}: ${err.message} (Antwort nach ${age} ms)${hint}`);
  }

  function stop() { stopped = true; clearInterval(heartbeat); clearTimeout(firstBeat); if (ws) ws.close(1000); }

  return { start, stop, refresh };
};
