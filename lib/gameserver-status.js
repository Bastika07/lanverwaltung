'use strict';
// Gameserver-Status (Infos und Beamer): Der LAN-Client (agent/tmt2-agent.js) fragt die Gameserver per Steam-A2S ab
// und meldet das Ergebnis; die LAN-Verwaltung selbst schickt nie UDP ins Netz. Der Stand liegt nur im Speicher,
// Lesepfade lösen keine Abfrage aus. Nur Anzahl der Spieler, keine Namen (personenbezogen).

const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i; // IPv4 oder Hostname, wie der LAN-Client per udp4 abfragt
const MAX_TARGETS = 30;
const FRESH_MS = 60000; // der LAN-Client meldet alle paar Sekunden; älter gilt als nicht erreichbar

// Text vom Gameserver: Steuerzeichen entfernen, Länge begrenzen (HTML maskiert erst die Ausgabe)
const text = (v) => (typeof v === 'string' ? v.replace(/[\p{C}]/gu, '').trim().slice(0, 64) : '');
const count = (v) => (Number.isInteger(v) ? Math.min(Math.max(v, 0), 255) : 0); // A2S: ein Byte

// Host eines Eintrags aus seiner Adresse („192.0.2.27:7777“ oder „cs.lan“); ungültig: null
function hostOf(address) {
  const host = String(address || '').trim().replace(/:\d{1,5}$/, '');
  return HOST.test(host) ? host.toLowerCase() : null;
}
const keyOf = (host, port) => `${host}:${port}`;

// deps: servers() (Gameserver-Einträge des aktuellen Events aus Infos), now()
module.exports = function gameserverStatus({ servers, now = Date.now }) {
  const results = new Map(); // "host:port" -> { at, online, … }

  function target(s) {
    const port = s && s.queryPort;
    const host = Number.isInteger(port) && port >= 1 && port <= 65535 ? hostOf(s.address) : null;
    return host ? { host, port } : null;
  }

  // Abzufragende Server für den LAN-Client
  function targets() {
    const seen = new Set();
    const out = [];
    for (const s of servers() || []) {
      const t = target(s);
      if (!t || seen.has(keyOf(t.host, t.port))) continue;
      seen.add(keyOf(t.host, t.port));
      out.push(t);
      if (out.length >= MAX_TARGETS) break;
    }
    return out;
  }

  // Ergebnisse des LAN-Clients übernehmen: nur für angefragte Server und nur bekannte Felder
  function apply(list) {
    if (!Array.isArray(list)) return;
    const wanted = new Set(targets().map((t) => keyOf(t.host, t.port)));
    for (const k of results.keys()) if (!wanted.has(k)) results.delete(k); // Eintrag entfernt oder geändert
    for (const r of list.slice(0, MAX_TARGETS)) {
      if (!r || typeof r.host !== 'string' || !Number.isInteger(r.port) || !wanted.has(keyOf(r.host, r.port))) continue;
      const info = r.ok === true && r.info && typeof r.info === 'object' ? r.info : null;
      results.set(keyOf(r.host, r.port), info
        ? { at: now(), online: true, name: text(info.name), map: text(info.map), players: Math.max(count(info.players) - count(info.bots), 0),
          slots: count(info.maxPlayers), password: info.password === true }
        : { at: now(), online: false });
    }
  }

  // Stand eines Eintrags für Infos und Beamer; null ohne Query-Port
  function statusOf(s) {
    const t = target(s);
    if (!t) return null;
    const r = results.get(keyOf(t.host, t.port));
    if (!r || !r.online || now() - r.at > FRESH_MS) return { online: false };
    const { at, ...shown } = r;
    return shown;
  }

  return { targets, apply, statusOf };
};
