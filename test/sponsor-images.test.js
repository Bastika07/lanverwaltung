'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { isolated } = require('../test-support/isolated.cjs');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length); name.copy(out, 4); data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, data])), out.length - 4); return out;
}
function png({ width = 2, height = 1, pixels = Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255]), compressed, extra = [] } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), ...extra, chunk('IDAT', compressed || zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
async function sponsor(app, enabled = true) {
  const config = (await app.request('/api/website/admin', { admin: true })).data;
  config.sponsors = { enabled, text: '', entries: [{ name: 'Synthetic Logo', description: '', tier: '', url: '', enabled: true }] };
  const result = await app.request('/api/website/admin', { method: 'PUT', admin: true, body: config });
  assert.equal(result.status, 200); return result.data;
}
const imagePath = (config) => `/api/website/sponsors/${config.sponsors.entries[0].id}/image`;
const payload = (config, bytes = png()) => ({ version: config.version, data: bytes.toString('base64') });

test('sponsor image upload serves one bounded PNG with stable sponsor identity and no public base64', async (t) => {
  const app = await isolated(t), config = await sponsor(app);
  assert.match(config.sponsors.entries[0].id || '', /^[a-f0-9]{32}$/);
  const uploaded = await app.request(imagePath(config), { method: 'PUT', admin: true, body: payload(config) });
  assert.equal(uploaded.status, 200);
  const entry = uploaded.data.sponsors.entries[0];
  assert.equal(entry.id, config.sponsors.entries[0].id);
  assert.match(entry.image.url, /^\/api\/website\/sponsor-images\/[a-f0-9]{32}$/);
  assert.equal(entry.image.width, 2); assert.equal(entry.image.height, 1);
  assert.equal(entry.image.data, undefined);
  const response = await fetch(app.base + entry.image.url);
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png());
  const pub = await app.request('/api/website');
  assert.equal(pub.data.sponsors.entries[0].image.url, entry.image.url);
  assert.equal(JSON.stringify(pub.data).includes(png().toString('base64')), false);
  assert.equal(app.snapshot().meta.website.sponsors.entries[0].image.data, png().toString('base64'));
});

test('PNG validator rejects spoofed, corrupt, oversized and decompression-bomb content', () => {
  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const { decode } = require('../lib/sponsor-image');
  const corrupt = png(); corrupt[corrupt.length - 1] ^= 1;
  const cases = [Buffer.from('<svg/>'), Buffer.alloc(0), corrupt, png().subarray(0, 40),
    Buffer.concat([png(), Buffer.from('trailing')]), Buffer.alloc(128 * 1024 + 1),
    png({ width: 2049 }), png({ width: 0 }), png({ width: 2048, height: 2048 }),
    png({ compressed: Buffer.from('not zlib') }), png({ pixels: Buffer.alloc(1000000) }),
    png({ pixels: Buffer.from([5, 255, 0, 0, 255, 0, 255, 0, 255]) }),
    png({ extra: [chunk('acTL', Buffer.alloc(8))] }), png({ extra: [chunk('FAKE', Buffer.alloc(0))] })];
  for (const bytes of cases) assert.throws(() => decode(bytes.toString('base64'), HttpError), { status: 400 });
  for (const data of [null, {}, '!!!!', 'data:image/png;base64,' + png().toString('base64'), png().toString('base64') + '\n']) {
    assert.throws(() => decode(data, HttpError), { status: 400 });
  }
  assert.equal(decode(png().toString('base64'), HttpError).width, 2);
});

