'use strict';
// SQLite-Persistenz: getrennte Datensätze statt einer JSON-Gesamtdatei.
// Die vorhandene Domänenlogik bleibt ein Single-Writer-Objektmodell; jeder save() ist atomar.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { DatabaseSync, backup } = require('node:sqlite');

const APPLICATION_ID = 0x534c414e;
const SCHEMA_VERSION = 1;
const EVENT_COLLECTIONS = ['tournaments', 'schedule', 'ticketTypes', 'attendees', 'guestServers'];
const GLOBAL_COLLECTIONS = ['persons', 'accounts', 'announcements'];
const TABLES = [
  { name: 'root_state', keys: ['key'], columns: ['key', 'payload'] },
  ...GLOBAL_COLLECTIONS.map((name) => ({ name, keys: ['id'], columns: ['id', 'position', 'payload'] })),
  { name: 'events', keys: ['id'], columns: ['id', 'position', 'payload'] },
  { name: 'event_items', keys: ['event_id', 'kind', 'id'], columns: ['event_id', 'kind', 'id', 'position', 'payload'] },
  { name: 'orders', keys: ['event_id', 'id'], columns: ['event_id', 'id', 'position', 'payload'] },
  { name: 'tickets', keys: ['event_id', 'order_id', 'id'], columns: ['event_id', 'order_id', 'id', 'position', 'payload'] },
  { name: 'user_sessions', keys: ['token_hash'], columns: ['token_hash', 'payload'] },
];
const SCHEMA = `
  CREATE TABLE storage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  INSERT INTO storage_meta (key,value) VALUES ('initialization','pending');
  CREATE TABLE root_state (key TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
  CREATE TABLE persons (id TEXT PRIMARY KEY, position INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
    discord_id TEXT GENERATED ALWAYS AS (json_extract(payload, '$.discordId')) VIRTUAL) STRICT;
  CREATE INDEX persons_discord ON persons(discord_id);
  CREATE TABLE accounts (id TEXT PRIMARY KEY, position INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
  CREATE TABLE announcements (id TEXT PRIMARY KEY, position INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
  CREATE TABLE events (id TEXT PRIMARY KEY, position INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload))) STRICT;
  CREATE TABLE event_items (event_id TEXT NOT NULL REFERENCES events(id), kind TEXT NOT NULL
    CHECK(kind IN ('tournaments','schedule','ticketTypes','attendees','guestServers')), id TEXT NOT NULL,
    position INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(event_id,kind,id)) STRICT;
  CREATE TABLE orders (event_id TEXT NOT NULL REFERENCES events(id), id TEXT NOT NULL, position INTEGER NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload)), account_id TEXT GENERATED ALWAYS AS (json_extract(payload,'$.accountId')) VIRTUAL,
    status TEXT GENERATED ALWAYS AS (json_extract(payload,'$.status')) VIRTUAL, PRIMARY KEY(event_id,id)) STRICT;
  CREATE INDEX orders_owner_status ON orders(account_id,status);
  CREATE TABLE tickets (event_id TEXT NOT NULL, order_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload)), code TEXT GENERATED ALWAYS AS (json_extract(payload,'$.code')) VIRTUAL UNIQUE,
    person_id TEXT GENERATED ALWAYS AS (json_extract(payload,'$.personId')) VIRTUAL,
    PRIMARY KEY(event_id,order_id,id), FOREIGN KEY(event_id,order_id) REFERENCES orders(event_id,id)) STRICT;
  CREATE INDEX tickets_person ON tickets(person_id);
  CREATE TABLE user_sessions (token_hash TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)),
    account_id TEXT GENERATED ALWAYS AS (json_extract(payload,'$.uid')) VIRTUAL) STRICT;
  CREATE INDEX sessions_account ON user_sessions(account_id);
`;

