#!/usr/bin/env node
'use strict';
// LAN-Board: Statusanzeige der Gameserver im Terminal, im Stil von btop. Läuft im LAN (z. B. auf dem AMP-Manager).
// Spielstand per Steam-Abfrage (A2S_INFO über UDP, ohne Zugangsdaten), Ressourcen der Container über die
// Proxmox-API mit einem Nur-Lese-Token. Nur Node-Bordmittel. Einrichtung: docs/lan-board.md
//   node agent/lan-board.js [--config /etc/lan-board.json] [--once]
// Tasten: q beenden, r sofort neu abfragen.

const dgram = require('node:dgram');
const fs = require('node:fs');
const https = require('node:https');

// ---------- Steam-Abfrage (A2S_INFO) ----------
const A2S_REQUEST = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]), Buffer.from('Source Engine Query\0', 'latin1')]);

// Antworttext stammt vom Gameserver: Steuerzeichen (auch ESC-Sequenzen, die das Terminal umbauen könnten) entfernen
const clean = (s, max = 64) => String(s ?? '').replace(/[\p{C}]/gu, '').trim().slice(0, max);

function parseInfo(buf) {
  let o = 0;
  const need = (n) => { if (o + n > buf.length) throw new Error('Antwort zu kurz'); };
  const u8 = () => { need(1); return buf[o++]; };
  const u16 = () => { need(2); const v = buf.readUInt16LE(o); o += 2; return v; };
  const str = () => {
    const end = buf.indexOf(0, o);
    if (end < 0) throw new Error('Antwort zu kurz');
    const s = buf.toString('utf8', o, end); o = end + 1; return clean(s);
  };
  need(5);
  if (buf.readInt32LE(0) !== -1 || buf[4] !== 0x49) throw new Error('keine A2S_INFO-Antwort');
  o = 5;
  const info = { protocol: u8(), name: str(), map: str(), folder: str(), game: str(), appId: u16() };
  Object.assign(info, { players: u8(), maxPlayers: u8(), bots: u8() });
  info.type = String.fromCharCode(u8()); info.env = String.fromCharCode(u8());
  info.password = u8() === 1; info.vac = u8() === 1;
  info.version = str();
  return info;
}

// Ergebnis: { ok: true, ping, info } oder { ok: false, error }. Wirft nie.
function queryInfo(host, port, { timeout = 1500 } = {}) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let sent = 0, done = false, challenges = 0;
    const finish = (result) => { if (done) return; done = true; clearTimeout(timer); sock.close(); resolve(result); };
    const send = (payload) => { sent = performance.now(); sock.send(payload, (err) => err && finish({ ok: false, error: err.code || 'Sendefehler' })); };
    const timer = setTimeout(() => finish({ ok: false, error: 'keine Antwort' }), timeout);
    sock.on('error', (err) => finish({ ok: false, error: err.code || 'Fehler' }));
    sock.on('message', (msg) => {
      const ping = Math.round(performance.now() - sent);
      // Challenge (seit 2020 Pflicht bei Source-Servern): Anfrage mit den 4 Bytes wiederholen
      if (msg.length === 9 && msg.readInt32LE(0) === -1 && msg[4] === 0x41 && challenges++ < 2) {
        return send(Buffer.concat([A2S_REQUEST, msg.subarray(5, 9)]));
      }
      try { finish({ ok: true, ping, info: parseInfo(msg) }); } catch (err) { finish({ ok: false, error: err.message }); }
    });
    // connect(): nur Antworten genau dieses Servers annehmen
    sock.connect(port, host, (err) => (err ? finish({ ok: false, error: err.code || 'Verbindungsfehler' }) : send(A2S_REQUEST)));
  });
}

