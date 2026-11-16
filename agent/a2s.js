'use strict';
// Steam-Abfrage A2S_INFO über UDP, ohne Zugangsdaten. Genutzt vom LAN-Board (agent/lan-board.js) und vom
// LAN-Client (agent/tmt2-agent.js). Nur Node-Bordmittel; Antworten gelten als nicht vertrauenswürdig.

const dgram = require('node:dgram');

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

module.exports = { parseInfo, queryInfo, clean };
