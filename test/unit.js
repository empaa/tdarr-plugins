// test/unit.js
'use strict';

// Pure-logic unit tests for plugin code. These run WITHOUT a live Tdarr server.

const path = require('path');
const fs = require('fs');
const os = require('os');

const SRC = path.join(__dirname, '..', 'src');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Replace shared/processManager with a stub so spawnAsync "runs" mkvmerge by
// creating the -o output file and returning success, with no real subprocess.
function injectProcessManagerStub() {
  const pmPath = require.resolve(path.join(SRC, 'shared', 'processManager.js'));
  require.cache[pmPath] = {
    id: pmPath,
    filename: pmPath,
    loaded: true,
    exports: {
      createProcessManager: () => ({
        spawnAsync: async (_bin, spawnArgs) => {
          const oi = spawnArgs.indexOf('-o');
          const out = oi >= 0 ? spawnArgs[oi + 1] : null;
          if (out) fs.writeFileSync(out, 'stub-output');
          return 0;
        },
        cleanup: () => {},
        installCancelHandler: () => {},
        killAll: () => {},
        startPpidWatcher: () => {},
      }),
    },
  };
}

// Regression test for the output-propagation bug (job asArvTWPg): after a
// successful remux, the working file (_id) handed to the next plugin MUST be
// the sanitized output, not the original library file. Otherwise the encoder
// re-muxes all original audio/subtitle tracks.
async function sanitizeReturnsSanitizedFileAsWorkingFile() {
  injectProcessManagerStub();
  const { plugin } = require(path.join(SRC, 'sanitizeFile', 'index.js'));

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanitize-unit-'));
  const originalPath = '/mnt/media/movies/Example (2020)/Example (2020) - [Remux-1080p].mkv';

  const inputFileObj = {
    _id: originalPath,
    file: originalPath,
    DB: 'testDB',
    footprintId: 'testFP',
    container: 'mkv',
    ffProbeData: {
      streams: [
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'audio', codec_name: 'truehd', channels: 6, tags: { language: 'eng' } },
        { index: 2, codec_type: 'audio', codec_name: 'ac3', channels: 6, tags: { language: 'ger' } },
        { index: 3, codec_type: 'audio', codec_name: 'ac3', channels: 6, tags: { language: 'fre' } },
        { index: 4, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } },
        { index: 5, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'ger' } },
      ],
    },
  };

  let scanCalled = false;
  const args = {
    inputs: {},
    inputFileObj,
    workDir,
    variables: { marker: 'unit' },
    jobLog: () => {},
    updateWorker: () => {},
    // Mirrors the real scanIndividualFile, which resolves the canonical record
    // and returns _id = original path. The fix must NOT depend on this.
    scanIndividualFile: async () => {
      scanCalled = true;
      return { _id: originalPath, file: originalPath };
    },
  };

  const expectedOutput = path.join(workDir, 'Example (2020) - [Remux-1080p].sanitized.mkv');

  let result;
  try {
    result = await plugin(args);
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  }

  assert(result.outputNumber === 1, `expected outputNumber 1, got ${result.outputNumber}`);
  assert(
    result.outputFileObj._id === expectedOutput,
    `working file _id must be the sanitized output, not the original\n`
      + `  expected: ${expectedOutput}\n`
      + `  actual:   ${result.outputFileObj._id}`,
  );
  assert(
    result.outputFileObj._id !== originalPath,
    'working file _id reverted to the original library path (tracks would survive)',
  );
}

const TESTS = [
  ['sanitizeFile: returns sanitized file as working file', sanitizeReturnsSanitizedFileAsWorkingFile],
];

async function unitTest(filterPlugin) {
  const targets = filterPlugin
    ? TESTS.filter(([name]) => name.toLowerCase().includes(filterPlugin.toLowerCase()))
    : TESTS;

  let failures = 0;
  for (const [name, fn] of targets) {
    try {
      await fn();
      console.log(`unit: ${name} .............. ok`);
    } catch (err) {
      console.log(`unit: ${name} .............. FAIL`);
      console.log(`      ${String(err && err.message || err).replace(/\n/g, '\n      ')}`);
      failures++;
    }
  }
  return failures;
}

if (require.main === module) {
  const filterPlugin = process.argv[2] || null;
  unitTest(filterPlugin).then((failures) => {
    process.exit(failures > 0 ? 1 : 0);
  }).catch((err) => {
    console.error('Unit test error:', err.message);
    process.exit(1);
  });
}

module.exports = { unitTest };
