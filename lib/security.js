'use strict';
// Sicherheitsbausteine (OWASP): Header, Client-IP, Rate-Limits, CSRF-Schutz per Origin-Prüfung,
// Cookie-Optionen und ein minimiertes Sicherheitsprotokoll mit kurzlebigen Pseudonymen.
const net = require('node:net');
const crypto = require('node:crypto');

// Hinter einem Reverse Proxy (TRUST_PROXY=1) gelten X-Forwarded-For/-Proto. Ohne Proxy werden
// diese Header ignoriert, sonst könnte jeder seine IP fälschen und Rate-Limits umgehen.
const TRUST_PROXY = ['1', 'true', 'yes'].includes(String(process.env.TRUST_PROXY || '').toLowerCase());
const PROXY_ONLY = ['1', 'true', 'yes'].includes(String(process.env.PROXY_ONLY || '').toLowerCase());
const PUBLIC_HTTPS = (() => { try { return new URL(process.env.PUBLIC_URL || '').protocol === 'https:'; } catch { return false; } })();
const proxyList = new net.BlockList();
const proxyEntries = String(process.env.TRUSTED_PROXIES || '').split(',').map((s) => s.trim()).filter(Boolean);
for (const entry of proxyEntries) {
  const [address, prefix, ...rest] = entry.split('/');
  const version = net.isIP(address);
  if (!version || rest.length || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (version === 4 ? 32 : 128)))) {
    throw new Error('TRUSTED_PROXIES enthält eine ungültige IP/CIDR-Angabe');
  }
  const family = version === 4 ? 'ipv4' : 'ipv6';
  if (prefix === undefined) proxyList.addAddress(address, family);
  else proxyList.addSubnet(address, Number(prefix), family);
}
if (PROXY_ONLY && (!TRUST_PROXY || !proxyEntries.length)) throw new Error('PROXY_ONLY braucht TRUST_PROXY=1 und TRUSTED_PROXIES');
const peerIp = (req) => (req.socket.remoteAddress || '').replace(/^::ffff:/i, '');
function trustProxy(req) {
  const ip = peerIp(req), version = net.isIP(ip);
  return TRUST_PROXY && !!version && proxyList.check(ip, version === 4 ? 'ipv4' : 'ipv6');
}
function allowRequest(req, pathname) {
  if (!PROXY_ONLY || trustProxy(req)) return true;
  // Ausschließlich der interne Container-Healthcheck darf den Proxy umgehen.
  return req.method === 'GET' && pathname === '/api/health' && ['127.0.0.1', '::1'].includes(peerIp(req));
}

function clientIp(req) {
  if (trustProxy(req) && req.headers['x-forwarded-for']) {
    const hops = String(req.headers['x-forwarded-for']).split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length && net.isIP(hops[hops.length - 1])) return hops[hops.length - 1]; // vom eigenen Proxy angehängt
  }
  return peerIp(req);
}

const isHttps = (req) => !!req.socket.encrypted
  || (trustProxy(req) && (PUBLIC_HTTPS || String(req.headers['x-forwarded-proto'] || '').trim() === 'https'));

// Set-Cookie-Wert; hinter HTTPS immer mit "Secure"
function cookie(req, name, value, { maxAge, sameSite = 'Lax', path = '/' } = {}) {
  return `${name}=${value}; HttpOnly; SameSite=${sameSite}; Path=${path}; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}

// ---------- Header ----------
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // Positionen/Farben werden als style-Attribute gesetzt
  "img-src 'self' data: https://cdn.discordapp.com",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(req, res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

// ---------- Rate-Limits (gleitendes Fenster je IP und Zweck) ----------
const buckets = new Map(); // "zweck|ip" -> [Zeitstempel]
function rateLimit(req, purpose, limit, windowMs) {
  const key = `${purpose}|${clientIp(req)}`;
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    log('rate_limited', req, { purpose });
    const err = new Error('Zu viele Anfragen – bitte kurz warten und erneut versuchen');
    err.status = 429;
    err.retryAfter = Math.ceil((windowMs - (now - hits[0])) / 1000);
    throw err;
  }
  hits.push(now);
  buckets.set(key, hits);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, hits] of buckets) if (!hits.length || now - hits[hits.length - 1] > 3600e3) buckets.delete(k);
}, 600e3).unref();

// ---------- CSRF-Schutz (zusätzlich zu SameSite-Cookies) ----------
// Ändernde Anfragen nur von der eigenen Seite: Origin muss passen, Sec-Fetch-Site darf nicht cross-site sein.
function sameOrigin(req, allowedOrigins) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (!origin) return true; // z. B. curl/Skripte – ohne Browser keine mitgeschickten Fremd-Cookies
  return allowedOrigins.includes(origin);
}

// Kurzlebige, pro Prozess wechselnde Pseudonyme; keine Roh-IPs, Discord-IDs oder Freitexte.
const logKey = crypto.randomBytes(32);
const pseudonym = (value) => crypto.createHmac('sha256', logKey).update(String(value)).digest('hex').slice(0, 24);
function log(event, req, extra = {}) {
  const data = { t: new Date().toISOString(), sec: event, source: req ? pseudonym(clientIp(req)) : undefined };
  if (extra.account || extra.discordId) data.actor = pseudonym(extra.account || extra.discordId);
  for (const key of ['purpose', 'reason', 'via']) if (typeof extra[key] === 'string') data[key] = extra[key].slice(0, 80);
  if (Number.isSafeInteger(extra.moves) && extra.moves >= 0) data.moves = extra.moves;
  console.log(JSON.stringify(data));
}

module.exports = { TRUST_PROXY, PROXY_ONLY, trustProxy, allowRequest, clientIp, isHttps, cookie, securityHeaders, rateLimit, sameOrigin, log };
