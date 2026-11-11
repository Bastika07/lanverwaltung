'use strict';
// LAN-System: Turniere, Durchsagen, Programm, Infos, Teilnehmer & Sitzplan – ohne externe Abhängigkeiten.
// Start: HOST=127.0.0.1 node server.js (Notzugang ohne Discord: DATA_DIR/admin-password.txt)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Bracket = require('./public/bracket.js');
const Discord = require('./lib/discord.js');
const Dmx = require('./lib/dmx.js');
const Security = require('./lib/security.js');
const Access = require('./lib/access.js');
const Storage = require('./lib/storage.js');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Admin-Zugang ----------
// Normalerweise per Discord: Wer auf dem Discord-Server die eingestellte Rolle hat (oder Inhaber bzw.
// Administrator ist), meldet sich mit Discord an (siehe lib/accounts.js). Das braucht Bot-Token,
// Server-ID und DISCORD_CLIENT_SECRET.
// Das Passwort ist ein optionaler Notzugang: ADMIN_PASSWORD bzw. ADMIN_PASSWORD_FILE (z. B. Docker
// Secret). Ist weder Passwort noch Discord-Login eingerichtet, wird einmalig ein Passwort erzeugt und
// in DATA_DIR gespeichert, damit man sich nicht aussperrt.
const DISCORD_ADMIN_POSSIBLE = !!((process.env.DISCORD_CLIENT_SECRET || process.env.DISCORD_CLIENT_SECRET_FILE) && Discord.enabled);
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD && process.env.ADMIN_PASSWORD_FILE) {
  ADMIN_PASSWORD = fs.readFileSync(process.env.ADMIN_PASSWORD_FILE, 'utf8').trim();
}
if (!ADMIN_PASSWORD && !DISCORD_ADMIN_POSSIBLE) {
  const pwFile = path.join(DATA_DIR, 'admin-password.txt');
  if (fs.existsSync(pwFile)) ADMIN_PASSWORD = fs.readFileSync(pwFile, 'utf8').trim();
  else {
    ADMIN_PASSWORD = crypto.randomBytes(9).toString('base64url');
    fs.writeFileSync(pwFile, ADMIN_PASSWORD + '\n', { mode: 0o600 });
  }
  console.log(`Kein ADMIN_PASSWORD gesetzt – Notzugang steht in ${pwFile} (nicht im Log).`);
}

if (ADMIN_PASSWORD && ADMIN_PASSWORD.length < 12) {
  console.warn('WARNUNG: ADMIN_PASSWORD ist kürzer als 12 Zeichen – für eine aus dem Internet erreichbare Seite bitte ein längeres Passwort wählen.');
}

// ---------- Speicher ----------
const storage = Storage.openStore(DATA_DIR);
const db = storage.data;
db.meta = db.meta || {}; // z. B. ID des automatisch angelegten Discord-Ansagekanals

// ---------- Einstellungen (im Admin-Bereich änderbar, Startwerte aus der Umgebung) ----------
const env = process.env;
// Leere Werte (z. B. aus docker-compose "${X:-}") zählen als nicht gesetzt
const envNum = (name, def) => (env[name] !== undefined && env[name] !== '' && Number.isFinite(Number(env[name])) ? Number(env[name]) : def);
const DEFAULT_SETTINGS = {
  eventName: env.EVENT_NAME || 'LAN-Party',
  beamerSeconds: 20,
  speakDefault: false, // Durchsagen standardmäßig vorlesen (Discord-TTS und Beamer); pro Durchsage änderbar
  speakMatches: false, // Beamer liest neu anstehende Turnierspiele vor (Sprachausgabe des Browsers)
  announceSeconds: envNum('DMX_RESET_SECONDS', 60),
  announceRole: env.ANNOUNCE_ROLE_NAME || '',
  adminRole: env.ADMIN_DISCORD_ROLE || '', // Eindeutige Discord-Rollen-ID für den Admin-Bereich
  remindMinutes: 10,
  mentionPlayers: true,
  coinBudget: 0, // Coins je Person und Event für Turniere mit Kosten (0 = Coin-System aus)
  // Module der LAN-Party, einzeln abschaltbar (z. B. kein Beamer, kein Sitzplan)
  modules: { details: true, tournaments: true, announcements: true, schedule: true, info: true, people: true, seating: true, beamer: true, tickets: false, servers: false, catering: false, cs2: false },
  dmx: {
    url: env.OLA_URL || '',
    universe: Number(env.DMX_UNIVERSE) || 1,
    on: env.DMX_ON || `${Number(env.DMX_RED_CHANNEL) || 1}=255`,
    off: env.DMX_OFF || '',
  },
};
const stored = db.meta.settings || {};
db.meta.settings = {
  ...DEFAULT_SETTINGS, ...stored,
  dmx: { ...DEFAULT_SETTINGS.dmx, ...(stored.dmx || {}) },
  modules: { ...DEFAULT_SETTINGS.modules, ...(stored.modules || {}) },
};
const settings = () => db.meta.settings;
// Module sind pro Event schaltbar (event.modules, Event der Anfrage bzw. das aktuelle).
// settings().modules ist nur noch die Vorlage für Events ohne eigene Auswahl. Sitzplan baut auf der Teilnehmerliste auf.
const moduleOnIn = (mods, key) => !!mods[key] && (key !== 'seating' || !!mods.people);
const eventModules = (e) => (e && e.modules) || settings().modules;
const moduleOn = (key) => moduleOnIn(eventModules(modules.event && modules.event.scoped()), key);
// Tickets auch dann, wenn nur ein kommendes Event Vorverkauf hat (Menüpunkt, Discord-Login)
const ticketsAnywhere = () => moduleOn('tickets')
  || !!(modules.event && modules.event.all().some((e) => !modules.event.isOver(e) && moduleOnIn(eventModules(e), 'tickets')));
