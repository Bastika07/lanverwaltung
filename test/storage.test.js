'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { openStore: rawOpenStore, readSnapshot, backupSnapshot } = require('../lib/storage');
const openStores = new Map();
function openStore(directory) { const store = rawOpenStore(directory); openStores.set(directory, store); return store; }

function sample() {
  return { meta: { securityVersion: 1, matchIdentityVersion: 1, seq: 0, website: { pages: { impressum: { text: 'Legal draft' } } } },
    persons: [{ id: 'person', name: 'Name', discordId: 'discord', note: '0', ticketOwnerId: 'account' }],
    accounts: [{ id: 'account', profile: { email: 'test@example.invalid' } }],
    userSessions: { hashedToken: { uid: 'account', exp: 9999999999999 } },
    seating: { seats: [{ id: 'seat', label: '1' }], areas: [] }, announcements: [{ id: 'a', text: 'Announcement' }],
    events: ['first', 'second'].map((id) => ({ id, name: id, details: { text: 'Details' }, attendees: [{ personId: 'person', seat: 'seat' }],
      tournaments: [{ id: 't-' + id, participants: ['Name'], playerIds: { Name: 'person' }, results: { r0m0: { a: 2, b: 0 } } }],
      schedule: [{ id: 's-' + id, title: 'Schedule' }], ticketTypes: [{ id: 'type-' + id, price: 1000 }], guestServers: [{ id: 'server-' + id, accountId: 'account', ip: '10.1.1.1' }],
      orders: [{ id: 'order-' + id, accountId: 'account', status: 'paid', tickets: [{ id: 'ticket-' + id, code: 'SECRET-' + id, personId: 'person', holder: 'Name', price: 1000 }] }] })),
    futureField: { nested: ['preserved', null, false] } };
}
function temp(t, data = sample()) {
  const directory = fs.mkdtempSync(path.join(process.env.OPENCODE_TEST_TMP || os.tmpdir(), 'seniorenlan-sqlite-'));
  if (data) fs.writeFileSync(path.join(directory, 'db.json'), JSON.stringify(data));
  t.after(() => { openStores.get(directory)?.close(); openStores.delete(directory); fs.rmSync(directory, { recursive: true, force: true }); });
  return directory;
}

test('JSON import preserves every field, identity, code and ordering in separate SQLite records', (t) => {
  const original = sample(), directory = temp(t, original), store = openStore(directory);
  t.after(() => store.close());
  assert.deepEqual(store.data, original);
  assert.deepEqual(readSnapshot(store.filename), original);
  assert.equal(fs.readFileSync(path.join(directory, 'db.json'), 'utf8'), JSON.stringify(original));
  const sql = new DatabaseSync(store.filename, { readOnly: true });
  try {
    assert.equal(sql.prepare('SELECT count(*) AS n FROM events').get().n, 2);
    assert.equal(sql.prepare('SELECT count(*) AS n FROM orders').get().n, 2);
    assert.equal(sql.prepare('SELECT count(*) AS n FROM tickets').get().n, 2);
    assert.equal(sql.prepare("SELECT count(*) AS n FROM event_items WHERE kind='attendees'").get().n, 2);
    assert.equal(sql.prepare("SELECT payload FROM root_state WHERE key='events'").get().payload, '[]');
    assert.equal(sql.prepare("SELECT code FROM tickets WHERE id='ticket-first'").get().code, 'SECRET-first');
    assert.match(sql.prepare("SELECT value FROM storage_meta WHERE key='json_import_sha256'").get().value, /^[a-f0-9]{64}$/);
  } finally { sql.close(); }
});

test('restart uses SQLite, never reimports stale JSON or repeats security migrations', (t) => {
  const directory = temp(t); let store = openStore(directory);
  store.data.persons[0].name = 'Changed'; store.data.events.reverse(); store.save(store.data); store.close();
  fs.writeFileSync(path.join(directory, 'db.json'), 'invalid stale JSON');
  store = openStore(directory);
  try {
    assert.equal(store.data.persons[0].name, 'Changed'); assert.equal(store.data.events[0].id, 'second');
    assert.equal(store.data.events[0].orders[0].tickets[0].code, 'SECRET-second');
    assert.equal(store.data.meta.securityVersion, 1); assert.equal(store.data.meta.matchIdentityVersion, 1);
  } finally { store.close(); }
});

test('entity inserts, reordering, account detachment and parent deletions survive reload', (t) => {
  const directory = temp(t), store = openStore(directory); t.after(() => store.close());
  const d = store.data; d.accounts = []; d.userSessions = {}; d.events.pop();
  d.events[0].orders[0].accountId = null; d.events[0].orders[0].ownerKey = 'deleted:random';
  d.events[0].orders[0].tickets[0].holder = 'Pseudonym';
  d.persons.push({ id: 'new-person', name: 'Other' }); d.persons.reverse();
  store.save(d); assert.deepEqual(readSnapshot(store.filename), d);
  d.events[0].orders = []; store.save(d); assert.deepEqual(readSnapshot(store.filename), d);
});