function identity(value) {
  if (typeof value !== 'string' || !value) throw new Error('Datenbank: fehlende oder ungültige Datensatz-ID');
  return value;
}
function array(value) {
  if (!Array.isArray(value)) throw new Error('Datenbank: ungültige Datensatzliste');
  return value;
}
function rowKey(table, row) { return JSON.stringify(table.keys.map((key) => row[table.columns.indexOf(key)])); }
function plan(state) {
  // Nicht-enumerierbare Event-/Personensichten niemals persistieren; Reihenfolge/optionale Felder erhalten.
  const root = JSON.parse(JSON.stringify(state));
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error('Datenbank: Objekt erwartet');
  const rows = new Map(TABLES.map((table) => [table.name, new Map()]));
  const put = (name, row) => {
    const table = TABLES.find((t) => t.name === name), key = rowKey(table, row), target = rows.get(name);
    if (target.has(key)) throw new Error(`Datenbank: doppelte ID in ${name}`);
    target.set(key, row);
  };
  for (const name of GLOBAL_COLLECTIONS) if (Object.hasOwn(root, name)) {
    array(root[name]).forEach((item, i) => put(name, [identity(item.id), i, JSON.stringify(item)]));
    root[name] = [];
  }
  if (Object.hasOwn(root, 'userSessions')) {
    if (!root.userSessions || typeof root.userSessions !== 'object' || Array.isArray(root.userSessions)) throw new Error('Datenbank: ungültige Sitzungen');
    for (const [key, session] of Object.entries(root.userSessions)) put('user_sessions', [key, JSON.stringify(session)]);
    root.userSessions = {};
  }
  if (Object.hasOwn(root, 'events')) {
    array(root.events).forEach((event, i) => {
      const eventId = identity(event.id);
      for (const kind of EVENT_COLLECTIONS) if (Object.hasOwn(event, kind)) {
        array(event[kind]).forEach((item, j) => put('event_items', [eventId, kind, identity(kind === 'attendees' ? item.personId : item.id), j, JSON.stringify(item)]));
        event[kind] = [];
      }
      if (Object.hasOwn(event, 'orders')) {
        array(event.orders).forEach((order, j) => {
          const orderId = identity(order.id);
          if (Object.hasOwn(order, 'tickets')) {
            array(order.tickets).forEach((ticket, k) => put('tickets', [eventId, orderId, identity(ticket.id), k, JSON.stringify(ticket)]));
            order.tickets = [];
          }
          put('orders', [eventId, orderId, j, JSON.stringify(order)]);
        });
        event.orders = [];
      }
      put('events', [eventId, i, JSON.stringify(event)]);
    });
    root.events = [];
  }
  for (const [key, value] of Object.entries(root)) put('root_state', [key, JSON.stringify(value)]);
  return rows;
}

function validateSchema(sql) {
  if (sql.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID
    || sql.prepare('PRAGMA user_version').get().user_version !== SCHEMA_VERSION) throw new Error('Unbekannte SQLite-Datenbank oder Schema-Version');
}
function readState(sql) {
  const root = Object.fromEntries(sql.prepare('SELECT key,payload FROM root_state').all().map((row) => [row.key, JSON.parse(row.payload)]));
  for (const name of GLOBAL_COLLECTIONS) if (Object.hasOwn(root, name)) root[name] = sql.prepare(`SELECT payload FROM ${name} ORDER BY position`).all().map((row) => JSON.parse(row.payload));
  if (Object.hasOwn(root, 'userSessions')) root.userSessions = Object.fromEntries(sql.prepare('SELECT token_hash,payload FROM user_sessions').all().map((row) => [row.token_hash, JSON.parse(row.payload)]));
  if (Object.hasOwn(root, 'events')) {
    root.events = sql.prepare('SELECT payload FROM events ORDER BY position').all().map((row) => JSON.parse(row.payload));
    const events = new Map(root.events.map((event) => [event.id, event])), orders = new Map();
    for (const row of sql.prepare('SELECT event_id,kind,payload FROM event_items ORDER BY position').all()) events.get(row.event_id)[row.kind].push(JSON.parse(row.payload));
    for (const row of sql.prepare('SELECT event_id,id,payload FROM orders ORDER BY position').all()) {
      const order = JSON.parse(row.payload); events.get(row.event_id).orders.push(order); orders.set(JSON.stringify([row.event_id, row.id]), order);
    }
    for (const row of sql.prepare('SELECT event_id,order_id,payload FROM tickets ORDER BY position').all()) orders.get(JSON.stringify([row.event_id, row.order_id])).tickets.push(JSON.parse(row.payload));
  }
  return root;
}
function check(sql) {
  if (sql.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || sql.prepare('PRAGMA foreign_key_check').all().length) throw new Error('SQLite-Integritätsprüfung fehlgeschlagen');
}
function readSnapshot(filename) {
  const sql = new DatabaseSync(filename, { readOnly: true });
  try {
    validateSchema(sql); sql.exec('BEGIN');
    if (sql.prepare("SELECT value FROM storage_meta WHERE key='initialization'").get()?.value !== 'ready') throw new Error('SQLite-Datenbank noch nicht initialisiert');
    check(sql);
    const data = readState(sql); sql.exec('COMMIT'); return data;
  } finally { sql.close(); }
}

