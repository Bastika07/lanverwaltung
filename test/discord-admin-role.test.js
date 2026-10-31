'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isolated } = require('../test-support/isolated.cjs');

const roleId = '123456789012345678', otherId = '223456789012345678';
function fixture() {
  // Keine OAuth-Geheimnisse oder Timer der Hostumgebung übernehmen.
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/accounts.js'), 'utf8'), {
    module, require, process: { env: {} }, setInterval: () => ({ unref() {} })
  });
  const settings = { adminRole: roleId };
  const member = { roles: [otherId] };
  const roles = [{ id: roleId, name: 'Orga', permissions: '0' }, { id: otherId, name: 'Orga', permissions: '0' }];
  const guild = { owner_id: 'owner' };
  const Discord = { enabled: true, GUILD: 'synthetic-guild', async call(method, url) {
    assert.equal(method, 'GET');
    if (url.endsWith('/roles')) return roles;
    if (url.includes('/members/')) return member;
    if (url === '/guilds/synthetic-guild') return guild;
    throw new Error('Unerwarteter Testaufruf');
  } };
  const accounts = module.exports({ db: {}, settings: () => settings, Discord });
  return { accounts, settings, member, roles, Discord };
}

test('Discord-Adminrolle: gleichnamige fremde Rollen gewähren keine Rechte; die eindeutige ID schon', async () => {
  const { accounts, member, roles, settings } = fixture();
  assert.equal(await accounts.isDiscordAdmin('user'), false);
  member.roles = [roleId];
  assert.equal(await accounts.isDiscordAdmin('user'), true);
  roles[0].name = 'Umbenannt';
  assert.equal(await accounts.isDiscordAdmin('user'), true);
  member.roles = [];
  assert.equal(await accounts.isDiscordAdmin('user'), false);
  member.roles = [otherId];
  settings.adminRole = 'Orga';
  await assert.rejects(accounts.isDiscordAdmin('user'), { code: 'ADMIN_ROLE_CONFIG' });
});

test('Discord-Adminrolle: alte Namen und unbekannte IDs bleiben gesperrt und erhalten eine klare Warnung', async () => {
  const { accounts, settings, member } = fixture();
  member.roles = [otherId];
  for (const invalid of ['Orga', 'orga', '123', '0', '<@&123456789012345678>', '323456789012345678']) {
    settings.adminRole = invalid;
    assert.ok(await accounts.adminRoleWarning());
    await assert.rejects(accounts.isDiscordAdmin('user'), { code: 'ADMIN_ROLE_CONFIG' });
    assert.equal(settings.adminRole, invalid, 'Keine automatische Namensmigration oder verdeckte Konfigurationsänderung');
  }
  settings.adminRole = roleId;
  assert.equal(await accounts.adminRoleWarning(), '');
  settings.adminRole = '';
  assert.equal(await accounts.adminRoleWarning(), '');
  assert.equal(await accounts.isDiscordAdmin('user'), false);
});

test('Discord-Adminrolle: Owner und Administrator bleiben berechtigt, fehlender Bot und Nichtmitglieder nicht', async () => {
  const { accounts, settings, roles, Discord } = fixture();
  settings.adminRole = 'veralteter Name';
  assert.equal(await accounts.isDiscordAdmin('owner'), true);
  roles[1].permissions = '8';
  assert.equal(await accounts.isDiscordAdmin('user'), true);
  Discord.enabled = false;
  assert.equal(await accounts.isDiscordAdmin('owner'), false);
  Discord.enabled = true;
  Discord.call = async () => { throw Object.assign(new Error('Nicht gefunden'), { status: 404 }); };
  assert.equal(await accounts.isDiscordAdmin('user'), false);
  Discord.call = async () => { throw new Error('Synthetischer Discord-Ausfall'); };
  await assert.rejects(accounts.isDiscordAdmin('user'), /Discord-Ausfall/);
  settings.adminRole = roleId;
  assert.match(await accounts.adminRoleWarning(), /nicht geprüft/);
});

test('Adminrollen-Einstellungen: Legacy-Warnung, bewusste ID-Korrektur und atomare Ablehnung von Rollennamen', async (t) => {
  const app = await isolated(t, { prepare(db) { db.meta.settings.adminRole = 'Orga'; } });
  const read = () => app.request('/api/settings', { admin: true });
  assert.match((await read()).data.adminRoleWarning, /Rollennamen/);
  const before = app.snapshot();
  for (const adminRole of ['Orga', '123', '123456789012345678901', '<@&123456789012345678>', { bad: true }]) {
    const r = await app.request('/api/settings', { method: 'PUT', admin: true, body: { adminRole, beamerSeconds: 99 } });
    assert.equal(r.status, 400, r.text);
    assert.deepEqual(app.snapshot(), before);
  }
  const r = await app.request('/api/settings', { method: 'PUT', admin: true, body: { adminRole: roleId } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.data.adminRole, roleId);
  assert.match(r.data.adminRoleWarning, /ohne Discord-Bot/);
  assert.equal(app.snapshot().meta.settings.adminRole, roleId);
  const clear = await app.request('/api/settings', { method: 'PUT', admin: true, body: { adminRole: '' } });
  assert.equal(clear.status, 200, clear.text);
  assert.equal(clear.data.adminRoleWarning, '');
  assert.equal((await app.request('/api/settings', { method: 'PUT', user: 'buyer', body: { adminRole: roleId } })).status, 401);
});

test('Adminrollen-Oberfläche: Rollen-ID und Konfigurationswarnung werden sicher angezeigt', async () => {
  const nodes = new Map();
  const context = vm.createContext({ adminViews: {}, adminTabs: () => '', adminEvent: () => null,
    location: { host: 'test.invalid' }, document: { getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, {});
      return nodes.get(id);
    } }, api: async () => ({ adminRole: '"><img src=x>', adminRoleWarning: '<style>fremd</style>', modules: {}, dmx: {} }) });
  const encoder = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8').split('\n').find((line) => line.startsWith('const esc ='));
  assert.ok(encoder);
  vm.runInContext(encoder, context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/settings.js'), 'utf8'), context);
  await context.adminViews.einstellungen.render();
  const html = nodes.get('app').innerHTML;
  assert.match(html, /eindeutige Rollen-ID/);
  assert.match(html, /pattern="\[1-9\]\[0-9\]\{16,19\}"/);
  assert.match(html, /&lt;style&gt;fremd&lt;\/style&gt;/);
  assert.ok(!/<(?:img|style)\b/i.test(html));
});
