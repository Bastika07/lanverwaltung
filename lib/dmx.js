'use strict';
// DMX-Lampe über OLA (Open Lighting Architecture) per HTTP schalten.
// Auf dem Raspberry Pi läuft nur "olad"; dessen Web-Schnittstelle (Port 9090) nimmt
// unter /set_dmx ein komplettes Universe als Kommaliste entgegen.

// "1=255, 3=128" -> [{ ch: 1, val: 255 }, { ch: 3, val: 128 }]
function parseValues(text) {
  const out = [];
  for (const part of String(text || '').split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d{1,3})\s*=\s*(\d{1,3})$/);
    if (!m) throw new Error(`Ungültiger DMX-Wert "${part}" (Format: Kanal=Wert, z. B. 1=255)`);
    const ch = Number(m[1]), val = Number(m[2]);
    if (ch < 1 || ch > 512) throw new Error(`DMX-Kanal ${ch} außerhalb 1–512`);
    if (val > 255) throw new Error(`DMX-Wert ${val} außerhalb 0–255`);
    out.push({ ch, val });
  }
  return out;
}

// Baut den Frame so lang wie der höchste verwendete Kanal (an- und aus-Werte zusammen),
// damit "aus" alle Kanäle von "an" sicher wieder auf 0 setzt.
function frame(cfg, which) {
  const on = parseValues(cfg.on), off = parseValues(cfg.off);
  const len = Math.max(1, ...on.map((v) => v.ch), ...off.map((v) => v.ch));
  const data = new Array(len).fill(0);
  for (const { ch, val } of which === 'on' ? on : off) data[ch - 1] = val;
  return data;
}

async function set(cfg, which) {
  if (!cfg || !cfg.url) return false; // keine Lampe konfiguriert
  const url = cfg.url.replace(/\/+$/, '') + '/set_dmx';
  const body = new URLSearchParams({ u: String(cfg.universe || 1), d: frame(cfg, which).join(',') });
  const res = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`OLA antwortet mit ${res.status}`);
  return true;
}

module.exports = { parseValues, frame, on: (cfg) => set(cfg, 'on'), off: (cfg) => set(cfg, 'off') };
