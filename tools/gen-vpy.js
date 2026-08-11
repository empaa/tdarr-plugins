#!/usr/bin/env node
'use strict';

// Generate the production .vpy for a source file, for validation runs
// (tools/validate-scoped-runup.sh) and manual inspection.
//
//   node tools/gen-vpy.js <input.mkv> <lwi-cache> [runupFrames] > source.vpy

const { buildSourceVpy } = require('../src/shared/vsSource.js');

const [input, cache, runup] = process.argv.slice(2);
if (!input || !cache) {
  console.error('usage: gen-vpy.js <input.mkv> <lwi-cache> [runupFrames]');
  process.exit(2);
}
process.stdout.write(buildSourceVpy({
  inputPath: input,
  cachePath: cache,
  ...(runup === undefined ? {} : { runupFrames: Number(runup) }),
}));
