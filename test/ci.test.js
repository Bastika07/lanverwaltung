'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectTests } = require('../ops/run-tests.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('CI: code checks reject malformed JavaScript and invalid project JSON', (t) => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'lan-ci-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'ops'));
  fs.copyFileSync(path.join(__dirname, '../ops/check-code.cjs'), path.join(root, 'ops/check-code.cjs'));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'ops/assessment-api.json'), '{}');
  const run = () => spawnSync(process.execPath, [path.join(root, 'ops/check-code.cjs')], { encoding: 'utf8' });
  assert.equal(run().status, 0);
  fs.writeFileSync(path.join(root, 'bad.js'), 'const = ;');
  assert.notEqual(run().status, 0, 'syntax errors must fail CI');
  fs.unlinkSync(path.join(root, 'bad.js'));
  fs.writeFileSync(path.join(root, 'package.json'), '{broken');
  assert.notEqual(run().status, 0, 'invalid JSON must fail CI');
});

test('CI: unit and integration suites form a disjoint, complete partition', () => {
  const files = ['website.test.js', 'ci.test.js', 'storage.test.js', 'markdown.test.js', 'future.test.js', 'catering.test.js'];
  const unit = selectTests(files, 'unit'), integration = selectTests(files, 'integration');
  assert.deepEqual(unit, ['ci.test.js', 'markdown.test.js', 'website.test.js']);
  assert.deepEqual(integration, ['catering.test.js', 'future.test.js', 'storage.test.js']);
  assert.deepEqual([...unit, ...integration].sort(), [...files].sort());
  assert.ok(unit.every((file) => !integration.includes(file)));
});

test('CI: unknown suite names and empty suites fail instead of silently passing', () => {
  assert.throws(() => selectTests(['ci.test.js'], 'typo'), /Unknown test suite/);
  assert.throws(() => selectTests(['storage.test.js'], 'unit'), /No tests/);
});
