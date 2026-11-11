'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { format } = require('node:util');
const { isolated } = require('../test-support/isolated.cjs');
const { discordSide } = require('../test-support/tournaments.cjs');

const source = () => fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8');
function actualFunction(name) {
  const match = source().match(new RegExp(`function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, `Actual server function ${name} must exist`);
  return match[0];
}

test('Discord task errors keep format markers in tournament names literal', async (t) => {
  const error = console.error;
  t.after(() => { console.error = error; });
  for (const marker of ['%s', '%d', '%j', '%%']) {
    const tournament = { id: 'synthetic', name: `Cup ${marker}` };
    const logs = [], logArguments = [];
    console.error = (...args) => { logArguments.push(args); logs.push(format(...args)); };
    const message = `Synthetic Discord failure ${marker}`;
    const fail = async () => { throw new Error(message); };
    const { side, saves, broadcasts } = discordSide({ event: { tournaments: [tournament] }, Discord: { enabled: true, sync: fail, remove: fail } });
    await side.sync(tournament);
    console.error = error;
    assert.deepEqual(logs, [`Discord (${tournament.name}): ${message}`]);
    assert.deepEqual(logArguments, [['Discord (%s): %s', tournament.name, message]]);
    assert.equal(tournament.discordStatus.state, 'error');
    assert.equal(tournament.discordStatus.error, message);
    assert.equal(saves.length, 1);
    assert.deepEqual(broadcasts, [['tournament', tournament.id]]);
  }
});

test('Discord task errors cannot forge log lines through tournament names', async (t) => {
  const error = console.error;
  t.after(() => { console.error = error; });
  const logs = [];
  console.error = (...args) => logs.push(format(...args));
  const tournament = { id: 'synthetic', name: 'Cup\n{"sec":"admin_login"}\r\u2028x' };
  const fail = async () => { throw new Error('Synthetic\nfailure'); };
  const { side } = discordSide({ event: { tournaments: [tournament] }, Discord: { enabled: true, sync: fail, remove: fail } });
  await side.sync(tournament);
  console.error = error;
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], /[\r\n\u2028\u2029]/);
  assert.equal(logs[0], 'Discord (Cup {"sec":"admin_login"}  x): Synthetic failure');
});

test('Admin password comparison accepts only the configured string and remains timing-safe', () => {
  const password = 'Synthetic-only-admin-password';
  const comparisons = [];
  const compare = vm.runInNewContext(`(${actualFunction('checkPassword')})`, {
    ADMIN_PASSWORD: password,
    crypto: { createHash: crypto.createHash, timingSafeEqual(a, b) {
      comparisons.push([a.length, b.length]);
      return crypto.timingSafeEqual(a, b);
    } },
  });
  assert.equal(compare(password), true);
  for (const input of ['', 'short', password + 'x', 'x'.repeat(4096), null, undefined, 0, {}, [], { toString: () => password }]) {
    assert.equal(compare(input), false);
  }
  assert.deepEqual(comparisons, Array.from({ length: 5 }, () => [32, 32]));
});

test('Disabled admin password access rejects every input without hashing', () => {
  for (const configured of [undefined, '']) {
    const compare = vm.runInNewContext(`(${actualFunction('checkPassword')})`, {
      ADMIN_PASSWORD: configured, crypto: { createHash() { assert.fail('Disabled login must not hash'); } },
    });
    for (const input of ['', 'Synthetic-only', null, {}, undefined]) assert.equal(compare(input), false);
  }
});

test('Password comparison digests are fresh local buffers, not logged, saved or returned', () => {
  const password = 'Synthetic-only-admin-password', pairs = [];
  const noSideEffect = () => assert.fail('Password comparison must not log or persist data');
  const context = vm.createContext({ ADMIN_PASSWORD: password,
    console: { log: noSideEffect, error: noSideEffect, warn: noSideEffect },
    fs: { writeFileSync: noSideEffect, appendFileSync: noSideEffect },
    save: noSideEffect, storage: { save: noSideEffect },
    crypto: { createHash: crypto.createHash, timingSafeEqual(a, b) {
      pairs.push([a, b]);
      return crypto.timingSafeEqual(a, b);
    } },
  });
  const keys = Object.keys(context);
  const compare = vm.runInContext(`(${actualFunction('checkPassword')})`, context);
  assert.equal(compare(password), true);
  assert.equal(compare('Synthetic-wrong-password'), false);
  assert.equal(pairs.length, 2);
  for (const pair of pairs) for (const digest of pair) {
    assert.ok(Buffer.isBuffer(digest));
    assert.equal(digest.length, 32);
  }
  assert.notStrictEqual(pairs[0][0], pairs[1][0]);
  assert.notStrictEqual(pairs[0][1], pairs[1][1]);
  assert.deepEqual(Object.keys(context), keys, 'No digest escapes into sandbox globals');
});

test('HTTP admin authentication retains CSRF, sessions, failure delay and ten-attempt IP limit', { timeout: 15000 }, async (t) => {
  // The fixture already made one successful login, using a synthetic random password.
  const app = await isolated(t);
  assert.equal((await app.request('/api/settings')).status, 401);
  assert.equal((await app.request('/api/settings', { admin: true })).status, 200);
  assert.equal((await app.request('/api/login', { method: 'POST', body: {}, headers: { Origin: 'https://foreign.invalid' } })).status, 403);
  const wrong = 'Synthetic-only-wrong-password';
  const before = performance.now();
  const attempts = await Promise.all(Array.from({ length: 9 }, (_, i) => app.request('/api/login', {
    method: 'POST', body: { password: wrong }, headers: { 'X-Forwarded-For': `192.0.2.${i + 1}` },
  })));
  for (const response of attempts) {
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('set-cookie'), null);
  }
  assert.ok(performance.now() - before >= 750, 'The existing 800ms failure delay is still active');
  const limited = await app.request('/api/login', { method: 'POST', body: { password: wrong } });
  assert.equal(limited.status, 429);
  const retryAfter = Number(limited.headers.get('retry-after'));
  assert.ok(retryAfter > 0 && retryAfter <= 900, 'The existing 15-minute rate-limit window is retained');
  await assert.rejects(app.login(), /Isolated admin login failed/, 'A correct password cannot bypass the exhausted IP limit');
  assert.equal((await app.request('/api/me', { admin: true })).data.admin, true);
  assert.equal((await app.request('/api/logout', { method: 'POST', admin: true, body: {} })).status, 200);
  assert.equal((await app.request('/api/me', { admin: true })).data.admin, false);
  const digest = crypto.createHash('sha256').update(wrong).digest('hex');
  for (const output of [app.logs(), JSON.stringify(app.snapshot())]) {
    assert.ok(!output.includes(wrong));
    assert.ok(!output.includes(digest));
  }
});
