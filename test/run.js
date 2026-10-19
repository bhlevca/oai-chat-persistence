'use strict';
// Runs every *.test.js in this directory in its own process.
const { execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
let failed = 0;

for (const file of files) {
  process.stdout.write(`\n=== ${file} ===`);
  try {
    process.stdout.write(execFileSync(process.execPath, [path.join(__dirname, file)], { encoding: 'utf8' }));
  } catch (err) {
    failed++;
    process.stdout.write(String(err.stdout || '') + String(err.stderr || ''));
  }
}

console.log(failed ? `\n${failed} of ${files.length} suite(s) failed` : `\nAll ${files.length} suites passed`);
process.exit(failed ? 1 : 0);