function openStore(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, 'db.sqlite'), lockfile = path.join(directory, 'db.writer.sqlite');
  let lock, sql;
  try {
    // Separater SQLite-OS-Lock: kein zweiter Prozess mit veraltetem Arbeitsspeicher; nach Crash automatisch frei.
    lock = new DatabaseSync(lockfile);
    lock.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS writer_lock (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE');
    fs.chmodSync(lockfile, 0o600);
  } catch (err) {
    if (lock) lock.close();
    throw new Error('Datenbank-Schreibzugriff nicht verfügbar. Es darf nur eine App-Instanz pro Datenverzeichnis laufen.', { cause: err });
  }
  try {
    const existed = fs.existsSync(filename);
    sql = new DatabaseSync(filename);
    fs.chmodSync(filename, 0o600);
    sql.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');
    const applicationId = sql.prepare('PRAGMA application_id').get().application_id;
    const version = sql.prepare('PRAGMA user_version').get().user_version;
    if (!applicationId && !version && !sql.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) {
      if (existed) throw new Error('Vorhandene SQLite-Datei ist leer oder nicht initialisiert; kein automatischer Rückfall auf altes JSON');
      sql.exec('BEGIN IMMEDIATE');
      try { sql.exec(SCHEMA); sql.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION}; COMMIT`); }
      catch (err) { sql.exec('ROLLBACK'); throw err; }
    }
    validateSchema(sql);
    sql.exec('PRAGMA journal_mode=WAL');
    check(sql);
    let revision = Number(sql.prepare("SELECT value FROM storage_meta WHERE key='revision'").get()?.value || 0);
    const initialization = sql.prepare("SELECT value FROM storage_meta WHERE key='initialization'").get()?.value;
    if (!Number.isSafeInteger(revision) || revision < 0 || (revision > 0 ? initialization !== 'ready' : initialization !== 'pending')) throw new Error('Ungültiger SQLite-Initialisierungsstand');
    let cached = revision ? plan(readState(sql)) : new Map(TABLES.map((table) => [table.name, new Map()]));
    const statements = TABLES.map((table) => ({ ...table,
      upsert: sql.prepare(`INSERT INTO ${table.name} (${table.columns.join(',')}) VALUES (${table.columns.map(() => '?').join(',')}) ON CONFLICT (${table.keys.join(',')}) DO UPDATE SET ${table.columns.filter((column) => !table.keys.includes(column)).map((column) => `${column}=excluded.${column}`).join(',')}`),
      remove: sql.prepare(`DELETE FROM ${table.name} WHERE ${table.keys.map((column) => `${column}=?`).join(' AND ')}`),
    }));
    function save(state, importHash, verify = false) {
      const next = plan(state);
      sql.exec('BEGIN IMMEDIATE');
      try {
        const actual = Number(sql.prepare("SELECT value FROM storage_meta WHERE key='revision'").get()?.value || 0);
        if (actual !== revision) throw new Error('Datenbank wurde außerhalb der laufenden App geändert; Neustart erforderlich');
        for (const table of [...statements].reverse()) for (const [key, row] of cached.get(table.name)) if (!next.get(table.name).has(key)) table.remove.run(...table.keys.map((column) => row[table.columns.indexOf(column)]));
        for (const table of statements) for (const [key, row] of next.get(table.name)) if (JSON.stringify(cached.get(table.name).get(key)) !== JSON.stringify(row)) table.upsert.run(...row);
        sql.prepare("INSERT INTO storage_meta (key,value) VALUES ('revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(revision + 1));
        if (importHash) {
          sql.prepare("INSERT INTO storage_meta (key,value) VALUES ('json_import_sha256',?)").run(importHash);
          sql.prepare("INSERT INTO storage_meta (key,value) VALUES ('json_imported_at',?)").run(new Date().toISOString());
        }
        if (!revision) sql.prepare("UPDATE storage_meta SET value='ready' WHERE key='initialization'").run();
        if (verify && !isDeepStrictEqual(readState(sql), JSON.parse(JSON.stringify(state)))) throw new Error('JSON-/SQLite-Migrationsvergleich fehlgeschlagen');
        sql.exec('COMMIT'); revision++; cached = next;
      } catch (err) { sql.exec('ROLLBACK'); throw err; }
    }
    if (!revision) {
      const legacy = path.join(directory, 'db.json');
      const source = fs.existsSync(legacy) ? fs.readFileSync(legacy) : null;
      const data = source ? JSON.parse(source.toString('utf8')) : { tournaments: [] };
      save(data, source ? crypto.createHash('sha256').update(source).digest('hex') : null, true);
      if (source) console.log('Datenbank einmalig von JSON nach SQLite übernommen; ursprüngliche db.json bleibt unverändert.');
    }
    return { filename, data: readState(sql), save, close() {
      if (!sql) return;
      try { sql.close(); } finally { sql = null; lock.close(); }
    } };
  } catch (err) {
    if (sql) sql.close(); lock.close(); throw err;
  }
}

async function backupSnapshot(filename, destination) {
  const target = path.resolve(destination);
  if (fs.existsSync(target)) throw new Error('Sicherungsziel existiert bereits; wird nicht überschrieben');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = fs.mkdtempSync(path.join(path.dirname(target), '.sqlite-backup-'));
  fs.chmodSync(temp, 0o700);
  const staging = path.join(temp, 'snapshot.sqlite');
  let sql;
  try {
    sql = new DatabaseSync(filename, { readOnly: true }); validateSchema(sql);
    await backup(sql, staging); sql.close(); sql = null;
    const snapshot = new DatabaseSync(staging);
    try {
      snapshot.exec('PRAGMA journal_mode=DELETE');
      if (snapshot.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Sicherungsprüfung fehlgeschlagen');
    } finally { snapshot.close(); }
    readSnapshot(staging); fs.chmodSync(staging, 0o600);
    fs.linkSync(staging, target); // atomare Veröffentlichung, kein Überschreiben eines bestehenden Ziels
  } finally {
    if (sql) sql.close();
    for (const file of ['snapshot.sqlite', 'snapshot.sqlite-wal', 'snapshot.sqlite-shm', 'snapshot.sqlite-journal']) {
      const candidate = path.join(temp, file); if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
    }
    fs.rmdirSync(temp);
  }
}

module.exports = { openStore, readSnapshot, backupSnapshot };
