'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// COPY übernimmt die Dateirechte des Build-Kontexts. Ohne chmod kann "node" bei restriktiven ACLs den Code nicht lesen.
test('Dockerfiles machen /app vor dem Wechsel zu "node" lesbar', () => {
  for (const file of ['Dockerfile', 'agent/Dockerfile']) {
    const lines = fs.readFileSync(path.join(__dirname, '..', file), 'utf8').split(/\r?\n/);
    const user = lines.findIndex((l) => /^USER node\b/.test(l));
    const chmod = lines.findIndex((l) => /^RUN chmod -R a\+rX \/app\b/.test(l));
    const lastCopy = lines.findLastIndex((l) => /^COPY\b/.test(l));
    assert.ok(user > 0, file);
    assert.ok(chmod > lastCopy && chmod < user, `${file}: chmod nach dem letzten COPY und vor USER node`);
  }
});
