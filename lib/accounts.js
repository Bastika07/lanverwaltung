'use strict';
// Besucher-Konten: Anmeldung mit Discord (OAuth2 "authorization code"), Sitzungen und Profil
// mit Anschrift für die Ticketverwaltung. Persönliche Daten sieht nur der Admin und das Konto selbst.
// Derselbe Discord-Login dient auch als Admin-Anmeldung (/api/auth/login?admin=1): Admin ist, wer auf
// dem Discord-Server die eingestellte Rolle hat, Inhaber ist oder eine Rolle mit Administrator-Recht hat.
// Konfiguration: DISCORD_CLIENT_SECRET (oder _FILE); Client-ID kommt aus dem Bot-Token
// (oder DISCORD_CLIENT_ID). Im Discord Developer Portal muss <Adresse>/api/auth/callback als
// Redirect eingetragen sein.

const crypto = require('crypto');
const fs = require('fs');

const env = process.env;
const DISCORD = env.DISCORD_OAUTH_BASE || 'https://discord.com'; // umstellbar für Tests
const SESSION_DAYS = 30;

module.exports = function accounts(ctx) {
  const { db, save, broadcast, send, readBody, requireAdmin, HttpError, str, Discord, parseCookies, baseUrl, security: Sec } = ctx;
  db.accounts = db.accounts || [];
  db.userSessions = db.userSessions || {}; // sha256(token) -> { uid, exp }

  let SECRET = env.DISCORD_CLIENT_SECRET;
  if (!SECRET && env.DISCORD_CLIENT_SECRET_FILE) SECRET = fs.readFileSync(env.DISCORD_CLIENT_SECRET_FILE, 'utf8').trim();
  let clientId = env.DISCORD_CLIENT_ID || null;
  const states = new Map(); // state -> { exp, admin } (Schutz gegen untergeschobene Logins; admin = Admin-Anmeldung)

  const enabled = () => !!(SECRET && (clientId || Discord.enabled));
  const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
  const redirectUri = (req) => `${baseUrl(req)}/api/auth/callback`;

  async function getClientId() {
    if (!clientId && Discord.enabled) clientId = (await Discord.call('GET', '/oauth2/applications/@me')).id;
    return clientId;
  }

  function current(req) {
    const tok = parseCookies(req).lan_user;
    const s = tok && db.userSessions[hash(tok)];
    if (!s || s.exp < Date.now()) return null;
    return db.accounts.find((a) => a.id === s.uid) || null;
  }

  function requireUser(req) {
    const a = current(req);
    if (!a) throw new HttpError(401, 'Bitte zuerst mit Discord anmelden');
    return a;
  }

  // ---------- Profil ----------
  const FIELDS = {
    firstName: { label: 'Vorname', max: 60 },
    lastName: { label: 'Nachname', max: 60 },
    street: { label: 'Straße und Hausnummer', max: 120 },
    zip: { label: 'PLZ', max: 10 },
    city: { label: 'Ort', max: 80 },
    email: { label: 'E-Mail', max: 120 },
    birthdate: { label: 'Geburtsdatum', max: 10 },
  };

  function age(birthdate, at = Date.now()) {
    const b = new Date(birthdate + 'T00:00:00');
    const d = new Date(at);
    let years = d.getFullYear() - b.getFullYear();
    if (d.getMonth() < b.getMonth() || (d.getMonth() === b.getMonth() && d.getDate() < b.getDate())) years--;
    return years;
  }

  function cleanProfile(body) {
    const p = {};
    for (const [k, f] of Object.entries(FIELDS)) {
      p[k] = str(body[k], f.max);
      if (!p[k]) throw new HttpError(400, `${f.label} fehlt`);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) throw new HttpError(400, 'Bitte eine gültige E-Mail-Adresse angeben');
    if (!/^\d{4,5}$/.test(p.zip)) throw new HttpError(400, 'Bitte eine gültige PLZ angeben');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.birthdate) || Number.isNaN(Date.parse(p.birthdate))) throw new HttpError(400, 'Bitte ein gültiges Geburtsdatum angeben');
    const years = age(p.birthdate);
    if (years < 0 || years > 120) throw new HttpError(400, 'Bitte ein gültiges Geburtsdatum angeben');
    return p;
  }

  const complete = (a) => !!(a && a.profile && a.consentAt);
  const avatarUrl = (a) => (a.avatar ? `https://cdn.discordapp.com/avatars/${a.id}/${a.avatar}.png?size=64` : null);
  const view = (a) => ({ id: a.id, name: a.discordName, username: a.username, avatar: avatarUrl(a), profile: a.profile, consentAt: a.consentAt, complete: complete(a) });

  // ---------- Sitzungen ----------
  function login(req, res, account) {
    const tok = crypto.randomBytes(32).toString('hex');
    db.userSessions[hash(tok)] = { uid: account.id, exp: Date.now() + SESSION_DAYS * 864e5 };
    res.setHeader('Set-Cookie', [
      Sec.cookie(req, 'lan_user', tok, { maxAge: SESSION_DAYS * 86400 }),
      Sec.cookie(req, 'lan_state', '', { maxAge: 0, path: '/api/auth' }),
    ]);
  }
  setInterval(() => {
    let n = 0;
    for (const [k, s] of Object.entries(db.userSessions)) if (s.exp < Date.now()) { delete db.userSessions[k]; n++; }
    if (n) save();
  }, 3600e3).unref();

  const redirect = (res, to) => { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }); res.end(); };

  async function exchange(req, code) {
    const body = new URLSearchParams({
      client_id: await getClientId(), client_secret: SECRET, grant_type: 'authorization_code', code, redirect_uri: redirectUri(req),
    });
    const tr = await fetch(`${DISCORD}/api/oauth2/token`, { method: 'POST', body, signal: AbortSignal.timeout(10000) });
    const tok = await tr.json().catch(() => ({}));
    if (!tr.ok) throw new Error(tok.error_description || tok.error || `Token-Fehler ${tr.status}`);
    const ur = await fetch(`${DISCORD}/api/v10/users/@me`, { headers: { Authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(10000) });
    if (!ur.ok) throw new Error(`Discord-Benutzer konnte nicht gelesen werden (${ur.status})`);
    return ur.json();
  }

  // Darf dieses Discord-Konto in den Admin-Bereich? (prüft der Bot über die Rollen auf dem Server)
  async function isDiscordAdmin(userId) {
    if (!Discord.enabled) return false;
    let member;
    try { member = await Discord.call('GET', `/guilds/${Discord.GUILD}/members/${userId}`); }
    catch (err) { if (err.status === 404) return false; throw err; }
    const [guild, roles] = await Promise.all([Discord.call('GET', `/guilds/${Discord.GUILD}`), Discord.call('GET', `/guilds/${Discord.GUILD}/roles`)]);
    if (guild.owner_id === userId) return true;
    const want = String(ctx.settings().adminRole || '').trim().toLowerCase();
    return roles.filter((r) => member.roles.includes(r.id))
      .some((r) => (BigInt(r.permissions || '0') & 0x8n) || (want && (r.name.toLowerCase() === want || r.id === want)));
  }

  // Nur Mitglieder des Discord-Servers? (prüft der Bot, keine zusätzliche Berechtigung beim Login nötig)
  async function isMember(userId) {
    if (!Discord.enabled) return true;
    try { await Discord.call('GET', `/guilds/${Discord.GUILD}/members/${userId}`); return true; }
    catch (err) { if (err.status === 404) return false; throw err; }
  }

  async function routes(req, res, parts, method) {
    // Die Admin-Anmeldung geht immer; die Besucher-Anmeldung nur, wenn es Tickets oder eingeschränkte Module gibt
    const adminFlow = parts[0] === 'auth' && (parts[1] === 'callback' || (parts[1] === 'login' && new URL(req.url, 'http://x').searchParams.get('admin') === '1'));
    if (!adminFlow && parts[0] !== 'account' && !ctx.isAdmin(req) && !ctx.userLoginNeeded()) return false;

    if (parts[0] === 'auth') {
      if (parts[1] === 'login' && method === 'GET') {
        Sec.rateLimit(req, 'oauth', 30, 10 * 60000);
        if (!enabled()) throw new HttpError(400, 'Der Discord-Login ist noch nicht eingerichtet');
        if (adminFlow && !Discord.enabled) throw new HttpError(400, 'Für die Admin-Anmeldung mit Discord braucht es den Bot (DISCORD_BOT_TOKEN, DISCORD_GUILD_ID)');
        const state = crypto.randomBytes(16).toString('hex');
        states.set(state, { exp: Date.now() + 10 * 60000, admin: adminFlow });
        for (const [k, st] of states) if (st.exp < Date.now()) states.delete(k);
        const q = new URLSearchParams({
          client_id: await getClientId(), response_type: 'code', redirect_uri: redirectUri(req), scope: 'identify email', state, prompt: 'none',
        });
        res.setHeader('Set-Cookie', Sec.cookie(req, 'lan_state', state, { maxAge: 600, path: '/api/auth' }));
        redirect(res, `${DISCORD}/oauth2/authorize?${q}`);
        return true;
      }
      if (parts[1] === 'callback' && method === 'GET') {
        Sec.rateLimit(req, 'oauth', 30, 10 * 60000);
        const url = new URL(req.url, 'http://x');
        const state = url.searchParams.get('state');
        const purpose = states.get(state) || {};
        const page = purpose.admin ? 'admin' : 'tickets';
        const back = (msg) => redirect(res, `/#/${page}${msg ? '?hinweis=' + encodeURIComponent(msg) : ''}`);
        if (url.searchParams.get('error')) { back('Anmeldung abgebrochen'); return true; }
        if (!state || parseCookies(req).lan_state !== state || !states.has(state) || purpose.exp < Date.now()) {
          Sec.log('oauth_state_mismatch', req);
          back('Anmeldung abgelaufen – bitte erneut versuchen');
          return true;
        }
        if (!/^[\w-]{1,200}$/.test(url.searchParams.get('code') || '')) { back('Anmeldung bei Discord fehlgeschlagen'); return true; }
        states.delete(state);
        let user;
        try { user = await exchange(req, url.searchParams.get('code')); }
        catch (err) { console.error('Discord-Login:', err.message); back('Anmeldung bei Discord fehlgeschlagen'); return true; }

        if (purpose.admin) {
          let ok;
          try { ok = await isDiscordAdmin(user.id); }
          catch (err) { console.error('Admin-Rolle prüfen:', err.message); back('Discord-Rollen konnten nicht geprüft werden – bitte später erneut versuchen'); return true; }
          if (!ok) {
            Sec.log('admin_login_denied', req, { discordId: user.id });
            back(`Kein Zugang: Dein Discord-Konto (${user.username}) hat nicht die Admin-Rolle`);
            return true;
          }
          res.setHeader('Set-Cookie', [ctx.startAdminSession(req, res, user), Sec.cookie(req, 'lan_state', '', { maxAge: 0, path: '/api/auth' })]);
          Sec.log('admin_login', req, { via: 'discord', discordId: user.id, name: user.username });
          redirect(res, '/#/admin');
          return true;
        }
        if (!ctx.userLoginNeeded()) { back('Die Anmeldung ist gerade nicht nötig'); return true; }
        if (ctx.tickets.settings().requireMember && !(await isMember(user.id))) {
          Sec.log('user_login_denied', req, { reason: 'not_member' });
          back('Nur für Mitglieder unseres Discord-Servers');
          return true;
        }

        let a = db.accounts.find((x) => x.id === user.id);
        if (!a) {
          a = { id: user.id, createdAt: new Date().toISOString(), profile: null, consentAt: null };
          db.accounts.push(a);
        }
        Object.assign(a, {
          discordName: user.global_name || user.username, username: user.username, avatar: user.avatar || null,
          discordEmail: user.verified ? user.email || null : null, lastLogin: new Date().toISOString(),
        });
        login(req, res, a);
        Sec.log('user_login', req, { account: a.id });
        save(); broadcast('accounts');
        redirect(res, ctx.ticketsAnywhere() ? '/#/tickets' : '/#/'); // ohne Tickets: zurück zur Startseite
        return true;
      }
      if (parts[1] === 'logout' && method === 'POST') {
        const tok = parseCookies(req).lan_user;
        if (tok) delete db.userSessions[hash(tok)];
        save();
        res.setHeader('Set-Cookie', Sec.cookie(req, 'lan_user', '', { maxAge: 0 }));
        send(res, 200, { ok: true });
        return true;
      }
      return false;
    }

    if (parts[0] === 'account' && parts.length === 1) {
      if (method === 'GET') {
        const a = current(req);
        send(res, 200, { loginEnabled: enabled(), account: a ? { ...view(a), discordEmail: a.discordEmail } : null });
        return true;
      }
      const a = requireUser(req);
      if (method === 'PUT') {
        Sec.rateLimit(req, 'profile', 20, 10 * 60000);
        const b = await readBody(req);
        requireUser(req);
        if (!b.consent) throw new HttpError(400, 'Bitte stimme dem Datenschutzhinweis zu');
        const p = cleanProfile(b);
        a.profile = p;
        a.consentAt = a.consentAt || new Date().toISOString();
        save(); broadcast('accounts');
        send(res, 200, view(a));
        return true;
      }
      if (method === 'DELETE') {
        require('./privacy.js')(ctx, a);
        save();
        for (const type of ['accounts', 'people', 'tickets', 'servers', 'tournament']) broadcast(type);
        Sec.log('account_deleted', req);
        res.setHeader('Set-Cookie', Sec.cookie(req, 'lan_user', '', { maxAge: 0 }));
        send(res, 200, { ok: true });
        return true;
      }
      return false;
    }

    // Admin: alle Konten mit Profil
    if (parts[0] === 'accounts' && method === 'GET') {
      requireAdmin(req);
      send(res, 200, {
        loginEnabled: enabled(), redirectUri: redirectUri(req), hasSecret: !!SECRET,
        accounts: db.accounts.map((a) => ({ ...view(a), createdAt: a.createdAt, lastLogin: a.lastLogin, age: a.profile ? age(a.profile.birthdate) : null })),
      });
      return true;
    }
    return false;
  }

  return {
    routes, alwaysOn: true, current, requireUser, complete, enabled, age, isDiscordAdmin, // Modul-Prüfung macht routes() selbst
    find: (id) => db.accounts.find((a) => a.id === id) || null,
  };
};
