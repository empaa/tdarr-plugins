// test/run.js
'use strict';

const { smokeTest } = require('./smoke.js');
const { e2eTest } = require('./e2e.js');

const args = process.argv.slice(2);
let mode = 'all';
let filterPlugin = null;

for (const arg of args) {
  if (arg === '--smoke') mode = 'smoke';
  else if (arg === '--e2e') mode = 'e2e';
  else filterPlugin = arg;
}

async function run() {
  let failures = 0;

  if (mode === 'all' || mode === 'smoke') {
    console.log('=== Smoke Tests ===\n');
    failures += await smokeTest(filterPlugin);
    console.log('');
  }

  if (mode === 'all' || mode === 'e2e') {
    console.log('=== E2E Tests ===\n');
    failures += await e2eTest(filterPlugin);
    console.log('');
  }

  process.exit(failures > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test runner error:', err.message);
  process.exit(1);
});