// Ticketseite ohne Eventwahl: das aktuelle Event, sonst das nächste mit Ticketverkauf (Vorverkauf)
function ticketEvent() {
  const cur = modules.event.current();
  if (moduleOnIn(eventModules(cur), 'tickets')) return cur;
  const next = modules.event.all().filter((e) => !modules.event.isOver(e) && moduleOnIn(eventModules(e), 'tickets'));
  return next.sort((a, b) => (a.start ? Date.parse(a.start) : Infinity) - (b.start ? Date.parse(b.start) : Infinity))[0] || null;
}
// ---------- Sichtbarkeit: öffentlich oder nur für Teilnehmer mit Ticket (pro Event und Modul) ----------
// Teilnehmer = gültiges Ticket oder ausdrücklich von der Orga bestätigte Teilnahme.
const RESTRICTABLE = ['details', 'tournaments', 'schedule', 'info', 'people', 'seating', 'beamer', 'servers', 'catering'];
const accessOf = (e, key) => ((e && e.access) || {})[key] === 'tickets' ? 'tickets' : 'public';
function isMemberId(discordId, e) {
  return Access.isMember(db, discordId, e);
}
const isMember = (req, e) => { const a = modules.accounts && modules.accounts.current(req); return !!a && isMemberId(a.id, e); };
const mayView = (req, key, e = modules.event.scoped()) => accessOf(e, key) === 'public' || isAdmin(req) || isMember(req, e);
// Besucher-Login mit Discord: für Tickets, Gastserver oder um eingeschränkte Module zu sehen
const userLoginNeeded = () => ticketsAnywhere() || moduleOnIn(eventModules(modules.event.current()), 'tournaments') || moduleOnIn(eventModules(modules.event.current()), 'servers')
  || moduleOnIn(eventModules(modules.event.current()), 'catering')
  || RESTRICTABLE.some((k) => accessOf(modules.event.current(), k) === 'tickets');
// API-Pfade, deren Daten zu einem einschränkbaren Modul gehören (Sitzplan steckt in /people)
const PATH_MODULE = { details: 'details', tournaments: 'tournaments', schedule: 'schedule', info: 'info', people: 'people', servers: 'servers', catering: 'catering' };

// Was Besucher sehen: immer die Module des aktuellen Events
const visibleModules = () => {
  const mods = eventModules(modules.event && modules.event.current());
  return Object.fromEntries(Object.keys(DEFAULT_SETTINGS.modules).map((k) => [k, k === 'tickets' ? ticketsAnywhere() : moduleOnIn(mods, k)]));
};
const publicSettings = () => ({
  eventName: modules.event ? modules.event.current().name : settings().eventName,
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, '') || null, // für Links in QR-Codes
  event: modules.event ? modules.event.state() : null, // das aktuelle Event
  beamerSeconds: settings().beamerSeconds,
  coinBudget: coinBudget(),
  speakMatches: !!settings().speakMatches,
  modules: visibleModules(),
});

// Jede Speicherung erhöht die Revision; zwischengespeicherte Turnieransichten gelten nur bis zur nächsten.
let revision = 0;
function save() {
  revision++;
  try { storage.save(db); }
  catch {
    // Bei Schreibfehlern nicht mit einem ungespeicherten Objektmodell weiterlaufen.
    console.error('SQLite-Schreibvorgang fehlgeschlagen; Prozess wird zum sicheren Neuladen beendet.');
    process.exit(1);
  }
}

// ---------- Sessions ----------
// token -> { exp, discordId?, checkedAt? } – bei Discord-Anmeldung wird die Rolle regelmäßig nachgeprüft
const sessions = new Map();
const SESSION_MS = 1000 * 60 * 60 * 24 * 7;
const RECHECK_MS = 10 * 60000;
setInterval(() => { for (const [tok, s] of sessions) if (s.exp < Date.now()) sessions.delete(tok); }, 3600e3).unref();

function startAdminSession(req, res, discordUser) {
  const tok = crypto.randomBytes(32).toString('hex');
  sessions.set(tok, { exp: Date.now() + SESSION_MS, discordId: discordUser ? discordUser.id : null, checkedAt: Date.now() });
  return Security.cookie(req, 'session', tok, { maxAge: SESSION_MS / 1000, sameSite: 'Strict' });
}

function parseCookies(req) {
  const out = Object.create(null);
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
      catch { throw new HttpError(400, 'Ungültiges Cookie'); }
    }
  }
  return out;
}

