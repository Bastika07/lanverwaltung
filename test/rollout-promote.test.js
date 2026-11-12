'use strict';
// promote.sh hängt am eingeschränkten SSH-Schlüssel (authorized_keys mit command=…): Die Prüfung von
// SSH_ORIGINAL_COMMAND ist die einzige Grenze zu einem root-Befehl. Ohne Host: docker und logger sind Attrappen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '../ops/rollout/promote.sh');

function setup(t) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'lan-promote-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  // docker: merkt sich den Aufruf und meldet „kein Container“; logger: schreibt nichts ins Journal
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\necho "$*" >>"${root}/docker-calls"\nexit 1\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'logger'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const config = path.join(root, 'rollout.conf');
  fs.writeFileSync(config, ['DEV_STACK', 'DEV_PROJECT', 'DEV_CONTAINER', 'DEV_IMAGE', 'DEV_BACKUPS', 'PROD_STACK', 'PROD_PROJECT',
    'PROD_CONTAINER', 'PROD_IMAGE', 'PROD_VOLUME', 'PROD_BACKUPS'].map((key) => `${key}=${root}/${key.toLowerCase()}`)
    .concat('DEV_HEALTH_URL=https://dev.example.invalid/api/health', 'PROD_DOMAIN=https://lan.example.invalid').join('\n') + '\n');
  const run = (command) => spawnSync('bash', [script], { encoding: 'utf8', env: {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, ROLLOUT_CONFIG: config, SSH_ORIGINAL_COMMAND: command } });
  const dockerCalled = () => fs.existsSync(path.join(root, 'docker-calls'));
  return { run, dockerCalled };
}

test('promote.sh: per SSH nur status, rollback und promote <Commit> – alles andere bricht vor docker ab', (t) => {
  const { run, dockerCalled } = setup(t);
  const rejected = ['ls', 'id', 'promote abc; id', 'promote abcdef1; id', 'promote abcdef1 && id', 'promote $(id)',
    'promote `id`', 'status\nls', 'status; id', 'status x', ' status', 'rollback | sh', 'promote ABCDEF1', 'promote abcdef',
    'promote abcdef1 x', 'promote  abcdef1', 'promote ' + 'a'.repeat(41), 'promote ../../x', 'bash -c status'];
  for (const command of rejected) {
    const result = run(command);
    assert.equal(result.status, 1, `abgelehnt: ${JSON.stringify(command)}`);
    assert.match(result.stdout, /^ABBRUCH: nicht erlaubter Befehl$/m, JSON.stringify(command));
  }
  assert.equal(dockerCalled(), false, 'abgelehnte Befehle dürfen docker nicht anfassen');
});

test('promote.sh: status per SSH ist erlaubt und meldet einen fehlenden Container, statt abzubrechen', (t) => {
  const { run, dockerCalled } = setup(t);
  const result = run('status');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Produktion: nicht gestartet$/m);
  assert.match(result.stdout, /^Aktives Event: nicht ermittelbar$/m);
  assert.equal(dockerCalled(), true);
});
