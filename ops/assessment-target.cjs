'use strict';
// Nur für kurzlebige Scanner-Container --network none; keine Produktionskonfiguration.
const fs = require('node:fs');
const { isolated } = require('../test-support/isolated.cjs');
const cleanup = [];
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  for (const fn of cleanup) await fn();
  process.exit(process.exitCode || 0);
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
setTimeout(stop, 10 * 60000).unref();
isolated({ after: (fn) => cleanup.push(fn) }, { port: 3000 }).then((app) => {
  fs.writeFileSync('/tmp/assessment-cookie', app.cookieFor('buyer'), { mode: 0o600 });
  console.log(`Synthetic scanner target ready: ${app.base}`);
}).catch(async (err) => { console.error(err.message); process.exitCode = 1; await stop(); });