function isAdmin(req) {
  const tok = parseCookies(req).session;
  const s = tok && sessions.get(tok);
  if (!s) return false;
  if (s.exp < Date.now()) { sessions.delete(tok); return false; }
  // Abgelaufene Rollenbestätigung berechtigt nicht weiter; Wiederprüfung wird zusammengefasst.
  if (s.discordId && Date.now() - s.checkedAt > RECHECK_MS) {
    if (!s.checking) {
      s.checking = modules.accounts.isDiscordAdmin(s.discordId)
        .then((ok) => { if (ok) s.checkedAt = Date.now(); else sessions.delete(tok); })
        .catch((err) => console.error('Admin-Rolle prüfen:', err.message))
        .finally(() => { s.checking = null; });
    }
    return false;
  }
  return true;
}

function checkPassword(pw) {
  if (!ADMIN_PASSWORD || typeof pw !== 'string') return false;
  // Ephemeral fixed-length comparison digests, not stored password verifiers.
  // Neither digest is persisted/logged; timingSafeEqual needs equal byte lengths.
  // Future persisted password verifiers must use a salted password KDF (scrypt/Argon2).
  const a = crypto.createHash('sha256').update(String(pw)).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------- Live-Updates (Server-Sent Events) ----------
// type: 'tournament' | 'announce' | 'schedule' | 'info' | 'people' | 'settings'
const clients = new Set();
function broadcast(type, id) {
  const msg = `data: ${JSON.stringify({ type, id })}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

// ---------- Hilfen ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  const adminAtStart = isAdmin(req);
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 256 * 1024) { reject(new HttpError(413, 'Anfrage zu groß')); req.destroy(); }
    });
    req.on('end', () => {
      // Uploads können offen bleiben, während Logout/Rollenwiderruf die Sitzung entzieht.
      if (adminAtStart && !isAdmin(req)) return reject(new HttpError(401, 'Admin-Sitzung abgelaufen – bitte erneut anmelden'));
      if (!data) return resolve({});
      try {
        const body = JSON.parse(data);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch { reject(new HttpError(400, 'JSON-Objekt erwartet')); }
    });
    req.on('error', reject);
  });
}

function requireAdmin(req) {
  if (!isAdmin(req)) throw new HttpError(401, 'Admin-Login erforderlich');
}

function findTournament(id) {
  const t = db.tournaments.find((x) => x.id === id);
  if (!t) throw new HttpError(404, 'Turnier nicht gefunden');
  return t;
}

function str(v, max = 100) {
  if (v !== null && typeof v === 'object') throw new HttpError(400, 'Textwert erwartet');
  return String(v || '').trim().slice(0, max);
}

// ---------- Turnierleitung, Protokoll, Ergebnisse ----------
// Wer handelt: Orga (Admin), Turnierleiter dieses Turniers oder ein Spieler (mit seiner Person)
function actor(req, t) {
  const account = modules.accounts && modules.accounts.current(req);
  return { ...tournaments.role({ admin: isAdmin(req), discordId: account ? account.id : null }, t), account };
}

// ---------- Coins ----------
// Optional: Jede Person hat pro Event ein Budget (Einstellung coinBudget, 0 = aus); Turniere kosten t.coins.
// Geprüft wird bei der Anmeldung über Discord (lib/commands.js).
const coinBudget = () => Math.max(0, Math.floor(Number(settings().coinBudget) || 0));

// ---------- Discord-Ansagen ----------
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
// Eigene Adresse: PUBLIC_URL, sonst aus der Anfrage (Reverse Proxy: X-Forwarded-Proto/-Host)
function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = Security.isHttps(req) ? 'https' : 'http';
  const host = String((Security.trustProxy(req) && req.headers['x-forwarded-host']) || req.headers.host || 'localhost').split(',')[0].trim();
  if (!/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::\d{1,5})?$/i.test(host)) throw new HttpError(400, 'Ungültiger Host');
  return `${proto}://${host}`;
}
let discordChain = Promise.resolve();

// Nachricht in einen Ansagekanal – alle Module nacheinander, damit die Reihenfolge stimmt.
// kind: 'general' (Durchsagen, Programm) oder 'tournaments'.
// onResult(fehlerOderNull) meldet das Ergebnis. Fehler blockieren nichts. opts.tts: Discord liest die Nachricht vor.
// Ansagen gehen nur während des Events raus (siehe lib/event.js).
function discordQueue(fn) {
  discordChain = discordChain.then(fn).catch((err) => console.error('Discord:', err.message));
  return discordChain;
}

function discordPost(text, onResult, kind = 'general', users = [], opts = {}) {
  if (!Discord.enabled || !text || !modules.event || !modules.event.active()) return;
  discordQueue(async () => {
    const key = kind === 'tournaments' ? 'tournamentChannelId' : 'announceChannelId';
    const before = JSON.stringify(db.meta);
    let error = null;
    const postIt = async () => Discord.post(await Discord.announceChannel(db.meta, kind, modules.event.activeName()), text, users, opts);
    try {
      try { await postIt(); }
      catch (err) {
        if (err.status !== 404) throw err;
        db.meta[key] = null; // Kanal wurde in Discord gelöscht -> neu anlegen und nochmal
        await postIt();
      }
    } catch (err) { error = err.message; console.error('Discord-Ansage:', error); }
    if (before !== JSON.stringify(db.meta)) save();
    if (onResult) onResult(error);
  });
}

// ---------- Turniere ----------
// Discord-Seite (Kanäle, Ansagen) und Turniermodul; die Routen unten ziehen in Schritt 3 ins Modul.
const tournamentDiscord = require('./lib/tournament-discord.js')({ Discord, settings, moduleOn, people: () => modules.people,
  events: () => modules.event, discordPost, save, broadcast, publicUrl: PUBLIC_URL });
const tournaments = require('./lib/tournaments.js')({ db, save, broadcast, HttpError, str, notifier: tournamentDiscord, revision: () => revision });
const { cleanParticipants, cleanType, cleanGroups, cleanTeamSize, cleanCs2, tournamentExtras, pruneStale, logMatch,
  applyMembers, chosenPlayers, summary } = tournaments;
const cachedView = tournaments.view;
const { isFinished, clampInt } = require('./lib/tournaments.js');

// Offene Meldungen ohne Einspruch gelten nach t.confirmMinutes automatisch (alle Events)
const autoConfirm = () => { for (const e of modules.event ? modules.event.all() : []) tournaments.of(e).autoConfirm(); };
setInterval(autoConfirm, 20000).unref();
setTimeout(autoConfirm, 1000).unref(); // auch gleich nach dem Start (Meldungen, die während eines Neustarts abgelaufen sind)

// ---------- API ----------
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // ohne "api"
  const method = req.method;

  if (parts[0] === 'events' && method === 'GET') {
    // Begrenzen, damit niemand den Server mit offenen Verbindungen lahmlegt
    const ip = Security.clientIp(req);
    const mine = [...clients].filter((c) => c.ip === ip).length;
    if (clients.size >= 2000 || mine >= 30) throw new HttpError(429, 'Zu viele Live-Verbindungen');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': hallo\n\n');
    res.ip = ip;
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // CSRF-Schutz: ändernde Anfragen nur von der eigenen Seite
  if (method !== 'GET' && method !== 'HEAD') {
    const own = [`${Security.isHttps(req) ? 'https' : 'http'}://${req.headers.host}`, PUBLIC_URL && new URL(PUBLIC_URL).origin].filter(Boolean);
    if (!Security.sameOrigin(req, own)) {
      Security.log('csrf_blocked', req, { path: url.pathname, origin: req.headers.origin || null });
      throw new HttpError(403, 'Anfrage von fremder Seite abgelehnt');
    }
  }
  Security.rateLimit(req, 'api', 1200, 60000); // grobe Bremse gegen Überlastung

  if (parts[0] === 'health' && method === 'GET') return send(res, 200, { ok: true });

  if (parts[0] === 'me' && method === 'GET') {
    return send(res, 200, {
      admin: isAdmin(req), discord: Discord.enabled, settings: publicSettings(),
      // Sichtbarkeit im aktuellen Event und ob dieser Besucher Teilnehmer mit Ticket ist
      access: Object.fromEntries(RESTRICTABLE.map((k) => [k, accessOf(modules.event.current(), k)])),
      member: isMember(req, modules.event.current()),
      userLogin: userLoginNeeded() && modules.accounts.enabled(), // „Mit Discord anmelden“ für Besucher möglich
      adminLogin: { discord: DISCORD_ADMIN_POSSIBLE, password: !!ADMIN_PASSWORD }, // welche Anmeldewege es gibt
    });
  }

  if (parts[0] === 'settings') {
    requireAdmin(req);
    // Module des Events, das der Admin gerade bearbeitet; alles andere gilt für alle Events
    const scopedView = async () => {
      const adminRoleWarning = await modules.accounts.adminRoleWarning();
      requireAdmin(req); // Rollenabfrage kann länger dauern; widerrufene Sitzungen erhalten keine Einstellungen.
      return { ...settings(), adminRoleWarning, modules: eventModules(modules.event.scoped()), access: modules.event.scoped().access || {} };
    };
    if (method === 'GET') return send(res, 200, await scopedView());
    if (method === 'PUT') {
      const b = await readBody(req);
      const adminRole = b.adminRole === undefined ? undefined : str(b.adminRole, 100);
      if (adminRole && !/^[1-9]\d{16,19}$/.test(adminRole)) throw new HttpError(400, 'Adminrolle: Bitte eine eindeutige Discord-Rollen-ID angeben, keinen Rollennamen');
      const cur = settings();
      const num = (v, min, max, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def; };
      // Texte und DMX vor allen Änderungen prüfen: eine abgelehnte Anfrage ändert nichts.
      const eventName = b.eventName !== undefined ? str(b.eventName, 60) : undefined;
      const announceRole = b.announceRole !== undefined ? str(b.announceRole, 100) : undefined;
      const dmx = b.dmx ? { url: str(b.dmx.url, 200), universe: num(b.dmx.universe, 0, 65535, 1), on: str(b.dmx.on, 500), off: str(b.dmx.off, 500) } : null;
      if (dmx) {
        if (dmx.url && !/^https?:\/\//.test(dmx.url)) throw new HttpError(400, 'OLA-Adresse muss mit http:// beginnen');
        try { Dmx.parseValues(dmx.on); Dmx.parseValues(dmx.off); } catch (err) { throw new HttpError(400, err.message); }
      }
      if (eventName !== undefined) cur.eventName = eventName || 'LAN-Party'; // nur noch Vorgabe – die Namen stehen an den Events
      if (b.beamerSeconds !== undefined) cur.beamerSeconds = num(b.beamerSeconds, 5, 600, 20);
      if (b.announceSeconds !== undefined) cur.announceSeconds = num(b.announceSeconds, 0, 3600, 60);
      if (b.speakDefault !== undefined) cur.speakDefault = !!b.speakDefault;
      if (b.speakMatches !== undefined) cur.speakMatches = !!b.speakMatches;
      if (announceRole !== undefined) cur.announceRole = announceRole;
      if (adminRole !== undefined && adminRole !== cur.adminRole) {
        cur.adminRole = adminRole;
        Security.log('admin_role_changed', req);
      }
      if (b.remindMinutes !== undefined) cur.remindMinutes = num(b.remindMinutes, 0, 1440, 10);
      if (b.mentionPlayers !== undefined) cur.mentionPlayers = !!b.mentionPlayers;
      if (b.coinBudget !== undefined) cur.coinBudget = num(Math.floor(Number(b.coinBudget)), 0, 99, 0);
      if (b.modules) {
        const e = modules.event.scoped();
        e.modules = { ...eventModules(e) };
        for (const k of Object.keys(DEFAULT_SETTINGS.modules)) if (b.modules[k] !== undefined) e.modules[k] = !!b.modules[k];
        refreshCommands(); // Slash-Befehle an aktive Module anpassen
      }
      if (b.access) { // Sichtbarkeit pro Modul für das bearbeitete Event
        const e = modules.event.scoped();
        e.access = { ...(e.access || {}) };
        for (const k of RESTRICTABLE) if (b.access[k] !== undefined) e.access[k] = b.access[k] === 'tickets' ? 'tickets' : 'public';
      }
      if (dmx) cur.dmx = dmx;
      save(); broadcast('settings');
      Security.log('settings_changed', req, { keys: Object.keys(b) });
      return send(res, 200, await scopedView());
    }
  }

  // Abgeschaltete Module sind für Besucher unsichtbar; der Admin kann sie weiter vorbereiten.
  const admin = isAdmin(req);
  // Nur für Teilnehmer mit Ticket? Dann auch die Daten nur für sie (auch Ergebnis-Eintragen usw.)
  const gated = PATH_MODULE[parts[0]];
  if (!admin && gated && moduleOn(gated) && !mayView(req, gated)) {
    throw new HttpError(403, 'Nur für Teilnehmer mit Ticket – bitte unter „Tickets“ mit Discord anmelden');
  }
  for (const [key, m] of Object.entries(modules)) {
    if (!admin && !m.alwaysOn && !moduleOn(m.moduleKey || key)) continue;
    if (m.routes && await m.routes(req, res, parts, method)) return;
  }
  if (parts[0] === 'tournaments' && !admin && !moduleOn('tournaments')) throw new HttpError(404, 'Nicht gefunden');

  if (parts[0] === 'login' && method === 'POST') {
    Security.rateLimit(req, 'admin_login', 10, 15 * 60000); // max. 10 Versuche je 15 Minuten und IP
    if (!ADMIN_PASSWORD) throw new HttpError(400, 'Die Anmeldung mit Passwort ist ausgeschaltet – bitte mit Discord anmelden');
    const body = await readBody(req);
    if (!checkPassword(body.password || '')) {
      Security.log('admin_login_failed', req);
      await new Promise((r) => setTimeout(r, 800));
      throw new HttpError(403, 'Falsches Passwort');
    }
    res.setHeader('Set-Cookie', startAdminSession(req, res, null));
    Security.log('admin_login', req);
    return send(res, 200, { admin: true });
  }

  if (parts[0] === 'logout' && method === 'POST') {
    sessions.delete(parseCookies(req).session);
    res.setHeader('Set-Cookie', Security.cookie(req, 'session', '', { maxAge: 0, sameSite: 'Strict' }));
    Security.log('admin_logout', req);
    return send(res, 200, { admin: false });
  }

  if (parts[0] !== 'tournaments') throw new HttpError(404, 'Nicht gefunden');

  // /api/tournaments
  if (parts.length === 1) {
    if (method === 'GET') {
      const admin = isAdmin(req);
      const list = db.tournaments.filter((t) => admin || t.status !== 'draft').map(summary);
      return send(res, 200, list);
    }
    if (method === 'POST') {
      requireAdmin(req);
      const body = await readBody(req);
      const name = str(body.name);
      if (!name) throw new HttpError(400, 'Name fehlt');
      const t = {
        id: crypto.randomBytes(5).toString('hex'),
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
      Access.bindPlayers(db, t, false, chosenPlayers(t.participants, body.playerIds));
      db.tournaments.unshift(t);
      tournamentDiscord.changed(t);
      save(); broadcast('tournament', t.id);
      return send(res, 201, t);
    }
  }

  const t = findTournament(parts[1]);

  // /api/tournaments/:id
  const tournamentView = () => {
    if (isAdmin(req)) return t;
    const { discord, discordStatus, announceError, log, referees, ...pub } = t;
    const account = modules.accounts.current(req);
    // Turnierleiter sehen das Protokoll und dürfen alle Spiele bearbeiten
    if (account && Access.isReferee(db, account.id, t)) return { ...pub, log: log || [], referee: true, reportableMatches: [], mySides: {} };
    // Eigene Teilnehmerplätze einmal bestimmen; ohne solche (z. B. anonym) entfällt die Spielplanberechnung ganz.
    const own = Access.reportableSides(db, account && account.id, t);
    const view = own.size ? cachedView(t) : null;
    const mine = view ? view.matches.filter((m) => own.has(m.a) || own.has(m.b)) : [];
    return { ...pub, reportableMatches: mine.map((m) => m.id), mySides: Object.fromEntries(mine.map((m) => [m.id, own.has(m.a) ? 'a' : 'b'])) };
  };
  if (parts.length === 2) {
    if (method === 'GET') {
      const admin = isAdmin(req);
      if (t.status === 'draft' && !admin) throw new HttpError(404, 'Turnier nicht gefunden');
      if (admin) return send(res, 200, t);
      return send(res, 200, tournamentView());
    }
    if (method === 'PUT') {
      requireAdmin(req);
      const body = await readBody(req);
      // Alle Eingaben vor jeder Änderung prüfen: eine abgelehnte Anfrage ändert nichts.
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
        Access.bindPlayers(db, t, true, chosen);
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
      tournamentDiscord.changed(t, renames);
      save(); broadcast('tournament', t.id);
      return send(res, 200, t);
    }
    if (method === 'DELETE') {
      requireAdmin(req);
      db.tournaments = db.tournaments.filter((x) => x !== t);
      tournamentDiscord.removed(t);
      save(); broadcast('tournament', t.id);
      return send(res, 200, { ok: true });
    }
  }

  // /api/tournaments/:id/start   – Setzliste festlegen und Turnier starten
  if (parts[2] === 'start' && method === 'POST') {
    requireAdmin(req);
    const body = await readBody(req);
    if (t.participants.length < 2) throw new HttpError(400, 'Mindestens 2 Teilnehmer nötig');
    if (t.type === 'groups' && t.participants.length < 2 * cleanGroups(t.groups).count)
      throw new HttpError(400, `Für ${cleanGroups(t.groups).count} Gruppen braucht es mindestens ${2 * cleanGroups(t.groups).count} Teilnehmer`);
    const order = t.participants.map((_, i) => i);
    Access.bindPlayers(db, t, true);
    // Feste Setzplätze: die ersten N der Liste bleiben, der Rest wird ausgelost
    const seeds = body.seeds !== undefined ? clampInt(body.seeds, 0, order.length, 0) : Math.min(t.seeds || 0, order.length);
    if (body.shuffle) {
      for (let i = order.length - 1; i > seeds; i--) {
        const j = seeds + crypto.randomInt(i - seeds + 1);
        [order[i], order[j]] = [order[j], order[i]];
      }
    }
    t.seeds = seeds;
    t.order = order;
    t.results = {}; t.pending = {}; t.playing = {}; t.disqualified = [];
    t.status = 'running';
    logMatch(t, null, body.shuffle ? `Gestartet (Auslosung${seeds ? `, ${seeds} gesetzt` : ''})` : 'Gestartet (Setzliste)', 'Orga');
    tournamentDiscord.started(t);
    save(); broadcast('tournament', t.id);
    return send(res, 200, t);
  }

  // /api/tournaments/:id/duplicate   – Kopie als neuer Entwurf (gleiche Teilnehmer & Einstellungen)
  if (parts[2] === 'duplicate' && method === 'POST') {
    requireAdmin(req);
    const copy = {
      id: crypto.randomBytes(5).toString('hex'),
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
    db.tournaments.unshift(copy);
    tournamentDiscord.changed(copy);
    save(); broadcast('tournament', copy.id);
    return send(res, 201, copy);
  }

  // /api/tournaments/:id/discord   – Discord-Kanäle manuell abgleichen
  if (parts[2] === 'discord' && method === 'POST') {
    requireAdmin(req);
    if (!Discord.enabled) throw new HttpError(400, 'Discord ist nicht konfiguriert');
    await tournamentDiscord.sync(t);
    return send(res, 200, t);
  }

  // /api/tournaments/:id/reset   – zurück in den Entwurf
  if (parts[2] === 'reset' && method === 'POST') {
    requireAdmin(req);
    const wasFinished = isFinished(t);
    t.order = [];
    t.results = {}; t.pending = {}; t.playing = {}; t.disqualified = [];
    t.status = 'draft';
    logMatch(t, null, 'Zurück auf Entwurf', 'Orga');
    tournamentDiscord.reset(t, wasFinished);
    save(); broadcast('tournament', t.id);
    return send(res, 200, t);
  }

  // /api/tournaments/:id/disqualify   – Teilnehmer disqualifizieren bzw. zurücknehmen (Orga, Turnierleitung)
  // Offene Spiele des Disqualifizierten gehen kampflos an den Gegner, gespielte Ergebnisse bleiben.
  if (parts[2] === 'disqualify' && method === 'POST' && !parts[3]) {
    const me = actor(req, t);
    if (!me.manage) throw new HttpError(403, 'Nur Orga oder Turnierleitung');
    const body = await readBody(req);
    if (t.status !== 'running') throw new HttpError(400, 'Turnier läuft nicht');
    const idx = Number(body.index);
    if (!Number.isInteger(idx) || idx < 0 || idx >= t.participants.length) throw new HttpError(400, 'Unbekannter Teilnehmer');
    const before = Bracket.compute(t);
    const wasFinished = isFinished(t);
    const set = new Set(t.disqualified || []);
    if (body.on === false) set.delete(idx); else set.add(idx);
    t.disqualified = [...set].sort((x, y) => x - y);
    pruneStale(t);
    logMatch(t, null, `${t.participants[idx]} ${body.on === false ? 'nicht mehr disqualifiziert' : 'disqualifiziert'}`, me.name);
    tournamentDiscord.disqualified(t, { index: idx, on: body.on !== false, before, wasFinished });
    save(); broadcast('tournament', t.id);
    return send(res, 200, tournamentView());
  }

  // /api/tournaments/:id/draw-teams   – Teams aus Einzelanmeldungen auslosen (Entwurf, Orga)
  // body: { size, balanced } – balanced: nach Setzliste im Schlangenmuster verteilen, sonst zufällig
  if (parts[2] === 'draw-teams' && method === 'POST') {
    requireAdmin(req);
    const body = await readBody(req);
    if (t.status !== 'draft') throw new HttpError(400, 'Teams lassen sich nur im Entwurf auslosen');
    if ((t.teamSize || 1) > 1) throw new HttpError(400, 'Das Turnier hat schon Teams – auslosen geht aus Einzelanmeldungen');
    const size = clampInt(body.size, 2, 20, 2);
    const players = t.participants.slice();
    const count = Math.ceil(players.length / size);
    if (count < 2) throw new HttpError(400, `Für Teams à ${size} braucht es mindestens ${size + 1} Spieler`);
    if (!body.balanced) {
      for (let i = players.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [players[i], players[j]] = [players[j], players[i]]; }
    }
    const teams = Bracket.groupSplit(players, count); // Schlangenmuster: gleich große, ausgeglichene Teams
    const names = teams.map((list, i) => { const n = list.join(' & '); return n.length <= 60 ? n : `Team ${i + 1}`; });
    const bound = t.playerIds || {};
    t.members = Object.fromEntries(teams.map((list, i) => [names[i], list.map((p) => (Object.hasOwn(bound, p) ? bound[p] : null)).filter(Boolean)]));
    t.teamSize = size;
    t.participants = names;
    t.playerIds = {};
    Access.bindPlayers(db, t);
    logMatch(t, null, `${count} Teams à bis zu ${size} ausgelost${body.balanced ? ' (nach Setzliste)' : ''}`, 'Orga');
    tournamentDiscord.changed(t);
    save(); broadcast('tournament', t.id);
    return send(res, 200, t);
  }

  // /api/tournaments/:id/matches/:mid[/confirm|/dispute|/forfeit|/playing]
  if (parts[2] === 'matches' && parts[3] && parts.length <= 5) {
    // Methode und Zugang vor der Spielplanberechnung prüfen, damit anonyme oder unzulässige Anfragen
    // keine vollständige Berechnung auslösen.
    const action = parts[4] || '';
    if (!['', 'confirm', 'dispute', 'forfeit', 'playing'].includes(action)) throw new HttpError(404, 'Nicht gefunden');
    if (action ? method !== 'POST' : (method !== 'POST' && method !== 'DELETE')) throw new HttpError(405, 'Methode nicht erlaubt');
    const admin = isAdmin(req);
    const account = modules.accounts.current(req);
    const me = { admin, discordId: account ? account.id : null }; // Rechte prüft das Turniermodul
    if (!admin) { Security.rateLimit(req, 'result', 30, 60000); modules.accounts.requireUser(req); }
    if ((method === 'DELETE' || action === 'forfeit') && !tournaments.canManage(me, t)) throw new HttpError(401, 'Nur Orga oder Turnierleitung');
    // Erst den vollständigen Body abwarten, danach den aktuellen Zustand atomar prüfen/ändern.
    const body = method === 'POST' ? await readBody(req) : null;
    const ops = tournaments.of(modules.event.scoped());
    if (method === 'DELETE') ops.clearResult(me, t, parts[3]);
    else if (action === 'playing') ops.setPlaying(me, t, parts[3], body.on);
    else if (action === 'forfeit') ops.forfeit(me, t, parts[3], body.side);
    else if (action === 'confirm') ops.confirmResult(me, t, parts[3]);
    else if (action === 'dispute') ops.disputeResult(me, t, parts[3]);
    else ops.reportResult(me, t, parts[3], { a: body.a, b: body.b });
    return send(res, 200, tournamentView());
  }

  throw new HttpError(404, 'Nicht gefunden');
}

// ---------- Statische Dateien ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// Versionsnummer der Oberfläche, an Skripte und Stylesheets in index.html gehängt (?v=…): Ein Reverse
// Proxy kann JS/CSS trotz "no-cache" lange cachen lassen – nach einem Update laden Browser so sofort
// alle neuen Dateien statt einer Mischung aus alten und neuen.
const ASSET_VERSION = (() => {
  const h = crypto.createHash('sha256');
  for (const f of fs.readdirSync(PUBLIC_DIR, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name).sort()) {
    h.update(f).update(fs.readFileSync(path.join(PUBLIC_DIR, f)));
  }
  return h.digest('hex').slice(0, 10);
})();
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
  .replace(/((?:src|href)="\/[\w.-]+\.(?:js|css))"/g, `$1?v=${ASSET_VERSION}"`);
function sendIndex(res) {
  res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
  res.end(INDEX_HTML);
}

function serveStatic(req, res, url) {
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, 'Ungültige Adresse'); }
  if (p.includes('\0')) throw new HttpError(400, 'Ungültige Adresse');
  if (p === '/' || p === '/index.html') return sendIndex(res);
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) return sendIndex(res); // SPA-Fallback
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  Security.securityHeaders(req, res);
  try {
    const url = new URL(req.url, 'http://x');
    if (!Security.allowRequest(req, url.pathname)) throw new HttpError(403, 'Zugriff nur über den freigegebenen Reverse Proxy');
    // Jede API-Anfrage arbeitet auf einem Event (siehe lib/event.js)
    if (url.pathname.startsWith('/api/')) {
      // Bei abgelaufener Discord-Rollenbestätigung auf die begrenzte Wiederprüfung warten.
      const token = parseCookies(req).session;
      isAdmin(req);
      const session = sessions.get(token);
      if (session && session.checking) await session.checking;
      let ev = modules.event.forRequest(req, url, isAdmin(req));
      if (!ev && /^\/api\/(tickets|seats)(\/|$)/.test(url.pathname)) ev = ticketEvent();
      await modules.event.run(ev, () => api(req, res, url));
    }
    else serveStatic(req, res, url);
  } catch (err) {
    const known = err instanceof HttpError || (err.status >= 400 && err.status < 500);
    if (!known) console.error(err); // Details nur ins Log, nie an den Browser
    if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
    if (!res.headersSent) send(res, known ? err.status : 500, { error: known ? err.message : 'Serverfehler' });
  }
});
server.headersTimeout = 20000; // langsame Angreifer (Slowloris) abwehren
server.requestTimeout = 30000;