test('a failed SQL constraint rolls the entire save back without partial ticket or profile changes', (t) => {
  const directory = temp(t), store = openStore(directory); t.after(() => store.close());
  const original = structuredClone(store.data);
  store.data.accounts[0].profile.email = 'changed@example.invalid';
  store.data.events[1].orders[0].tickets[0].code = 'SECRET-first';
  assert.throws(() => store.save(store.data), /UNIQUE/);
  assert.deepEqual(readSnapshot(store.filename), original);
  store.save(original); assert.deepEqual(readSnapshot(store.filename), original);
});

test('invalid JSON imports fail closed and can be retried without overwriting the source', (t) => {
  const directory = temp(t, null), file = path.join(directory, 'db.json');
  fs.writeFileSync(file, '{broken'); assert.throws(() => openStore(directory));
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  fs.writeFileSync(file, JSON.stringify(sample())); const store = openStore(directory);
  try { assert.deepEqual(store.data, sample()); } finally { store.close(); }
});

test('duplicate IDs and codes prevent migration; existing non-application SQLite is not replaced', (t) => {
  const directory = temp(t), d = sample(); d.events[1].orders[0].tickets[0].code = 'SECRET-first';
  fs.writeFileSync(path.join(directory, 'db.json'), JSON.stringify(d)); assert.throws(() => openStore(directory), /UNIQUE/);
  fs.writeFileSync(path.join(directory, 'db.json'), JSON.stringify(sample()));
  const store = openStore(directory); store.close();
  const other = temp(t), sql = new DatabaseSync(path.join(other, 'db.sqlite'));
  sql.exec('CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES (\'KEEP\')'); sql.close();
  assert.throws(() => openStore(other), /Unbekannte/);
  const retained = new DatabaseSync(path.join(other, 'db.sqlite')); assert.equal(retained.prepare('SELECT value FROM unrelated').get().value, 'KEEP'); retained.close();
});

test('second application writer is refused while snapshot readers remain available', (t) => {
  const directory = temp(t), store = openStore(directory); t.after(() => store.close());
  assert.throws(() => openStore(directory), /nur eine App-Instanz/);
  assert.deepEqual(readSnapshot(store.filename), sample());
});

test('online backup creates an independent, consistent single-file database and does not overwrite targets', async (t) => {
  const directory = temp(t), store = openStore(directory); t.after(() => store.close());
  const output = path.join(directory, 'backup.sqlite');
  const running = backupSnapshot(store.filename, output);
  store.data.meta.seq = 1; store.data.persons[0].note = '1'; store.save(store.data);
  await running;
  const snapshot = readSnapshot(output);
  assert.equal(String(snapshot.meta.seq), snapshot.persons[0].note);
  assert.equal(snapshot.events[0].orders[0].tickets[0].code, 'SECRET-first');
  assert.ok(!fs.existsSync(output + '-wal'));
  await assert.rejects(backupSnapshot(store.filename, output), /existiert/);
  const restore = temp(t, null); fs.copyFileSync(output, path.join(restore, 'db.sqlite'));
  const restored = openStore(restore);
  try { assert.deepEqual(restored.data, snapshot); } finally { restored.close(); }
});

test('legacy single-event JSON remains lossless until the normal application migration runs', (t) => {
  const legacy = { tournaments: [{ id: 'old', participants: ['Alice'], results: {} }], people: [{ id: 'old-person', name: 'Alice', seat: 'A1' }], meta: { event: { active: false } } };
  const directory = temp(t, legacy), store = openStore(directory);
  try { assert.deepEqual(store.data, legacy); } finally { store.close(); }
});

test('a truncated existing SQLite database never silently falls back to stale JSON', (t) => {
  const directory = temp(t);
  fs.writeFileSync(path.join(directory, 'db.sqlite'), '');
  assert.throws(() => openStore(directory), /kein automatischer Rückfall/);
});

test('uncommitted writes are rolled back after a crash without partial application state', { timeout: 15000 }, async (t) => {
  const directory = temp(t), store = openStore(directory), filename = store.filename; store.close();
  const child = spawn(process.execPath, ['-e', `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec("BEGIN IMMEDIATE;DELETE FROM tickets;DELETE FROM accounts");console.log('ready');setInterval(()=>{},1000)`, filename], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('child transaction timeout')), 5000);
      child.stdout.on('data', (b) => { if (String(b).includes('ready')) { clearTimeout(timeout); resolve(); } });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('child exited before transaction')); });
    });
  } finally {
    const exited = new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
  }
  assert.deepEqual(readSnapshot(filename), sample());
});

test('OS writer locks are released after a process crash and committed WAL data survives', { timeout: 15000 }, async (t) => {
  const directory = temp(t), modulePath = path.resolve(__dirname, '../lib/storage');
  const child = spawn(process.execPath, ['-e', `const s=require(${JSON.stringify(modulePath)}).openStore(process.argv[1]);s.data.meta.crashTest='committed';s.save(s.data);console.log('ready');setInterval(()=>{},1000)`, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('child startup timeout')), 5000);
      child.stdout.on('data', (b) => { if (String(b).includes('ready')) { clearTimeout(timeout); resolve(); } });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('child exited before ready')); });
    });
    assert.throws(() => openStore(directory), /nur eine App-Instanz/);
  } finally {
    const exited = new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
  }
  const store = openStore(directory);
  try { assert.equal(store.data.meta.crashTest, 'committed'); } finally { store.close(); }
});