test('image replacement, removal, privacy and stale writes preserve sponsor identity', async (t) => {
  const app = await isolated(t);
  let config = await sponsor(app, false);
  config = (await app.request(imagePath(config), { method: 'PUT', admin: true, body: payload(config) })).data;
  const first = config.sponsors.entries[0].image.url;
  assert.equal((await app.request(first)).status, 404);
  assert.equal((await app.request(first, { admin: true })).status, 200);
  assert.equal((await app.request('/api/website')).data.sponsors, null);
  const changed = png({ pixels: Buffer.from([0, 0, 0, 255, 255, 255, 255, 0, 255]) });
  const stale = config.version;
  config = (await app.request(imagePath(config), { method: 'PUT', admin: true, body: payload(config, changed) })).data;
  assert.notEqual(config.sponsors.entries[0].image.url, first);
  assert.equal((await app.request(first, { admin: true })).status, 404);
  assert.equal((await app.request(imagePath(config), { method: 'DELETE', admin: true, body: { version: stale } })).status, 409);
  const second = config.sponsors.entries[0].image.url;
  config.sponsors.enabled = true;
  config = (await app.request('/api/website/admin', { method: 'PUT', admin: true, body: config })).data;
  assert.equal(config.sponsors.entries[0].image.url, second);
  assert.equal((await app.request(second)).status, 200);
  config.sponsors.entries[0].enabled = false;
  config = (await app.request('/api/website/admin', { method: 'PUT', admin: true, body: config })).data;
  assert.equal((await app.request(second)).status, 404);
  assert.deepEqual((await app.request('/api/website')).data.sponsors.entries, []);
  const id = config.sponsors.entries[0].id;
  config = (await app.request(imagePath(config), { method: 'DELETE', admin: true, body: { version: config.version } })).data;
  assert.equal(config.sponsors.entries[0].id, id);
  assert.equal(config.sponsors.entries[0].image, undefined);
  assert.equal((await app.request(second, { admin: true })).status, 404);
  assert.equal(app.snapshot().meta.website.sponsors.entries[0].image, undefined);
});

test('image writes require admin, same origin and a still-active session', async (t) => {
  const app = await isolated(t), config = await sponsor(app);
  for (const method of ['PUT', 'DELETE']) {
    for (const options of [{}, { user: 'buyer' }]) {
      assert.equal((await app.request(imagePath(config), { method, body: payload(config), ...options })).status, 401);
    }
    assert.equal((await app.request(imagePath(config), { method, admin: true, body: payload(config), headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  }
  assert.equal((await app.request(imagePath(config), { method: 'PUT', admin: true, body: payload(config, Buffer.from('fake')) })).status, 400);
  const pending = app.staged(imagePath(config), { method: 'PUT', admin: true, body: payload(config) });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await app.request('/api/logout', { method: 'POST', admin: true })).status, 200);
  pending.finish(); assert.equal((await pending.done).status, 401);
  assert.equal(app.snapshot().meta.website.version, config.version);
  assert.equal(app.snapshot().meta.website.sponsors.entries[0].image, undefined);
});

test('sponsor configuration rejects forged identities and cannot inject external or filesystem images', async (t) => {
  const app = await isolated(t);
  let config = await sponsor(app);
  config.sponsors.entries[0].image = { url: 'https://tracker.invalid/a.png', data: '../../secret', id: '../file' };
  config = (await app.request('/api/website/admin', { method: 'PUT', admin: true, body: config })).data;
  assert.equal(config.sponsors.entries[0].image, undefined);
  config.sponsors.entries.push({ ...config.sponsors.entries[0] });
  assert.equal((await app.request('/api/website/admin', { method: 'PUT', admin: true, body: config })).status, 400);
  config.sponsors.entries.pop(); config.sponsors.entries[0].id = '../../secret';
  assert.equal((await app.request('/api/website/admin', { method: 'PUT', admin: true, body: config })).status, 400);
});

test('PNG validator strips metadata and rejects invalid chunk names and trailing zlib streams', () => {
  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const { decode } = require('../lib/sponsor-image');
  assert.equal(decode(png({ extra: [chunk('tEXt', Buffer.from('private metadata'))] }).toString('base64'), HttpError).data, png().toString('base64'));
  const malformed = png(); malformed[12] |= 128;
  malformed.writeUInt32BE(crc32(malformed.subarray(12, 29)), 29);
  assert.throws(() => decode(malformed.toString('base64'), HttpError), { status: 400 });
  assert.throws(() => decode(png({ compressed: Buffer.concat([zlib.deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255])), Buffer.from('trailing')]) }).toString('base64'), HttpError), { status: 400 });
});