// ---------- Module ----------
const modules = {};
const ctx = {
  db, save, broadcast, send, readBody, requireAdmin, isAdmin, HttpError, str, settings, moduleOn, Discord, discordPost, discordQueue,
  parseCookies, baseUrl, security: Security, startAdminSession, ticketsAnywhere, userLoginNeeded: () => userLoginNeeded(),
  revokeAdminSessions: (discordId) => { for (const [token, session] of sessions) if (session.discordId === discordId) sessions.delete(token); },
  isMember: (req, e) => isMember(req, e), mayView, isMemberId,
  refreshCommands: () => refreshCommands(), eventModuleOn: (e, key) => moduleOnIn(eventModules(e), key),
  // Discord-Befehle: darf dieses Discord-Konto das Modul im aktuellen Event sehen?
  mayViewDiscord: (discordId, key) => { const e = modules.event.current(); return accessOf(e, key) === 'public' || isMemberId(discordId, e); },
  tournaments, tournamentDiscord,
};
ctx.event = modules.event = require('./lib/event.js')(ctx);
ctx.announcements = modules.announcements = require('./lib/announcements.js')(ctx);
ctx.schedule = modules.schedule = require('./lib/schedule.js')(ctx);
ctx.people = modules.people = require('./lib/people.js')(ctx);
modules.info = require('./lib/info.js')(ctx);
modules.details = require('./lib/details.js')(ctx);
modules.servers = require('./lib/servers.js')(ctx);
modules.cs2 = require('./lib/tmt.js')(ctx); // CS2-Matches über TMT2 (eigener Container)
ctx.accounts = modules.accounts = require('./lib/accounts.js')(ctx);
ctx.tickets = modules.tickets = require('./lib/tickets.js')(ctx);
ctx.seats = modules.seats = require('./lib/seats.js')(ctx);
ctx.catering = modules.catering = require('./lib/catering.js')(ctx);
modules.website = require('./lib/website.js')(ctx);
require('./lib/security-migration.js')(ctx);
if (!db.meta.matchIdentityVersion) {
  for (const e of modules.event.all()) for (const t of e.tournaments) Access.bindPlayers(db, t);
  db.meta.matchIdentityVersion = 1;
  save();
}
const gateway = require('./lib/gateway.js')(Discord, require('./lib/commands.js')(ctx));
// Slash-Befehle nach den Modulen des aktuellen Events – nie nach dem Event, das ein Admin gerade bearbeitet
const refreshCommands = () => modules.event.run(null, () => gateway.refresh());
save(); // normalisierte Startwerte einmal vollständig persistieren
gateway.start();

// Beim Start: Kanäle beendeter Turniere bzw. außerhalb des Events entfernen
tournamentDiscord.cleanup();

server.listen(PORT, HOST, () => {
  console.log(`LAN-System läuft auf http://${HOST}:${PORT}`);
  console.log(Discord.enabled ? 'Discord-Anbindung aktiv' : 'Discord-Anbindung aus (DISCORD_BOT_TOKEN / DISCORD_GUILD_ID nicht gesetzt)');
});

// Sauber beenden (z. B. bei "docker stop")
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    for (const res of clients) res.end();
    gateway.stop();
    server.close(() => { storage.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
