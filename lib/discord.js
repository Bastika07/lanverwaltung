'use strict';
// Discord-Anbindung (REST): Voice-Kanäle pro Turnier und Nachrichten im Ansagekanal.
// Benötigt einen Bot mit "Kanäle verwalten", "Kanäle ansehen" und "Nachrichten senden".
// Konfiguration: DISCORD_BOT_TOKEN (oder DISCORD_BOT_TOKEN_FILE) und DISCORD_GUILD_ID.

const fs = require('fs');

const API = process.env.DISCORD_API_BASE || 'https://discord.com/api/v10';
let TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!TOKEN && process.env.DISCORD_BOT_TOKEN_FILE) TOKEN = fs.readFileSync(process.env.DISCORD_BOT_TOKEN_FILE, 'utf8').trim();
const GUILD = process.env.DISCORD_GUILD_ID;
// Zwei Textkanäle für Ansagen: allgemein (Durchsagen, Programm) und Turniere.
// Jeweils feste ID oder automatisch angelegter Kanal mit diesem Namen.
// (ANNOUNCE_CHANNEL_ID: Name aus dem früheren dmx-announce-bot, weiterhin unterstützt)
const env = process.env;
const ANNOUNCE = {
  general: {
    id: env.DISCORD_ANNOUNCE_CHANNEL_ID || env.ANNOUNCE_CHANNEL_ID,
    name: env.DISCORD_ANNOUNCE_CHANNEL_NAME || 'lan-ansagen',
    topic: 'Durchsagen und Programm',
    metaKey: 'announceChannelId',
  },
  tournaments: {
    id: env.DISCORD_TOURNAMENT_CHANNEL_ID,
    name: env.DISCORD_TOURNAMENT_CHANNEL_NAME || 'turnier-ansagen',
    topic: 'Turnierstarts, Ergebnisse, nächste Spiele und Sieger',
    metaKey: 'tournamentChannelId',
  },
};