test('sponsor PNG and association survive an actual server restart from SQLite', async (t) => {
  const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
  const { spawn } = require('node:child_process');
  const app = await isolated(t), config = await sponsor(app);
  const directory = fs.mkdtempSync(path.join(process.env.TMPDIR || require('node:os').tmpdir(), 'sponsor-restart-'));
  fs.writeFileSync(path.join(directory, 'db.json'), JSON.stringify(app.snapshot()));
  const probe = net.createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise((r) => probe.close(r));
  const base = `http://127.0.0.1:${port}`, password = require('node:crypto').randomBytes(32).toString('hex');
  let child;
  async function stop() { if (child && child.exitCode === null && child.signalCode === null) { const done = new Promise((r) => child.once('exit', r)); child.kill(); await done; } }
  t.after(async () => { await stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  async function start() {
    child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: directory, ADMIN_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      let logs = ''; const timeout = setTimeout(() => reject(new Error('Restart timeout: ' + logs)), 8000);
      child.stdout.on('data', (b) => { logs += b; if (logs.includes('LAN-System läuft')) { clearTimeout(timeout); resolve(); } });
      child.stderr.on('data', (b) => { logs += b; });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error(logs)); });
    });
  }
  await start();
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const upload = await fetch(base + imagePath(config), { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(payload(config)) });
  assert.equal(upload.status, 200);
  const saved = await upload.json(), entry = saved.sponsors.entries[0];
  await stop(); assert.ok(fs.existsSync(path.join(directory, 'db.sqlite')));
  fs.rmSync(path.join(directory, 'db.json')); // Restart must use SQLite, not the migration source.
  await start();
  const published = await (await fetch(base + '/api/website')).json();
  assert.equal(published.sponsors.entries[0].id, entry.id);
  assert.deepEqual(published.sponsors.entries[0].image, entry.image);
  const image = await fetch(base + entry.image.url);
  assert.equal(image.status, 200); assert.deepEqual(Buffer.from(await image.arrayBuffer()), png());
});

test('PNG validator accepts RGB/RGBA row filters and rejects invalid chunk sequencing and concatenated streams', () => {
  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const { decode } = require('../lib/sponsor-image');
  const signature = Buffer.from('89504e470d0a1a0a', 'hex');
  for (const color of [2, 6]) {
    const header = Buffer.alloc(13); header.writeUInt32BE(2); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = color;
    const channels = color === 2 ? 3 : 4;
    for (const filter of [0, 1, 2, 3, 4]) {
      const pixels = Buffer.alloc(1 + 2 * channels, 42); pixels[0] = filter;
      const valid = Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
      const result = decode(valid.toString('base64'), HttpError);
      assert.equal(result.width, 2); assert.equal(result.height, 1);
    }
  }
  const valid = png(), header = valid.subarray(8, 33);
  const compressed = zlib.deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255]));
  const split = Math.floor(compressed.length / 2);
  const truncated = Buffer.alloc(12); truncated.writeUInt32BE(100); truncated.write('IDAT', 4);
  const cases = [
    Buffer.concat([signature, header, header, valid.subarray(33)]),
    Buffer.concat([signature, header, chunk('IDAT', compressed.subarray(0, split)), chunk('tEXt', Buffer.from('split')), chunk('IDAT', compressed.subarray(split)), chunk('IEND', Buffer.alloc(0))]),
    Buffer.concat([signature, header, truncated]),
    png({ compressed: Buffer.concat([compressed, compressed]) }),
  ];
  for (const bytes of cases) assert.throws(() => decode(bytes.toString('base64'), HttpError), { status: 400 });
});

module.exports = { png, chunk, sponsor, payload, imagePath };
