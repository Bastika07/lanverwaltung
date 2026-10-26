'use strict';
// Durchsagen: eine Quelle (Webseite, Discord /announce, Programmpunkt) löst alles aus –
// Einblendung auf Beamer und Webseite (mit Gong), Discord-Post und DMX-Lampe.

const crypto = require('crypto');
const Dmx = require('./dmx.js');

module.exports = function announcements(ctx) {
  const { db, save, broadcast, send, readBody, requireAdmin, HttpError, str, settings, Discord } = ctx;
  db.announcements = db.announcements || [];
  let endTimer = null;

  function active() {
    const a = db.announcements[0];
    if (!a || a.endedAt) return null;
    if (a.until && Date.parse(a.until) <= Date.now()) return null;
    return a;
  }

  async function lamp(which, a) {
    try {
      const switched = await Dmx[which](settings().dmx);
      if (a && switched) a.lampError = null;
    } catch (err) {
      console.error(`DMX (${which}):`, err.message);
      if (a) a.lampError = err.message;
      save(); broadcast('announce');
    }
  }

  function scheduleEnd(a) {
    clearTimeout(endTimer);
    if (!a || !a.until) return;
    endTimer = setTimeout(() => end('timeout'), Math.max(0, Date.parse(a.until) - Date.now()));
  }

  // opts: { text, by, source: 'web'|'discord'|'schedule', lamp, gong, discord, seconds }
  function create(opts) {
    if (!ctx.moduleOn('announcements')) throw new HttpError(400, 'Das Modul Durchsagen ist ausgeschaltet');
    const text = str(opts.text, 500);
    if (!text) throw new HttpError(400, 'Text fehlt');
    const prev = active();
    if (prev) prev.endedAt = new Date().toISOString(); // neue Durchsage ersetzt die alte

    const seconds = opts.seconds !== undefined ? Number(opts.seconds) : settings().announceSeconds;
    const now = Date.now();
    const a = {
      id: crypto.randomBytes(5).toString('hex'),
      text,
      by: str(opts.by, 80),
      source: opts.source || 'web',
      at: new Date(now).toISOString(),
      until: seconds > 0 ? new Date(now + seconds * 1000).toISOString() : null,
      lamp: opts.lamp !== false,
      gong: opts.gong !== false,
      discord: opts.discord !== false,
    };
    db.announcements.unshift(a);
    db.announcements.length = Math.min(db.announcements.length, 100);
    save(); broadcast('announce');

    if (a.discord) {
      ctx.discordPost(`📢 **Durchsage**${a.by ? ` von ${Discord.md(a.by)}` : ''}: ${a.text}`, (error) => {
        if ((a.discordError || null) !== error) { a.discordError = error; save(); broadcast('announce'); }
      });
    }
    if (a.lamp) lamp('on', a);
    else if (prev && prev.lamp) lamp('off');
    scheduleEnd(a);
    return a;
  }

  function end() {
    clearTimeout(endTimer);
    const a = db.announcements[0];
    if (!a || a.endedAt) return null;
    a.endedAt = new Date().toISOString();
    if (a.lamp) lamp('off', a);
    save(); broadcast('announce');
    return a;
  }

  // Beim Start: abgelaufene Durchsage abschließen (Lampe aus), laufende weiter terminieren
  const last = db.announcements[0];
  if (last && !last.endedAt) {
    if (active()) scheduleEnd(last);
    else end();
  }

  async function routes(req, res, parts, method) {
    if (parts[0] !== 'announcements') return false;
    if (parts.length === 1 && method === 'GET') {
      send(res, 200, { active: active(), recent: db.announcements.slice(0, 20) });
      return true;
    }
    if (parts.length === 1 && method === 'POST') {
      requireAdmin(req);
      const body = await readBody(req);
      send(res, 201, create({ ...body, by: body.by || 'Orga', source: 'web' }));
      return true;
    }
    if (parts[1] === 'end' && method === 'POST') {
      requireAdmin(req);
      send(res, 200, { ended: end() });
      return true;
    }
    // Lampe testen: an / aus
    if (parts[1] === 'lamp' && method === 'POST') {
      requireAdmin(req);
      const body = await readBody(req);
      try {
        const switched = await Dmx[body.on ? 'on' : 'off'](settings().dmx);
        if (!switched) throw new HttpError(400, 'Keine OLA-Adresse eingestellt');
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(502, `Lampe nicht erreichbar: ${err.message}`);
      }
      send(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  return { routes, create, end, active };
};
