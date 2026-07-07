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

// ---- commentary-track handling (keep_commentary_tracks) ----
const { categorizeStreams, selectAudio, selectSubtitles, isCommentary } =
  require(path.join(SRC, 'sanitizeFile', 'index.js'));

const aud = (lang, codec, channels, title, disp) =>
  ({ codec_type: 'audio', codec_name: codec, channels, tags: { language: lang, title }, disposition: disp || {} });
const sub = (lang, codec, title, disp) =>
  ({ codec_type: 'subtitle', codec_name: codec, tags: { language: lang, title }, disposition: disp || {} });

// Oldboy-like: 1 Korean main DTS-HD MA + Korean & English commentaries (some by title, some flagged)
const oldboyAudio = () => categorizeStreams([
  { codec_type: 'video', codec_name: 'h264' },
  aud('kor', 'dts', 6, 'DTS-HD MA 5.1'),                                // 1 main
  aud('kor', 'ac3', 2, 'Commentary by director Park Chan-wook'),       // 2 commentary (title)
  aud('kor', 'ac3', 2, 'Commentary by director and cinematographer'),  // 3 commentary (title)
  aud('kor', 'ac3', 2, 'Commentary by director and actors'),           // 4 commentary (title)
  aud('eng', 'ac3', 2, 'Commentary by critic Jasper Sharp'),           // 5 commentary (title)
  aud('kor', 'ac3', 2, 'Commentary by Shin', { comment: 1 }),          // 6 commentary (flag)
  aud('kor', 'ac3', 2, 'Commentary by Kim', { comment: 1 }),           // 7 commentary (flag)
  aud('eng', 'ac3', 2, 'Commentary by Harry', { comment: 1 }),         // 8 commentary (flag)
]).audio;

const oldboySubs = () => categorizeStreams([
  { codec_type: 'video', codec_name: 'h264' },
  sub('eng', 'subrip', 'English'),                                       // 1 main
  sub('eng', 'subrip', 'Commentary by director'),                        // 2 commentary
  sub('swe', 'subrip', 'Swedish'),                                       // 3 main
  sub('fre', 'subrip', 'French'),                                        // 4 not wanted
  sub('eng', 'hdmv_pgs_subtitle', 'English SDH', { hearing_impaired: 1 }), // 5 SDH (not commentary)
  sub('eng', 'hdmv_pgs_subtitle', 'English Forced', { forced: 1 }),      // 6 forced (not commentary)
]).subtitle;

const idxset = (sel) => new Set(sel.map((t) => t.idx));
const ADD = ['eng', 'swe', 'nor', 'nob'];

async function audioDropsCommentariesWhenOff() {
  const s = idxset(selectAudio(oldboyAudio(), 'kor', ADD, false));
  assert(s.size === 1 && s.has(1), `expected only Korean main [1], got [${[...s]}]`);
}

async function audioKeepsAdditionalLangCommentariesWhenOn() {
  const s = idxset(selectAudio(oldboyAudio(), 'kor', ADD, true));
  assert(s.has(1) && s.has(5) && s.has(8), `expected main + English commentaries {1,5,8}, got [${[...s]}]`);
  assert(![2, 3, 4, 6, 7].some((i) => s.has(i)),
    `Korean commentaries must be dropped (kor not in audio_language), got [${[...s]}]`);
}

async function subtitlesDropCommentaryKeepSdhForcedWhenOff() {
  const s = idxset(selectSubtitles(oldboySubs(), 'kor', ADD, false));
  assert(s.has(1) && s.has(3) && s.has(5) && s.has(6), `expected main + SDH + forced {1,3,5,6}, got [${[...s]}]`);
  assert(!s.has(2), 'commentary subtitle must be dropped when option off');
  assert(!s.has(4), 'non-wanted-language subtitle must be dropped');
}

async function subtitlesKeepCommentaryWhenOn() {
  const s = idxset(selectSubtitles(oldboySubs(), 'kor', ADD, true));
  assert(s.has(2), 'commentary subtitle in a wanted language must be kept when option on');
}

async function commentaryDetection() {
  assert(isCommentary({ tags: { title: 'Commentary by critic Jasper Sharp' } }) === true, 'title-based commentary not detected');
  assert(isCommentary({ disposition: { comment: 1 } }) === true, 'comment disposition not detected');
  assert(isCommentary({ disposition: { hearing_impaired: 1 }, tags: { title: 'English SDH' } }) === false, 'SDH wrongly flagged as commentary');
  assert(isCommentary({ disposition: { forced: 1 } }) === false, 'forced wrongly flagged as commentary');
  assert(isCommentary({ tags: { title: 'DTS-HD MA 5.1' } }) === false, 'main track wrongly flagged as commentary');
}

// ---- vsSource: lsmas/BestSource .vpy builder + source-failure gates ----
// (lazy-require inside each test so a missing module fails only these tests)

async function vsSourceLsmasLine() {
  const { buildSourceVpy } = require(path.join(SRC, 'shared', 'vsSource.js'));
  const vpy = buildSourceVpy({ sourceFilter: 'lsmas', inputPath: '/media/x.mkv', cachePath: '/tmp/s.lwi' });
  assert(vpy.startsWith('import vapoursynth as vs'), `must start with vs import:\n${vpy}`);
  assert(vpy.includes("src = core.lsmas.LWLibavSource(source='/media/x.mkv', cachefile='/tmp/s.lwi')"),
    `lsmas source line missing:\n${vpy}`);
  assert(!/AssumeFPS/.test(vpy), 'lsmas path must NOT add AssumeFPS (byte-identical to today)');
  assert(/src\.set_output\(\)\s*$/.test(vpy), `must end with src.set_output():\n${vpy}`);
}

