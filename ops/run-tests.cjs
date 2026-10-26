'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// New tests default to integration so they cannot be silently omitted from CI.
const unitFiles = new Set(['ci.test.js', 'catering-render.test.js', 'markdown.test.js',
  'privacy.test.js', 'render-security.test.js', 'website.test.js']);
function selectTests(files, suite) {
  if (!['unit', 'integration'].includes(suite)) throw new Error(`Unknown test suite: ${suite}`);
  const selected = files.filter((file) => unitFiles.has(file) === (suite === 'unit')).sort();
  if (!selected.length) throw new Error(`No tests in suite: ${suite}`);
  return selected;
}
if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const files = fs.readdirSync(path.join(root, 'test'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js')).map((entry) => entry.name);
  const selected = selectTests(files, process.argv[2]);
  console.log(`${process.argv[2]}: ${selected.join(', ')}`);
  const result = spawnSync(process.execPath, ['--test', ...selected.map((file) => path.join('test', file))],
    { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
module.exports = { selectTests };