const enabled = !!(TOKEN && GUILD);
const MAX_PER_CATEGORY = 50; // Discord-Limit für Kanäle in einer Kategorie
const TYPE_TEXT = 0, TYPE_VOICE = 2, TYPE_CATEGORY = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bot ${TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'DiscordBot (lan-system, 1.0)',
        'X-Audit-Log-Reason': 'LAN-System',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 429) { // Rate-Limit: warten und erneut versuchen
      const d = await res.json().catch(() => ({}));
      await sleep(Math.min(Math.max(Number(d.retry_after) || 1, 0), 10) * 1000);
      continue;
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(`Discord ${res.status}: ${(data && data.message) || res.statusText}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  throw new Error('Discord: zu viele Anfragen, bitte später erneut synchronisieren');
}

const chName = (s) => String(s).slice(0, 100);
// Teilnehmernamen sind frei wählbar (auch „__proto__“ oder „constructor“): nur eigene Eigenschaften lesen/schreiben.
const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);
const put = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

async function deleteChannel(id) {
  try { await call('DELETE', `/channels/${id}`); }
  catch (e) { if (e.status !== 404) throw e; } // schon weg -> egal
}

// Gleicht Discord mit dem Turnier ab. renames: { alterName: neuerName } (bei Umbenennungen,
// damit Kanäle umbenannt statt neu angelegt werden). Ändert t.discord.
async function sync(t, renames = {}) {
  if (t.discordEnabled === false) return remove(t);
  if (t.participants.length > MAX_PER_CATEGORY)
    throw new Error(`Discord erlaubt höchstens ${MAX_PER_CATEGORY} Kanäle pro Kategorie`);

  const d = t.discord || (t.discord = { categoryId: null, channels: {} });
  const existing = new Map((await call('GET', `/guilds/${GUILD}/channels`)).map((c) => [c.id, c]));

  // Kategorie
  const cat = d.categoryId && existing.get(d.categoryId);
  if (!cat) {
    d.categoryId = (await call('POST', `/guilds/${GUILD}/channels`, { name: chName(t.name), type: TYPE_CATEGORY })).id;
  } else if (cat.name !== chName(t.name)) {
    await call('PATCH', `/channels/${d.categoryId}`, { name: chName(t.name) });
  }

  // Umbenennungen übernehmen
  for (const [from, to] of Object.entries(renames)) {
    if (own(d.channels, from) && !own(d.channels, to)) { put(d.channels, to, own(d.channels, from)); delete d.channels[from]; }
  }

  // Kanäle entfernen, die es nicht mehr gibt bzw. deren Teilnehmer weg ist
  for (const [name, id] of Object.entries(d.channels)) {
    if (!existing.has(id)) { delete d.channels[name]; continue; }
    if (!t.participants.includes(name)) { await deleteChannel(id); delete d.channels[name]; }
  }

  // Fehlende anlegen, vorhandene korrigieren (Name, Kategorie)
  for (const name of t.participants) {
    const id = own(d.channels, name);
    const ch = id && existing.get(id);
    if (!ch) {
      put(d.channels, name, (await call('POST', `/guilds/${GUILD}/channels`, {
        name: chName(name), type: TYPE_VOICE, parent_id: d.categoryId,
      })).id);
    } else if (ch.name !== chName(name) || ch.parent_id !== d.categoryId) {
      await call('PATCH', `/channels/${id}`, { name: chName(name), parent_id: d.categoryId });
    }
  }
}

// Entfernt alle Kanäle und die Kategorie eines Turniers.
async function remove(t) {
  const d = t.discord;
  if (!d) return;
  for (const id of Object.values(d.channels || {})) await deleteChannel(id);
  if (d.categoryId) await deleteChannel(d.categoryId);
  t.discord = null;
}

// ---------- Ansagen ----------

// ---------- Event-Kanäle ----------
// Während des Events gibt es eine Kategorie "🎮 <LAN-Name>" mit beiden Ansagekanälen.
// meta (persistiert) merkt sich, was der Bot angelegt hat – nur das wird beim Abbau gelöscht.
// Fest per ID vorgegebene Kanäle werden weder angelegt noch gelöscht.
const categoryName = (eventName) => chName(`🎮 ${eventName}`);

async function setupEvent(meta, eventName) {
  const channels = new Map((await call('GET', `/guilds/${GUILD}/channels`)).map((c) => [c.id, c]));
  // Ältere Versionen hatten nur einen Kanal: steckt der Turnierkanal unter "allgemein", umhängen
  const legacy = meta.announceChannelId && channels.get(meta.announceChannelId);
  if (legacy && legacy.name === ANNOUNCE.tournaments.name && !meta.tournamentChannelId && !ANNOUNCE.tournaments.id) {
    meta.tournamentChannelId = legacy.id;
    meta.announceChannelId = null;
  }
  const cat = meta.eventCategoryId && channels.get(meta.eventCategoryId);
  if (!cat) {
    meta.eventCategoryId = (await call('POST', `/guilds/${GUILD}/channels`, { name: categoryName(eventName), type: TYPE_CATEGORY })).id;
  } else if (cat.name !== categoryName(eventName)) {
    await call('PATCH', `/channels/${cat.id}`, { name: categoryName(eventName) });
  }
  for (const cfg of Object.values(ANNOUNCE)) {
    if (cfg.id) continue;
    const ch = meta[cfg.metaKey] && channels.get(meta[cfg.metaKey]);
    if (!ch) {
      meta[cfg.metaKey] = (await call('POST', `/guilds/${GUILD}/channels`, {
        name: cfg.name, type: TYPE_TEXT, topic: cfg.topic, parent_id: meta.eventCategoryId,
      })).id;
    } else if (ch.parent_id !== meta.eventCategoryId || ch.name !== cfg.name) {
      await call('PATCH', `/channels/${ch.id}`, { name: cfg.name, topic: cfg.topic, parent_id: meta.eventCategoryId });
    }
  }
}

async function teardownEvent(meta) {
  for (const cfg of Object.values(ANNOUNCE)) {
    if (cfg.id || !meta[cfg.metaKey]) continue;
    await deleteChannel(meta[cfg.metaKey]);
    meta[cfg.metaKey] = null;
  }
  if (meta.eventCategoryId) await deleteChannel(meta.eventCategoryId);
  meta.eventCategoryId = null;
}

// Liefert die ID des Ansage-Kanals (kind: 'general' | 'tournaments'); legt fehlende Event-Kanäle an.
async function announceChannel(meta, kind, eventName) {
  const cfg = ANNOUNCE[kind] || ANNOUNCE.general;
  if (cfg.id) return cfg.id;
  if (!meta[cfg.metaKey] || !meta.eventCategoryId) await setupEvent(meta, eventName);
  return meta[cfg.metaKey];
}

// Markdown-Sonderzeichen in Namen entschärfen (z. B. "Blue_Balls")
const md = (s) => String(s).replace(/([\\*_~`|>#\[\]()-])/g, '\\$1');

// Sendet eine Nachricht; lange Texte werden an Zeilenumbrüchen aufgeteilt (Limit 2000 Zeichen).
// users: Discord-IDs, die erwähnt (angepingt) werden dürfen. Alles andere – auch <@…> aus
// Nutzereingaben – pingt niemanden (@everyone/@here/Rollen sind immer aus).
async function post(channelId, text, users = []) {
  const chunks = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && (cur + '\n' + line).length > 1900) { chunks.push(cur); cur = line; }
    else cur = cur ? cur + '\n' + line : line;
  }
  if (cur) chunks.push(cur);
  for (const content of chunks) {
    const ping = [...new Set(users)].filter((id) => /^\d+$/.test(id) && content.includes(`<@${id}>`)).slice(0, 100);
    await call('POST', `/channels/${channelId}/messages`, { content, allowed_mentions: { parse: [], users: ping } });
  }
}

module.exports = { enabled, call, sync, remove, announceChannel, setupEvent, teardownEvent, post, md, TOKEN, GUILD, MAX_PER_CATEGORY };
