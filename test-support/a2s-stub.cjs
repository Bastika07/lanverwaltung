'use strict';
// Lokaler Steam-A2S-Stub (UDP) mit synthetischen Antworten, ohne echte Gameserver.
const dgram = require('node:dgram');

function infoPacket({ name = 'Testserver', map = 'de_test', game = 'Counter-Strike 2', players = 3, max = 10, bots = 1, password = 0 } = {}) {
  const z = (s) => Buffer.from(`${s}\0`, 'utf8');
  return Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17]), z(name), z(map), z('csgo'), z(game),
    Buffer.from([0xda, 0x02, players, max, bots, 0x64, 0x6c, password, 1]), z('1.0.0')]);
}

// Stub: antwortet erst mit einer Challenge, dann (nur mit korrekter Challenge) mit dem Info-Paket
async function stub(t, respond) {
  const sock = dgram.createSocket('udp4');
  const seen = [];
  sock.on('message', (msg, peer) => { seen.push(msg); const r = respond(msg, seen.length); if (r) sock.send(r, peer.port, peer.address); });
  await new Promise((resolve) => sock.bind(0, '127.0.0.1', resolve));
  t.after(() => sock.close());
  return { port: sock.address().port, seen };
}

module.exports = { infoPacket, stub };
