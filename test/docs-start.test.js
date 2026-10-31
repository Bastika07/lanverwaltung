'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const docs = ['README.md', 'AGENTS.md', 'server.js', '.env.example', 'docs/security-operations.md'];

function directStartCommand() {
  const match = read('README.md').match(/Ohne Docker[^\n]*\r?\n\r?\n```bash\r?\n([^\r\n]+)\r?\n```/);
  assert.ok(match, 'README must document the direct start without Docker');
  return match[1].replace(/\s+#.*$/, '').trim();
}

test('Documented start commands publish no admin password and bind to loopback', () => {
  const command = directStartCommand();
  assert.match(command, /^HOST=127\.0\.0\.1 node server\.js$/);
  for (const file of docs) {
    for (const [line] of read(file).matchAll(/^.*node server\.js.*$/gm)) {
      assert.doesNotMatch(line, /ADMIN_PASSWORD=\S/, `${file}: ${line}`);
      assert.match(line, /HOST=127\.0\.0\.1/, `${file}: ${line}`);
    }
  }
});

test('Documented emergency password file matches the generated file name', () => {
  const generated = read('server.js').match(/path\.join\(DATA_DIR, '([^']+)'\)/);
  assert.ok(generated, 'server.js must name the generated admin password file');
  assert.equal(generated[1], 'admin-password.txt');
  for (const file of ['README.md', 'AGENTS.md', 'docs/codeql-triage.md']) {
    for (const [name] of read(file).matchAll(/admin-password[\w.]*/g)) assert.equal(name, generated[1], file);
  }
});

test('Documented direct start runs on loopback and writes the emergency password file', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-docs-start-'));
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port; await new Promise((r) => probe.close(r));
  // Allowlist environment: no Discord, no admin password, only the documented HOST.
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: String(port), DATA_DIR: directory };
  for (const assignment of directStartCommand().split(' ').filter((part) => part.includes('='))) {
    const [key, value] = assignment.split('='); env[key] = value;
  }
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (b) => { logs += b; }); child.stderr.on('data', (b) => { logs += b; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise((r) => child.once('exit', r));
      child.kill(); const timer = setTimeout(() => child.kill('SIGKILL'), 2000); await stopped; clearTimeout(timer);
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Startup timeout: ' + logs)), 8000);
    child.stdout.on('data', () => { if (logs.includes('LAN-System läuft')) { clearTimeout(timer); resolve(); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Startup failed: ' + logs)); });
  });
  assert.match(logs, new RegExp(`LAN-System läuft auf http://127\\.0\\.0\\.1:${port}`));
  const passwordFile = path.join(directory, 'admin-password.txt');
  const password = fs.readFileSync(passwordFile, 'utf8').trim();
  assert.ok(password.length >= 12);
  assert.ok(!logs.includes(password), 'Generated password must not be logged');
  const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5000) });
  assert.equal(r.status, 200);
});
