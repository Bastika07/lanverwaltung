'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { readSnapshot } = require('../lib/storage');

async function isolated(t, { port: requestedPort = 0 } = {}) {
  const directory = fs.mkdtempSync(path.join(process.env.OPENCODE_TEST_TMP || os.tmpdir(), 'seniorenlan-assessment-'));
  const modules = Object.fromEntries(['details', 'tournaments', 'announcements', 'schedule', 'info', 'people', 'seating', 'beamer', 'tickets', 'servers'].map((key) => [key, true]));
  const stamp = new Date().toISOString();
  const profile = { firstName: 'Synthetic', lastName: 'Test', street: 'Test 1', zip: '12345', city: 'Test', email: 'test@example.invalid', birthdate: '1990-01-01' };
  const event = (id) => ({ id, name: id, createdAt: stamp, active: false, modules, access: { info: 'tickets', seating: 'tickets' },
    sale: { saleOpen: true, payDays: 14, minAge: 0, seatSelection: true },
    info: { wifi: { password: 'SYNTHETIC_WIFI' }, servers: [], games: [] },
    ticketTypes: [{ id: 'normal', name: 'Normal', active: true, price: 1000, quota: 3, maxPerOrder: 5, participant: true }],
    orders: ['buyer', 'other'].map((uid) => ({ id: `${id}-${uid}`, ref: `${id}-${uid}`, accountId: uid, status: 'paid', createdAt: stamp, dueAt: stamp, total: 1000,
      tickets: [{ id: `${id}-ticket-${uid}`, code: `${id}-${uid}-SYNTHETIC`.toUpperCase(), typeId: 'normal', holder: uid, personId: uid, price: 1000 }] })),
    attendees: ['buyer', 'other'].map((personId) => ({ personId })),
    tournaments: [{ id: 'match', name: 'Match', type: 'ko', status: 'running', participants: ['buyer', 'other'], order: [0, 1], results: {}, members: {}, discordEnabled: false }],
    serverConfig: { domain: 'guest.invalid', ipFrom: '10.10.50.10', ipTo: '10.10.50.12', open: true, maxPerAccount: 2 }, guestServers: [],
  });
  const tokens = Object.fromEntries(['buyer', 'other', 'outsider'].map((uid) => [uid, crypto.randomBytes(32).toString('hex')]));
  const data = { meta: { securityVersion: 1, settings: { modules } },
    persons: ['buyer', 'other'].map((id) => ({ id, name: id, discordId: id, ticketOwnerId: id })),
    accounts: Object.keys(tokens).map((id) => ({ id, discordName: id, profile, consentAt: stamp })),
    userSessions: Object.fromEntries(Object.entries(tokens).map(([uid, token]) => [crypto.createHash('sha256').update(token).digest('hex'), { uid, exp: Date.now() + 3600000 }])),
    seating: { cols: 3, rows: 1, seats: [{ id: '1111111111', x: 0, y: 0, label: '1', locked: false }], categories: [], areas: [] },
    events: [event('first'), event('second')],
  };
  fs.writeFileSync(path.join(directory, 'db.json'), JSON.stringify(data));
  const probe = net.createServer(); await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(requestedPort, '127.0.0.1', resolve); });
  const port = probe.address().port; await new Promise((r) => probe.close(r));
  const base = `http://127.0.0.1:${port}`, password = crypto.randomBytes(32).toString('hex');
  // Allowlist environment: never inherit production integration credentials/settings.
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: String(port), HOST: '127.0.0.1', DATA_DIR: directory, ADMIN_PASSWORD: password,
    ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}) };
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', adminCookie;
  child.stdout.on('data', (b) => { logs += b; }); child.stderr.on('data', (b) => { logs += b; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise((r) => child.once('exit', r));
      child.kill(); const timer = setTimeout(() => child.kill('SIGKILL'), 2000); await stopped; clearTimeout(timer);
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Isolated startup timeout')), 8000);
    child.stdout.on('data', () => { if (logs.includes('LAN-System läuft')) { clearTimeout(timer); resolve(); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Isolated startup failed: ' + logs)); });
  });
  async function request(url, { method = 'GET', body, raw, user, admin, headers = {} } = {}) {
    const r = await fetch(base + url, { method, headers: { 'X-Event': 'first', ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(user ? { Cookie: `lan_user=${tokens[user]}` } : {}), ...(admin ? { Cookie: adminCookie } : {}), ...headers },
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000), redirect: 'manual' });
    const text = await r.text(); let value; try { value = JSON.parse(text); } catch { value = text; }
    return { status: r.status, data: value, text, headers: r.headers };
  }
  async function login() {
    const r = await request('/api/login', { method: 'POST', body: { password } });
    if (r.status !== 200) throw new Error('Isolated admin login failed');
    adminCookie = r.headers.get('set-cookie').split(';')[0];
    return r;
  }
  function staged(url, { method = 'POST', body = {}, user, admin } = {}) {
    const r = http.request(base + url, { method, headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked', 'X-Event': 'first',
      Cookie: admin ? adminCookie : `lan_user=${tokens[user]}` } });
    const done = new Promise((resolve, reject) => {
      r.on('response', (res) => { let text = ''; res.on('data', (b) => { text += b; }); res.on('end', () => resolve({ status: res.statusCode, text })); });
      r.on('error', reject);
    });
    r.write('{');
    return { done, finish: () => r.end(JSON.stringify(body).slice(1)) };
  }
  await login();
  return { base, cookieFor: (user) => `lan_user=${tokens[user]}`, request, staged, login, profile, snapshot: () => readSnapshot(path.join(directory, 'db.sqlite')), logs: () => logs };
}
module.exports = { isolated };
