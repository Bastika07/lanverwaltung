'use strict';
const http = require('node:http');

const TMT_TOKEN = 'synthetic-tmt2-token';

// Lokale TMT2-Attrappe: merkt sich alle Anfragen und antwortet wie die TMT2-API (nur die genutzten Pfade).
async function fakeTmt(t) {
  const calls = [];
  const matches = new Map();
  const state = { noServer: false }; // true: wie TMT2 ohne freien Gameserver (500, reiner Text)
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const url = new URL(req.url, 'http://x');
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(value === undefined ? '' : JSON.stringify(value)); };
      if (req.headers.authorization !== `Bearer ${TMT_TOKEN}`) return reply(401, { message: 'unauthorized' });
      const id = decodeURIComponent(url.pathname.split('/')[3] || '');
      if (req.method === 'GET' && url.pathname === '/api/matches') {
        const p = url.searchParams.getAll('passthrough');
        return reply(200, [...matches.values()].filter((m) => !p.length || p.includes(m.passthrough)));
      }
      if (req.method === 'POST' && url.pathname === '/api/matches') {
        if (state.noServer) { res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('no free game server available'); }
        if (body.teamA.name === 'busy') return reply(400, { message: 'invalid <b>map pool</b>' });
        const m = { id: `tmt-${matches.size + 1}`, state: 'ELECTION', isStopped: false, matchMaps: [], rconPassword: 'SECRET_RCON', ...body };
        matches.set(m.id, m);
        return reply(201, m);
      }
      if (req.method === 'GET' && matches.has(id)) return reply(200, matches.get(id));
      if (req.method === 'DELETE' && matches.has(id)) { matches.get(id).isStopped = true; return reply(200); }
      return reply(404, { message: 'not found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return { calls, matches, state, url: `http://127.0.0.1:${server.address().port}` };
}

module.exports = { fakeTmt, TMT_TOKEN };
