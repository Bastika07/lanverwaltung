'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectTests } = require('../ops/run-tests.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkRole } = require('../ops/check-dast.cjs');

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

test('CI: DAST akzeptiert nur vollständige rollenverifizierte Scans ohne mittlere/hohe Befunde', () => {
  const report = { site: [{ '@name': 'http://127.0.0.1:3000', alerts: [{ riskcode: '1', pluginid: '100001' }] }] };
  const coverage = { role: 'buyer', role_verified: true, active_scans: [{ progress: '100', reqCount: '250' }], message_count: '284' };
  assert.match(checkRole(report, coverage, 2, 'buyer'), /1 niedrige/);
  assert.match(checkRole({ site: [{ ...report.site[0], alerts: [] }] }, coverage, 0, 'buyer'), /0 niedrige/);
  for (const exit of [1, 3, 124, NaN]) assert.throws(() => checkRole(report, coverage, exit, 'buyer'), /fehlgeschlagen/);
  for (const change of [{ role: 'anonymous' }, { role_verified: false }, { role_verified: undefined }]) {
    assert.throws(() => checkRole(report, { ...coverage, ...change }, 2, 'buyer'), /Rollenprüfung/);
  }
  for (const change of [{ active_scans: [] }, { active_scans: [{ progress: '99', reqCount: '250' }] },
    { active_scans: [{ progress: '100', reqCount: '0' }] }, { message_count: 0 }]) {
    assert.throws(() => checkRole(report, { ...coverage, ...change }, 2, 'buyer'), /abgeschlossener/);
  }
  for (const riskcode of ['2', '3', 'unknown']) {
    assert.throws(() => checkRole({ site: [{ ...report.site[0], alerts: [{ riskcode }] }] }, coverage, 2, 'buyer'));
  }
  for (const invalid of [{}, { site: [] }, { site: [{ '@name': 'https://example.invalid', alerts: [] }] },
    { site: [{ '@name': 'http://127.0.0.1:3000' }] }]) {
    assert.throws(() => checkRole(invalid, coverage, 0, 'buyer'));
  }
});

test('CI: DAST-CLI meldet fehlende und beschädigte Berichte als Fehler', (t) => {
  const root = fs.mkdtempSync(path.join(process.env.OPENCODE_TEST_TMP || os.tmpdir(), 'lan-dast-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = () => spawnSync(process.execPath, [path.join(__dirname, '../ops/check-dast.cjs'), root], { encoding: 'utf8' });
  assert.equal(run().status, 1);
  for (const role of ['anonymous', 'buyer']) {
    fs.mkdirSync(path.join(root, role));
    fs.writeFileSync(path.join(root, `${role}.exit`), '2\n');
    fs.writeFileSync(path.join(root, role, 'report.json'), JSON.stringify({ site: [{ '@name': 'http://127.0.0.1:3000', alerts: [] }] }));
    fs.writeFileSync(path.join(root, role, 'coverage.json'), JSON.stringify({ role, role_verified: true,
      active_scans: [{ progress: '100', reqCount: '10' }], message_count: '20' }));
  }
  assert.equal(run().status, 0);
  fs.writeFileSync(path.join(root, 'buyer.exit'), '');
  assert.equal(run().status, 1);
  fs.writeFileSync(path.join(root, 'buyer.exit'), '2');
  fs.writeFileSync(path.join(root, 'buyer', 'report.json'), '{broken');
  assert.equal(run().status, 1);
});

test('CI: importierbares main-Ruleset verlangt CI und CodeQL ohne Bypass oder fremde Branches', () => {
  const ruleset = JSON.parse(fs.readFileSync(path.join(__dirname, '../.github/rulesets/main.json'), 'utf8'));
  assert.equal(ruleset.target, 'branch');
  assert.equal(ruleset.enforcement, 'active');
  assert.deepEqual(ruleset.conditions, { ref_name: { include: ['refs/heads/main'], exclude: [] } });
  assert.deepEqual(ruleset.bypass_actors, []);
  const rules = new Map(ruleset.rules.map((rule) => [rule.type, rule.parameters]));
  assert.equal(rules.size, ruleset.rules.length);
  assert.ok(rules.has('deletion') && rules.has('non_fast_forward'));
  assert.equal(rules.get('pull_request').required_approving_review_count, 0);
  assert.equal(rules.get('pull_request').required_review_thread_resolution, true);
  assert.deepEqual(rules.get('code_scanning').code_scanning_tools, [
    { tool: 'CodeQL', alerts_threshold: 'errors', security_alerts_threshold: 'medium_or_higher' }
  ]);
  const status = rules.get('required_status_checks');
  assert.equal(status.strict_required_status_checks_policy, true);
  assert.equal(status.do_not_enforce_on_create, false);
  const contexts = status.required_status_checks.map((check) => check.context);
  assert.equal(contexts.length, 15);
  assert.equal(new Set(contexts).size, contexts.length);
  assert.ok(status.required_status_checks.every((check) => check.integration_id === 15368));
  for (const [file, names] of [
    ['dast.yml', ['ZAP API (anonym und Käufer)']],
    ['container-security.yml', ['Docker build, smoke test and Trivy']]
  ]) {
    const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows', file), 'utf8');
    for (const name of names) { assert.ok(contexts.includes(name)); assert.ok(workflow.split(/\r?\n/).includes(`    name: ${name}`)); }
  }
  assert.ok(contexts.includes('Analyze (javascript-typescript)') && contexts.includes('Analyze (python)'));
});