async function vsSourceBestsourceWithFps() {
  const { buildSourceVpy } = require(path.join(SRC, 'shared', 'vsSource.js'));
  const vpy = buildSourceVpy({ sourceFilter: 'bestsource', inputPath: '/media/x.mkv', cachePath: '/tmp/bs', fpsNum: 24000, fpsDen: 1001 });
  assert(vpy.includes("src = core.bs.VideoSource(source='/media/x.mkv', cachepath='/tmp/bs')"),
    `bestsource line missing:\n${vpy}`);
  assert(vpy.includes('src = core.std.AssumeFPS(src, fpsnum=24000, fpsden=1001)'),
    `AssumeFPS relabel missing:\n${vpy}`);
}

async function vsSourceBestsourceNoFpsOmitsAssume() {
  const { buildSourceVpy } = require(path.join(SRC, 'shared', 'vsSource.js'));
  const vpy = buildSourceVpy({ sourceFilter: 'bestsource', inputPath: '/m.mkv', cachePath: '/tmp/bs', fpsNum: 0, fpsDen: 0 });
  assert(vpy.includes('core.bs.VideoSource'), 'bestsource line present');
  assert(!/AssumeFPS/.test(vpy), 'AssumeFPS must be omitted when fps is unknown/0');
}

async function vsSourceEscapesPath() {
  const { buildSourceVpy } = require(path.join(SRC, 'shared', 'vsSource.js'));
  const vpy = buildSourceVpy({ sourceFilter: 'lsmas', inputPath: "/media/a'b\\c.mkv", cachePath: '/tmp/s.lwi' });
  assert(vpy.includes("source='/media/a\\'b\\\\c.mkv'"), `path not Python-escaped:\n${vpy}`);
}

async function vsSourceDownscaleAfterSource() {
  const { buildSourceVpy } = require(path.join(SRC, 'shared', 'vsSource.js'));
  const { buildVsDownscaleLines } = require(path.join(SRC, 'shared', 'downscale.js'));
  const vpy = buildSourceVpy({
    sourceFilter: 'bestsource', inputPath: '/m.mkv', cachePath: '/tmp/bs',
    fpsNum: 24000, fpsDen: 1001, downscaleLines: buildVsDownscaleLines('1080p'),
  });
  const iSrc = vpy.indexOf('core.bs.VideoSource');
  const iFps = vpy.indexOf('AssumeFPS');
  const iDown = vpy.indexOf('core.resize.Lanczos');
  const iOut = vpy.indexOf('set_output');
  assert(iSrc >= 0 && iFps > iSrc && iDown > iFps && iOut > iDown,
    `ordering wrong: src=${iSrc} fps=${iFps} down=${iDown} out=${iOut}\n${vpy}`);
}

async function av1anReachedChunkingGate() {
  const { av1anReachedChunking } = require(path.join(SRC, 'shared', 'vsSource.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-gate-'));
  try {
    assert(av1anReachedChunking(dir) === false, 'no chunks.json => false (failed before chunking)');
    fs.writeFileSync(path.join(dir, 'chunks.json'), '[]');
    assert(av1anReachedChunking(dir) === true, 'chunks.json present => true (reached chunking)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function sceneDetectProducedScenesGate() {
  const { sceneDetectProducedScenes } = require(path.join(SRC, 'shared', 'vsSource.js'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-sc-'));
  try {
    const p = path.join(dir, 'scenes.json');
    assert(sceneDetectProducedScenes(p) === false, 'missing file => false');
    fs.writeFileSync(p, JSON.stringify({ frames: 0, scenes: [] }));
    assert(sceneDetectProducedScenes(p) === false, 'empty scenes => false (panic left it empty)');
    fs.writeFileSync(p, JSON.stringify({ frames: 100, scenes: [{ start_frame: 0, end_frame: 100 }] }));
    assert(sceneDetectProducedScenes(p) === true, 'non-empty scenes => true');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const TESTS = [
  ['vsSource: lsmas line, no AssumeFPS', vsSourceLsmasLine],
  ['vsSource: bestsource line + AssumeFPS from fps', vsSourceBestsourceWithFps],
  ['vsSource: bestsource omits AssumeFPS when fps unknown', vsSourceBestsourceNoFpsOmitsAssume],
  ['vsSource: escapes quotes/backslashes in path', vsSourceEscapesPath],
  ['vsSource: downscale lines after source+AssumeFPS', vsSourceDownscaleAfterSource],
  ['vsSource: av1anReachedChunking gate (chunks.json)', av1anReachedChunkingGate],
  ['vsSource: sceneDetectProducedScenes gate', sceneDetectProducedScenesGate],
  ['sanitizeFile: returns sanitized file as working file', sanitizeReturnsSanitizedFileAsWorkingFile],
  ['audio: drops commentaries when keep off', audioDropsCommentariesWhenOff],
  ['audio: keeps additional-lang commentaries when keep on', audioKeepsAdditionalLangCommentariesWhenOn],
  ['subtitles: drop commentary, keep SDH/forced when off', subtitlesDropCommentaryKeepSdhForcedWhenOff],
  ['subtitles: keep commentary when on', subtitlesKeepCommentaryWhenOn],
  ['isCommentary: title or flag, not SDH/forced', commentaryDetection],
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
