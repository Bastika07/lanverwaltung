'use strict';
// Programm/Zeitplan: Punkte mit Startzeit, Erinnerung in Discord vorher und optional
// einer Durchsage (Lampe, Gong, Einblendung) zum Start.

const crypto = require('crypto');

module.exports = function schedule(ctx) {
  const { db, save, broadcast, send, readBody, requireAdmin, HttpError, str, settings, Discord } = ctx;
  db.schedule = db.schedule || [];

  const sorted = () => db.schedule.slice().sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const ts = (iso, style) => `<t:${Math.floor(Date.parse(iso) / 1000)}:${style}>`; // Discord zeigt Ortszeit

  function clean(body, old = {}) {
    const title = str(body.title ?? old.title, 120);
    if (!title) throw new HttpError(400, 'Titel fehlt');
    const start = new Date(body.start ?? old.start);
    if (Number.isNaN(start.getTime())) throw new HttpError(400, 'Ungültige Startzeit');
    let end = body.end !== undefined ? body.end : old.end;
    end = end ? new Date(end) : null;
    if (end && (Number.isNaN(end.getTime()) || end <= start)) throw new HttpError(400, 'Ende muss nach dem Start liegen');
    const remind = Number(body.remind ?? old.remind ?? settings().remindMinutes);
    return {
      title,
      start: start.toISOString(),
      end: end ? end.toISOString() : null,
      note: str(body.note ?? old.note, 500),
      remind: Number.isFinite(remind) && remind >= 0 ? Math.min(remind, 24 * 60) : 0,
      announce: !!(body.announce ?? old.announce), // zum Start als Durchsage
    };
  }

  // Prüft regelmäßig, ob Erinnerungen oder Startmeldungen fällig sind.
  function tick() {
    if (!ctx.moduleOn('schedule')) return;
    const now = Date.now();
    let changed = false;
    for (const e of db.schedule) {
      const start = Date.parse(e.start);
      if (e.remind > 0 && !e.remindedAt && !e.startedAt && now >= start - e.remind * 60000 && now < start) {
        e.remindedAt = new Date().toISOString();
        changed = true;
        ctx.discordPost(`⏰ ${ts(e.start, 'R')}: **${Discord.md(e.title)}** (${ts(e.start, 't')})${e.note ? `\n${e.note}` : ''}`);
      }
      if (!e.startedAt && now >= start) {
        e.startedAt = new Date().toISOString();
        changed = true;
        if (now - start > 10 * 60000) continue; // Server war aus: nicht nachträglich melden
        if (e.announce && ctx.moduleOn('announcements')) ctx.announcements.create({ text: e.title + (e.note ? ` – ${e.note}` : ''), by: 'Programm', source: 'schedule' });
        else ctx.discordPost(`🕖 Jetzt: **${Discord.md(e.title)}**${e.note ? `\n${e.note}` : ''}`);
      }
    }
    if (changed) { save(); broadcast('schedule'); }
  }
  setInterval(tick, 15000).unref();
  setTimeout(tick, 2000).unref();

  async function routes(req, res, parts, method) {
    if (parts[0] !== 'schedule') return false;
    if (parts.length === 1 && method === 'GET') { send(res, 200, sorted()); return true; }
    requireAdmin(req);
    if (parts.length === 1 && method === 'POST') {
      const e = { id: crypto.randomBytes(5).toString('hex'), ...clean(await readBody(req)) };
      db.schedule.push(e);
      save(); broadcast('schedule'); tick();
      send(res, 201, e);
      return true;
    }
    const e = db.schedule.find((x) => x.id === parts[1]);
    if (!e) throw new HttpError(404, 'Programmpunkt nicht gefunden');
    if (parts.length === 2 && method === 'PUT') {
      const next = clean(await readBody(req), e);
      // Zeit in die Zukunft verschoben -> Erinnerung/Start erneut auslösen
      if (Date.parse(next.start) > Date.now()) { delete e.remindedAt; delete e.startedAt; }
      Object.assign(e, next);
      save(); broadcast('schedule'); tick();
      send(res, 200, e);
      return true;
    }
    if (parts.length === 2 && method === 'DELETE') {
      db.schedule = db.schedule.filter((x) => x !== e);
      save(); broadcast('schedule');
      send(res, 200, { ok: true });
      return true;
    }
    return false;
  }

  // Für Discord-Befehle: die nächsten Punkte (laufende zuerst)
  function upcoming(limit = 5) {
    const now = Date.now();
    return sorted().filter((e) => Date.parse(e.end || e.start) + (e.end ? 0 : 30 * 60000) > now).slice(0, limit);
  }

  return { routes, upcoming, ts };
};
