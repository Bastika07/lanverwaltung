'use strict';
const crypto = require('node:crypto');
const images = require('./sponsor-image');

// Websiteweit statt pro Event: veröffentlichte Rechtstexte bleiben auch bei Eventwechsel erreichbar.
const TITLES = { impressum: 'Impressum', datenschutz: 'Datenschutzerklärung', agb: 'AGB', verhaltenskodex: 'Verhaltenskodex' };
const COOKIE_TEXT = 'Diese Website verwendet technisch notwendige Cookies für Anmeldung und Sicherheit sowie Browserspeicher für Bedienfunktionen. Es werden durch die Anwendung keine Analyse- oder Marketingdienste geladen.';

module.exports = function website(ctx) {
  const { db, send, readBody, requireAdmin, HttpError } = ctx;
  const defaults = () => ({ version: 0, pages: Object.fromEntries(Object.entries(TITLES).map(([key, title]) => [key, { enabled: false, title, text: '', updatedAt: null }])),
    cookies: { enabled: false, text: COOKIE_TEXT }, sponsors: { enabled: false, text: '', entries: [] } });
  const current = () => db.meta.website || defaults();
  function text(value, max, label) {
    if (typeof value !== 'string' || value.length > max) throw new HttpError(400, `${label}: Text mit höchstens ${max} Zeichen erwartet`);
    return value.trim();
  }
  function flag(value) {
    if (typeof value !== 'boolean') throw new HttpError(400, 'Modulstatus muss an oder aus sein');
    return value;
  }
  function clean(body, old) {
    if (!body.pages || !body.cookies || !body.sponsors) throw new HttpError(400, 'Seiten, Cookie-Hinweis und Sponsoren fehlen');
    const pages = {};
    for (const [key, title] of Object.entries(TITLES)) {
      const p = body.pages[key];
      if (!p || typeof p !== 'object') throw new HttpError(400, `${title} fehlt`);
      const content = text(p.text, 60000, title), enabled = flag(p.enabled);
      if (enabled && !content) throw new HttpError(400, `${title}: vor Veröffentlichung einen Text hinterlegen`);
      pages[key] = { enabled, title, text: content, updatedAt: content === old.pages[key].text ? old.pages[key].updatedAt : new Date().toISOString() };
    }
    const cookies = { enabled: flag(body.cookies.enabled), text: text(body.cookies.text, 3000, 'Cookie-Hinweis') };
    if (cookies.enabled && !cookies.text) throw new HttpError(400, 'Bitte den Cookie-Hinweis ausfüllen');
    const s = body.sponsors;
    if (!Array.isArray(s.entries) || s.entries.length > 40) throw new HttpError(400, 'Höchstens 40 Sponsoren möglich');
    const seen = new Set();
    const sponsors = { enabled: flag(s.enabled), text: text(s.text, 5000, 'Sponsoren-Einleitung'), entries: s.entries.map((entry) => {
      if (!entry || typeof entry !== 'object') throw new HttpError(400, 'Ungültiger Sponsor');
      const name = text(entry.name, 120, 'Sponsorname'), url = text(entry.url, 1000, 'Sponsoren-Link');
      if (!name) throw new HttpError(400, 'Bitte für jeden Sponsor einen Namen eintragen');
      if (url) {
        let parsed;
        try { parsed = new URL(url); } catch { throw new HttpError(400, 'Ungültiger Sponsoren-Link'); }
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new HttpError(400, 'Sponsoren-Links müssen HTTPS ohne Zugangsdaten verwenden');
      }
      const previous = entry.id && old.sponsors.entries.find((s) => s.id === entry.id);
      if (entry.id && (!previous || seen.has(entry.id))) throw new HttpError(400, 'Ungültige Sponsor-ID');
      const id = previous ? previous.id : crypto.randomBytes(16).toString('hex');
      seen.add(id);
      return { id, ...(previous?.image ? { image: previous.image } : {}), name, url, description: text(entry.description, 2000, 'Sponsoren-Beschreibung'), tier: text(entry.tier, 80, 'Sponsoren-Kategorie'), enabled: flag(entry.enabled) };
    }) };
    return { version: old.version + 1, pages, cookies, sponsors };
  }
  const entryView = (entry) => ({ ...entry, ...(entry.image ? { image: images.view(entry.image) } : {}) });
  const adminView = (s = current()) => ({ ...s, sponsors: { ...s.sponsors, entries: s.sponsors.entries.map(entryView) } });
  function publicView() {
    const s = current();
    return {
      pages: Object.fromEntries(Object.entries(s.pages).filter(([, p]) => p.enabled).map(([key, p]) => [key, { title: p.title, text: p.text, updatedAt: p.updatedAt }])),
      cookies: s.cookies.enabled ? { text: s.cookies.text, revision: crypto.createHash('sha256').update(JSON.stringify([s.cookies.text, s.pages.datenschutz.enabled ? s.pages.datenschutz : null])).digest('hex').slice(0, 24) } : null,
      sponsors: s.sponsors.enabled ? { text: s.sponsors.text, entries: s.sponsors.entries.filter((entry) => entry.enabled).map(entryView) } : null,
    };
  }
  async function routes(req, res, parts, method) {
    if (parts[0] !== 'website') return false;
    if (parts.length === 1 && method === 'GET') { send(res, 200, publicView()); return true; }
    if (parts.length === 3 && parts[1] === 'sponsor-images' && method === 'GET') {
      const s = current();
      const entry = s.sponsors.entries.find((e) => e.image?.id === parts[2]);
      if (!entry || (!(s.sponsors.enabled && entry.enabled) && !ctx.isAdmin(req))) throw new HttpError(404, 'Bild nicht gefunden');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(Buffer.from(entry.image.data, 'base64')); return true;
    }
    if (parts.length === 4 && parts[1] === 'sponsors' && parts[3] === 'image' && ['PUT', 'DELETE'].includes(method)) {
      requireAdmin(req);
      const b = await readBody(req);
      requireAdmin(req);
      const old = current();
      if (b.version !== old.version) throw new HttpError(409, 'Inhalte wurden inzwischen geändert. Bitte neu laden.');
      const next = structuredClone(old);
      const entry = next.sponsors.entries.find((e) => e.id === parts[2]);
      if (!entry) throw new HttpError(404, 'Sponsor nicht gefunden');
      if (method === 'PUT') entry.image = images.decode(b.data, HttpError);
      else delete entry.image;
      next.version++; db.meta.website = next; ctx.save(); ctx.broadcast('website');
      send(res, 200, adminView(next)); return true;
    }
    if (parts.length !== 2 || parts[1] !== 'admin') return false;
    requireAdmin(req);
    if (method === 'GET') { send(res, 200, adminView()); return true; }
    if (method === 'PUT') {
      const b = await readBody(req);
      requireAdmin(req); // Auch ein während des Uploads ausgeloggter Admin darf nicht mehr veröffentlichen.
      const old = current();
      if (b.version !== old.version) throw new HttpError(409, 'Inhalte wurden inzwischen geändert. Bitte neu laden und Änderungen abgleichen.');
      const next = clean(b, old); // vollständig prüfen, bevor gespeicherte Inhalte geändert werden
      db.meta.website = next;
      ctx.save(); ctx.broadcast('website');
      send(res, 200, adminView(next));
      return true;
    }
    return false;
  }
  return { routes, alwaysOn: true };
};
