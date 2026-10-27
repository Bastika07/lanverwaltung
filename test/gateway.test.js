'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the actual module with only the external socket/REST/clock seams replaced.
// No bot credentials, real clocks, sockets, or REST requests are used.
function harness({ url = 'wss://gateway.discord.gg/', gatewayResult } = {}) {
  let now = 0, next = 0;
  const timers = new Map(), sockets = [], logs = [], calls = [];
  const schedule = (fn, ms, interval = false) => {
    const handle = { id: ++next, fn, ms, at: now + ms, interval, unref() { return this; } };
    timers.set(handle.id, handle);
    return handle;
  };
  const clear = (handle) => { if (handle) timers.delete(handle.id); };
  class Socket {
    constructor(target) { this.url = String(target); this.readyState = 1; this.listeners = {}; this.sent = []; this.closes = []; sockets.push(this); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    emit(type, event) { for (const fn of this.listeners[type] || []) fn(event); }
    message(msg) { this.emit('message', { data: JSON.stringify(msg) }); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close(code = 1000, reason = '') { this.closes.push({ code, reason }); this.readyState = 2; }
    closed(code = 4000) { this.readyState = 3; this.emit('close', { code, reason: '' }); }
  }
  const Discord = { enabled: true, TOKEN: 'fake-test-token', GUILD: 'test-guild', async call(method, route, body) {
    calls.push({ method, route, body });
    if (route === '/oauth2/applications/@me') return { id: 'test-app' };
    if (route === '/gateway/bot') return gatewayResult ? gatewayResult() : { url };
    return [];
  } };
  const context = vm.createContext({ module: { exports: {} }, URL, WebSocket: Socket,
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
    setTimeout: (fn, ms) => schedule(fn, ms), clearTimeout: clear,
    setInterval: (fn, ms) => schedule(fn, ms, true), clearInterval: clear });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../lib/gateway.js'), 'utf8'), context, { filename: 'lib/gateway.js' });
  const api = context.module.exports(Discord, { commands: () => [], find: () => null }, {
    log: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')),
  });
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  async function tick(ms) {
    const until = now + ms;
    for (let count = 0; ; count++) {
      const timer = [...timers.values()].filter((t) => t.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!timer) break;
      assert.ok(count < 1000, 'runaway timer');
      now = timer.at;
      if (timer.interval) timer.at += timer.ms; else timers.delete(timer.id);
      timer.fn(); await flush();
    }
    now = until; await flush();
  }
  return { api, sockets, timers, logs, calls, flush, tick,
    scheduleHeartbeat: vm.runInContext('scheduleHeartbeat', context),
    async start() { await api.start(); await flush(); } };
}
const hello = (socket, interval = 45000) => socket.message({ op: 10, d: { heartbeat_interval: interval } });
const ready = (socket, url = 'wss://gateway.discord.gg/') => socket.message({ op: 0, t: 'READY', s: 42,
  d: { session_id: 'test-session', resume_gateway_url: url, user: { username: 'test-bot' } } });
const unsafeTargets = [
  'ws://gateway.discord.gg/', 'https://gateway.discord.gg/', 'wss://127.0.0.1/',
  'wss://[::1]/', 'wss://10.0.0.1/', 'wss://192.168.1.1/', 'wss://172.16.0.1/',
  'wss://example.com/', 'wss://gateway.discord.gg.evil.test/', 'wss://evilgateway.discord.gg/',
  'wss://gateway.discord.gg@evil.test/', 'wss://user:secret@gateway.discord.gg/',
  'wss://gateway.discord.gg:8443/', 'wss://gateway.discord.gg./',
  'wss://gateway-us-east1-b.discord.gg.evil.test/', 'wss://gateway--us-east1.discord.gg/',
  'wss://gateway-us-east1-.discord.gg/', 'wss://gateway-us%2fevil.discord.gg/',
  'wss://gateway-us-east1.discord.gg@evil.test/',
  'wss://gateway.discord.gg/not-gateway', 'wss://gateway.discord.gg/#fragment', '', null, 42,
];

test('initial gateway rejects untrusted targets before creating a socket or sending credentials', async () => {
  for (const url of unsafeTargets) {
    const h = harness({ url });
    await h.start();
    assert.equal(h.sockets.length, 0, `must reject ${url}`);
    assert.ok(!h.logs.join(' ').includes('secret'));
    assert.ok(!h.logs.join(' ').includes('fake-test-token'));
    h.api.stop();
  }
});

test('documented gateway URL uses a single root path and explicit version/JSON encoding', async () => {
  for (const url of ['wss://gateway.discord.gg', 'wss://gateway.discord.gg/', 'wss://gateway.discord.gg:443/?v=9&encoding=etf&compress=zlib-stream']) {
    const h = harness({ url });
    await h.start();
    assert.equal(h.sockets.length, 1);
    assert.equal(h.sockets[0].url, 'wss://gateway.discord.gg/?v=10&encoding=json');
    hello(h.sockets[0]);
    assert.equal(h.sockets[0].sent[0].op, 2);
    h.api.stop();
  }
});

test('resume uses a validated regional Discord gateway and preserves the handshake', async () => {
  const h = harness(); await h.start(); const original = h.sockets[0]; hello(original);
  ready(original, 'wss://gateway-us-east1-b.discord.gg/'); original.closed(); await h.tick(2500);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.sockets[1].url, 'wss://gateway-us-east1-b.discord.gg/?v=10&encoding=json');
  hello(h.sockets[1]); assert.equal(h.sockets[1].sent[0].op, 6);
  assert.equal(h.sockets[1].sent[0].d.session_id, 'test-session');
  h.api.stop(); assert.equal(h.timers.size, 0);
});

test('untrusted resume URLs never open an untrusted socket', async () => {
  for (const target of unsafeTargets) {
    const h = harness(); await h.start(); const original = h.sockets[0];
    hello(original); ready(original, target);
    assert.equal(original.closes.length, 1, `invalid resume target ${target} must discard the session`);
    original.closed(); await h.tick(2500);
    assert.ok(h.sockets.every((sock) => sock.url === 'wss://gateway.discord.gg/?v=10&encoding=json'));
    hello(h.sockets[1]); assert.equal(h.sockets[1].sent[0].op, 2);
    h.api.stop(); assert.equal(h.timers.size, 0);
  }
});

test('heartbeat rejects unsafe intervals before timers or credentials are sent', async () => {
  for (const interval of [0, -1, 1, 999, 120001, 2147483648, null, undefined, NaN, Infinity, 45000.5, '45000', {}]) {
    const h = harness(); await h.start(); const sock = h.sockets[0];
    sock.message({ op: 10, d: { heartbeat_interval: interval } });
    assert.equal(h.timers.size, 0, `invalid interval ${interval} must not create timers`);
    assert.equal(sock.sent.length, 0); assert.equal(sock.closes.length, 1);
    h.api.stop(); assert.equal(h.timers.size, 0);
  }
});

test('timer boundary rejects invalid delays even without the HELLO guard', () => {
  const h = harness();
  for (const delay of [-1, 120001, NaN, Infinity, -Infinity, undefined, null, '1000', {}]) {
    assert.throws(() => h.scheduleHeartbeat(() => {}, delay), /Ungültige Heartbeat-Verzögerung/);
    assert.equal(h.timers.size, 0);
  }
  for (const delay of [0, 0.5, 1000, 45000, 120000]) {
    const handle = h.scheduleHeartbeat(() => {}, delay);
    assert.equal(handle.ms, delay);
    h.timers.clear();
  }
});

test('heartbeat accepts both interval boundaries and maintains one timer', async () => {
  for (const interval of [1000, 120000]) {
    const h = harness(); await h.start(); const sock = h.sockets[0]; hello(sock, interval);
    assert.equal(h.timers.size, 1);
    assert.equal([...h.timers.values()][0].ms, interval / 2);
    await h.tick(interval / 2);
    assert.equal(sock.sent.filter((frame) => frame.op === 1).length, 1);
    assert.equal(h.timers.size, 1);
    assert.equal([...h.timers.values()][0].ms, interval);
    h.api.stop(); assert.equal(h.timers.size, 0);
  }
});

test('duplicate HELLO clears the existing heartbeat cycle', async () => {
  const h = harness(); await h.start(); const sock = h.sockets[0]; hello(sock); hello(sock);
  assert.equal(h.timers.size, 0); assert.equal(sock.sent.length, 1);
  h.api.stop(); assert.equal(h.timers.size, 0);
});

test('heartbeat follows jitter then interval, checks ACKs and ignores stale sockets', async () => {
  const h = harness(); await h.start(); const sock = h.sockets[0]; hello(sock, 10000); ready(sock);
  const beats = () => sock.sent.filter((x) => x.op === 1).length;
  await h.tick(4999); assert.equal(beats(), 0);
  await h.tick(1); assert.equal(beats(), 1); sock.message({ op: 11 });
  await h.tick(9999); assert.equal(beats(), 1);
  await h.tick(1); assert.equal(beats(), 2);
  await h.tick(10000); assert.equal(sock.closes.length, 1); assert.equal(h.timers.size, 0);
  sock.closed(); await h.tick(2500); hello(h.sockets[1]);
  const timerCount = h.timers.size, sentCount = sock.sent.length;
  hello(sock, 1); ready(sock, 'wss://evil.test/'); sock.message({ op: 7 });
  assert.equal(h.timers.size, timerCount); assert.equal(sock.sent.length, sentCount);
  h.api.stop(); assert.equal(h.timers.size, 0);
});

test('server-requested heartbeat requires ACK without moving the scheduled heartbeat', async () => {
  for (const acknowledge of [false, true]) {
    const h = harness(); await h.start(); const sock = h.sockets[0]; hello(sock, 10000); ready(sock);
    await h.tick(1000); sock.message({ op: 1, d: null });
    assert.equal(sock.sent.filter((frame) => frame.op === 1).length, 1);
    assert.equal(sock.sent.at(-1).d, 42);
    if (acknowledge) sock.message({ op: 11 });
    await h.tick(4000);
    assert.equal(sock.closes.length, acknowledge ? 0 : 1);
    assert.equal(sock.sent.filter((frame) => frame.op === 1).length, acknowledge ? 2 : 1);
    h.api.stop(); assert.equal(h.timers.size, 0);
  }
});

test('stop clears pending reconnect and invalid-session timers', async () => {
  const h = harness(); await h.start(); hello(h.sockets[0]);
  h.sockets[0].message({ op: 9, d: false }); h.api.stop();
  assert.equal(h.timers.size, 0); await h.tick(20000); assert.equal(h.sockets.length, 1);
  const reconnect = harness(); await reconnect.start(); reconnect.sockets[0].closed();
  reconnect.api.stop(); assert.equal(reconnect.timers.size, 0);
});

test('stop during pending gateway REST lookup cannot open a socket', async () => {
  let finish;
  const h = harness({ gatewayResult: () => new Promise((resolve) => { finish = resolve; }) });
  await h.start(); h.api.stop(); finish({ url: 'wss://gateway.discord.gg/' }); await h.flush();
  assert.equal(h.sockets.length, 0);
});

test('reconnect opcode and resumable invalid session clear timers and resume the current session', async () => {
  for (const op of [7, 9]) {
    const h = harness(); await h.start(); const original = h.sockets[0]; hello(original); ready(original);
    original.message({ op, d: op === 9 ? true : null });
    if (op === 9) {
      assert.equal(h.timers.size, 1);
      await h.tick(2999); assert.equal(original.closes.length, 0);
      await h.tick(1);
    }
    assert.equal(original.closes.length, 1);
    assert.equal(h.timers.size, 0);
    original.closed(); await h.tick(2500);
    assert.equal(h.sockets.length, 2);
    hello(h.sockets[1]);
    assert.equal(h.sockets[1].sent[0].op, 6);
    assert.equal(h.sockets[1].sent[0].d.session_id, 'test-session');
    h.api.stop(); assert.equal(h.timers.size, 0);
  }
});

test('invalid sequence and expired session close codes re-identify instead of resuming', async () => {
  for (const code of [1000, 1001, 4007, 4009]) {
    const h = harness(); await h.start(); const sock = h.sockets[0]; hello(sock); ready(sock);
    sock.closed(code); await h.tick(2500);
    assert.equal(h.sockets.length, 2);
    hello(h.sockets[1]);
    assert.equal(h.sockets[1].sent[0].op, 2, `close ${code} invalidates the session`);
    h.api.stop(); assert.equal(h.timers.size, 0);
  }
});

test('malformed gateway messages close instead of throwing or creating timers', async () => {
  for (const raw of ['{broken', 'null', '[]', '{}', '{"op":"10"}', '{"op":10}',
    '{"op":0,"t":"READY"}', '{"op":0,"s":{},"t":"RESUMED","d":{}}',
    '{"op":0,"s":-1,"t":"RESUMED","d":{}}', '{"op":9,"d":"true"}']) {
    const h = harness(); await h.start(); const sock = h.sockets[0];
    assert.doesNotThrow(() => sock.emit('message', { data: raw }));
    assert.equal(sock.closes.length, 1); assert.equal(h.timers.size, 0); h.api.stop();
  }
});