// ---------- Proxmox ----------
function fetchProxmox(pve, { timeout = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api2/json/cluster/resources', pve.url);
    if (url.protocol !== 'https:') return reject(new Error('Proxmox-URL muss mit https:// beginnen'));
    const req = https.get(url, {
      headers: { Authorization: `PVEAPIToken=${pve.tokenId}=${pve.secret}` }, ca: pve.ca, timeout,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; if (body.length > 2e6) req.destroy(new Error('Antwort zu groß')); });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Proxmox antwortet ${res.statusCode}`));
        try { resolve(JSON.parse(body).data || []); } catch { reject(new Error('Proxmox-Antwort unlesbar')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Proxmox antwortet nicht')));
    req.on('error', reject);
  });
}

// Werte je Container und Host; Netz-Raten aus der Differenz zum letzten geänderten Stand (Proxmox aktualisiert ca. alle 10 s)
function mergeProxmox(resources, prev = {}, now = Date.now()) {
  const guests = {}, nodes = [];
  for (const r of resources) {
    if (r.type === 'node') nodes.push({ name: clean(r.node), status: r.status, cpu: r.cpu || 0, mem: r.mem || 0, maxmem: r.maxmem || 0, uptime: r.uptime || 0 });
    if (r.type !== 'lxc' && r.type !== 'qemu') continue;
    const p = prev[r.vmid];
    const g = { vmid: r.vmid, name: clean(r.name), status: r.status, cpu: r.cpu || 0, cpus: r.maxcpu || 0, mem: r.mem || 0, maxmem: r.maxmem || 0,
      uptime: r.uptime || 0, netin: r.netin || 0, netout: r.netout || 0, t: now, rxRate: p?.rxRate ?? null, txRate: p?.txRate ?? null };
    if (p && (g.netin !== p.netin || g.netout !== p.netout) && now > p.t) {
      g.rxRate = Math.max(0, (g.netin - p.netin) / ((now - p.t) / 1000));
      g.txRate = Math.max(0, (g.netout - p.netout) / ((now - p.t) / 1000));
    } else if (p) g.t = p.t; // unverändert: Bezugszeitpunkt behalten
    guests[r.vmid] = g;
  }
  return { guests, nodes };
}

// ---------- Darstellung ----------
const ESC = '\x1b[';
const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const GRADIENT = [46, 82, 118, 154, 190, 226, 220, 214, 208, 202, 196];

function painter(color) {
  const fg = (n) => (s) => (color ? `${ESC}38;5;${n}m${s}${ESC}0m` : s);
  return { fg, dim: fg(242), label: fg(110), ok: fg(46), bad: fg(196), warn: fg(214), title: fg(255), border: fg(239), accent: fg(81) };
}

const fit = (s, w) => (s.length > w ? s.slice(0, Math.max(0, w - 1)) + '…' : s.padEnd(w));
const pct = (f) => `${Math.round(Math.min(Math.max(f, 0), 1) * 100)}%`.padStart(4);
const bytes = (n) => {
  if (n == null) return '–';
  const u = ['B', 'K', 'M', 'G', 'T']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)}${u[i]}`;
};
const duration = (s) => {
  if (!s) return '–';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

function bar(frac, width, p) {
  const f = Number.isFinite(frac) ? Math.min(Math.max(frac, 0), 1) : 0;
  const filled = Math.round(f * width);
  let s = '';
  for (let i = 0; i < width; i++) {
    s += i < filled ? p.fg(GRADIENT[Math.round((i / Math.max(width - 1, 1)) * (GRADIENT.length - 1))])('■') : p.fg(237)('■');
  }
  return s;
}

// Zeile aus Teilen [text, färben?]: Kürzen passiert am Klartext, Farbe erst danach
function row(parts, w) {
  let used = 0, out = '';
  for (const [text, paint = (s) => s] of parts) {
    const room = w - used;
    if (room <= 0) break;
    const t = text.length > room ? text.slice(0, room) : text;
    out += paint(t); used += t.length;
  }
  return out + ' '.repeat(Math.max(0, w - used));
}

// Box mit abgerundeten Ecken; lines sind bereits genau inner breit
function box(title, right, lines, width, p, borderPaint = p.border) {
  const t = title ? ` ${fit(title, Math.max(1, Math.min(title.length, width - 8 - (right ? right.length + 3 : 0))))} ` : '';
  const r = right ? ` ${right} ` : '';
  const fill = Math.max(0, width - 3 - t.length - r.length - (r ? 1 : 0));
  const top = borderPaint('╭─') + p.title(t) + borderPaint('─'.repeat(fill)) + (r ? p.dim(r) + borderPaint('─') : '') + borderPaint('╮');
  return [top, ...lines.map((l) => borderPaint('│') + ' ' + l + ' ' + borderPaint('│')), borderPaint('╰' + '─'.repeat(width - 2) + '╯')]
    .map((l) => l + ' '.repeat(Math.max(0, width - visible(l).length)));
}

// „Label  ■■■■■■□□□□  Wert“ in genau w Zeichen
function meter(label, frac, text, w, p) {
  const tw = Math.max(text.length, 4), bw = w - 9 - tw;
  if (bw < 3) return row([[label.slice(0, 8).padEnd(8), p.label], [text, p.title]], w); // zu schmal für einen Balken
  return p.label(label.slice(0, 8).padEnd(8)) + bar(frac, bw, p) + ' ' + p.title(text.padStart(tw));
}

function serverBox(s, width, p) {
  const w = width - 4, a = s.a2s, g = s.guest, lines = [];
  const online = a?.ok;
  const info = online ? a.info : null;
  const state = online ? [['● online', p.ok]] : [[`● ${a ? a.error : 'warte …'}`, a ? p.bad : p.dim]];
  lines.push(row([...state, info ? [`  ${info.game}`, p.dim] : ['']], w));
  lines.push(row([['Karte'.padEnd(8), p.label], [info ? info.map || '–' : '–', p.accent]], w));
  if (info) {
    const humans = Math.max(0, info.players - info.bots);
    const ptxt = `${humans}/${info.maxPlayers}${info.bots ? ` +${info.bots}B` : ''}`;
    lines.push(meter('Spieler', info.maxPlayers ? humans / info.maxPlayers : 0, ptxt, w, p));
    lines.push(row([['Ping'.padEnd(8), p.label], [`${a.ping} ms`, a.ping < 20 ? p.ok : a.ping < 80 ? p.warn : p.bad],
      [info.password ? '  Passwort' : '', p.dim]], w));
  } else {
    lines.push(row([['Spieler'.padEnd(8), p.label], ['–', p.dim]], w));
    lines.push(row([['Ping'.padEnd(8), p.label], ['–', p.dim]], w));
  }
  if (g) {
    lines.push(meter('CPU', g.cpu, pct(g.cpu).trim(), w, p));
    lines.push(meter('RAM', g.maxmem ? g.mem / g.maxmem : 0, `${bytes(g.mem)}/${bytes(g.maxmem)}`, w, p));
    const rate = (n) => (n == null ? '–' : `${bytes(n)}/s`);
    lines.push(row([['Netz'.padEnd(8), p.label], [`↓ ${rate(g.rxRate)}`.padEnd(13), p.ok], [`↑ ${rate(g.txRate)}`, p.warn]], w));
    lines.push(row([['Läuft'.padEnd(8), p.label], [duration(g.uptime), p.title], [`  CT ${g.vmid} ${g.status}`, g.status === 'running' ? p.dim : p.bad]], w));
  } else if (s.vmid) {
    lines.push(row([['Proxmox'.padEnd(8), p.label], [`CT ${s.vmid}: keine Daten`, p.dim]], w));
  }
  const border = online ? p.border : a ? p.bad : p.border;
  return box(s.name, `${s.host}:${s.port}`, lines, width, p, border);
}

function renderFrame(state, cols, { color = true, now = new Date() } = {}) {
  const p = painter(color);
  const width = Math.max(40, cols);
  const out = [];
  // Kopf: Host und Summen
  const online = state.servers.filter((s) => s.a2s?.ok);
  const players = online.reduce((n, s) => n + Math.max(0, s.a2s.info.players - s.a2s.info.bots), 0);
  const slots = online.reduce((n, s) => n + s.a2s.info.maxPlayers, 0);
  const head = [];
  const hw = width - 4;
  head.push(row([['Server '.padEnd(9), p.label], [`${online.length}/${state.servers.length} online`, online.length === state.servers.length ? p.ok : p.warn],
    ['   Spieler ', p.label], [`${players}/${slots}`, p.title]], hw));
  for (const n of state.nodes || []) {
    const cpu = (w) => meter(n.name, n.cpu, pct(n.cpu).trim(), w, p);
    const ram = (w) => meter('RAM', n.maxmem ? n.mem / n.maxmem : 0, `${bytes(n.mem)}/${bytes(n.maxmem)}`, w, p);
    const half = Math.floor((hw - 1) / 2);
    if (hw >= 70) head.push(cpu(half) + ' ' + ram(hw - half - 1)); // breit: CPU und RAM nebeneinander
    else head.push(cpu(hw), ram(hw));
  }
  if (state.pveError) head.push(row([['Proxmox '.padEnd(9), p.label], [state.pveError, p.bad]], hw));
  out.push(...box('LAN-Board', now.toLocaleTimeString('de-DE'), head, width, p));
  // Raster der Server: so viele Spalten, wie mit mindestens 38 Zeichen passen
  const per = Math.max(1, Math.floor(width / 38));
  for (let i = 0; i < state.servers.length; i += per) {
    const group = state.servers.slice(i, i + per);
    const bw = Math.floor(width / per);
    // Gleiche Breite im ganzen Raster; nur die letzte Spalte nimmt den Rest der Zeile auf
    const boxes = group.map((s, j) => serverBox(s, j === per - 1 ? width - bw * j : bw, p));
    const height = Math.max(...boxes.map((b) => b.length));
    for (let k = 0; k < height; k++) {
      let line = boxes.map((b, j) => b[k] ?? ' '.repeat(visible(boxes[j][0]).length)).join('');
      const pad = width - visible(line).length;
      if (pad > 0) line += ' '.repeat(pad);
      out.push(line);
    }
  }
  out.push(row([[' q', p.accent], [' beenden  ', p.dim], ['r', p.accent], [` neu abfragen  ·  alle ${state.interval} s`, p.dim]], width));
  return out;
}

// ---------- Konfiguration und Ablauf ----------
function loadConfig(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const servers = (raw.servers || []).map((s, i) => {
    const port = Number(s.port || 27015);
    if (!s.host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`servers[${i}]: host/port ungültig`);
    return { name: clean(s.name || s.host, 40), host: String(s.host), port, vmid: s.vmid ? Number(s.vmid) : null };
  });
  if (!servers.length) throw new Error('keine servers eingetragen');
  let pve = null;
  if (raw.proxmox) {
    const x = raw.proxmox;
    pve = { url: x.url, tokenId: x.tokenId, secret: (x.secret || fs.readFileSync(x.secretFile, 'utf8')).trim(), ca: x.caFile ? fs.readFileSync(x.caFile) : undefined };
    if (!pve.url || !pve.tokenId || !pve.secret) throw new Error('proxmox: url, tokenId und secret/secretFile nötig');
  }
  return { interval: Math.min(Math.max(Number(raw.interval) || 2, 1), 60), servers, pve };
}

async function poll(cfg, state) {
  const [a2s, pve] = await Promise.all([
    Promise.all(cfg.servers.map((s) => queryInfo(s.host, s.port))),
    cfg.pve ? fetchProxmox(cfg.pve).then((r) => ({ r }), (err) => ({ err })) : null,
  ]);
  let merged = { guests: state.guests || {}, nodes: state.nodes || [] };
  let pveError = null;
  if (pve?.r) merged = mergeProxmox(pve.r, state.guests, Date.now());
  else if (pve?.err) pveError = clean(pve.err.message, 80);
  return {
    interval: cfg.interval, guests: merged.guests, nodes: merged.nodes, pveError,
    servers: cfg.servers.map((s, i) => ({ ...s, a2s: a2s[i], guest: s.vmid ? merged.guests[s.vmid] : null })),
  };
}

async function main(argv = process.argv.slice(2)) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const cfg = loadConfig(arg('--config') || process.env.LAN_BOARD_CONFIG || '/etc/lan-board.json');
  const color = !process.env.NO_COLOR;
  let state = { interval: cfg.interval, servers: cfg.servers.map((s) => ({ ...s })), nodes: [] };
  const out = process.stdout;
  if (argv.includes('--once') || !out.isTTY) {
    state = await poll(cfg, state);
    // Ohne Terminal (Pipe, Datei, cron) ohne Farbcodes
    out.write(renderFrame(state, out.columns || 120, { color: Boolean(color && out.isTTY) }).join('\n') + '\n');
    return;
  }
  const draw = () => {
    const lines = renderFrame(state, out.columns || 80, { color }).slice(0, out.rows || 50);
    out.write(`${ESC}H` + lines.map((l) => l + `${ESC}K`).join('\n') + `${ESC}J`);
  };
  const restore = () => { out.write(`${ESC}0m${ESC}?25h${ESC}?1049l`); };
  out.write(`${ESC}?1049h${ESC}?25l`);
  process.on('exit', restore);
  const quit = () => process.exit(0);
  process.on('SIGINT', quit); process.on('SIGTERM', quit);
  let timer = null, busy = false;
  const tick = async () => {
    clearTimeout(timer);
    if (!busy) { busy = true; try { state = await poll(cfg, state); } finally { busy = false; } draw(); }
    timer = setTimeout(tick, cfg.interval * 1000);
  };
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true); process.stdin.resume();
    process.stdin.on('data', (k) => { const c = k.toString(); if (c === 'q' || c === '\x03') quit(); if (c === 'r') tick(); });
  }
  out.on('resize', () => { out.write(`${ESC}2J`); draw(); });
  draw();
  tick();
}

if (require.main === module) main().catch((err) => { console.error(`lan-board: ${err.message}`); process.exit(1); });

module.exports = { parseInfo, queryInfo, mergeProxmox, renderFrame, loadConfig, clean, visible };
