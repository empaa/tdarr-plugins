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

// ---- vsSource: lsmas .vpy builder + source-failure gates ----
// (lazy-require inside each test so a missing module fails only these tests)

async function vsSourceLsmasLine() {
  const { buildSourceVpy } = require(path.join(SRC, 'shared', 'vsSource.js'));
  const vpy = buildSourceVpy({ inputPath: '/media/x.mkv', cachePath: '/tmp/s.lwi' });
  assert(vpy.startsWith('import vapoursynth as vs'), `must start with vs import:\n${vpy}`);
  assert(vpy.includes("src = core.lsmas.LWLibavSource(source='/media/x.mkv', cachefile='/tmp/s.lwi')"),
    `lsmas source line missing:\n${vpy}`);
  assert(/src\.set_output\(\)\s*$/.test(vpy), `must end with src.set_output():\n${vpy}`);
}

async function vsSourceEscapesPath() {
  const { buildSourceVpy } = require(path.join(SRC, 'shared', 'vsSource.js'));
  const vpy = buildSourceVpy({ inputPath: "/media/a'b\\c.mkv", cachePath: '/tmp/s.lwi' });
  assert(vpy.includes("source='/media/a\\'b\\\\c.mkv'"), `path not Python-escaped:\n${vpy}`);
}

async function vsSourceDownscaleAfterSource() {
  const { buildSourceVpy } = require(path.join(SRC, 'shared', 'vsSource.js'));
  const { buildVsDownscaleLines } = require(path.join(SRC, 'shared', 'downscale.js'));
  const vpy = buildSourceVpy({
    inputPath: '/m.mkv', cachePath: '/tmp/s.lwi',
    downscaleLines: buildVsDownscaleLines('1080p'),
  });
  const iSrc = vpy.indexOf('core.lsmas.LWLibavSource');
  const iDown = vpy.indexOf('core.resize.Lanczos');
  const iOut = vpy.indexOf('set_output');
  assert(iSrc >= 0 && iDown > iSrc && iOut > iDown,
    `ordering wrong: src=${iSrc} down=${iDown} out=${iOut}\n${vpy}`);
}

async function vsSourceRunupWrapsSource() {
  const { buildSourceVpy, RUNUP_FRAMES } = require(path.join(SRC, 'shared', 'vsSource.js'));
  const vpy = buildSourceVpy({ inputPath: '/m.mkv', cachePath: '/tmp/s.lwi' });
  assert(vpy.includes('core.std.ModifyFrame(src, [src] + _runup'),
    `run-up wrapper missing -- lsmas returns blank frames on cold seeks without it:\n${vpy}`);
  assert(vpy.includes(`for j in range(1, ${RUNUP_FRAMES + 1})`),
    `run-up depth must be RUNUP_FRAMES (${RUNUP_FRAMES}):\n${vpy}`);
  // The wrapper must sit on the decode, i.e. between the source and anything else.
  const iSrc = vpy.indexOf('core.lsmas.LWLibavSource');
  const iRunup = vpy.indexOf('core.std.ModifyFrame');
  const iOut = vpy.indexOf('set_output');
  assert(iSrc >= 0 && iRunup > iSrc && iOut > iRunup,
    `ordering wrong: src=${iSrc} runup=${iRunup} out=${iOut}\n${vpy}`);
}

async function vsSourceRunupBeforeDownscale() {
  const { buildSourceVpy } = require(path.join(SRC, 'shared', 'vsSource.js'));
  const { buildVsDownscaleLines } = require(path.join(SRC, 'shared', 'downscale.js'));
  const vpy = buildSourceVpy({
    inputPath: '/m.mkv', cachePath: '/tmp/s.lwi',
    downscaleLines: buildVsDownscaleLines('1080p'),
  });
  // Run-up primes the decoder, so it belongs on the decoded source -- not on the
  // resized clip, where it would warm nothing.
  assert(vpy.indexOf('core.std.ModifyFrame') < vpy.indexOf('core.resize.Lanczos'),
    `run-up must precede downscale:\n${vpy}`);
}

async function vsSourceRunupCroppedForMemory() {
  const { buildSourceVpy } = require(path.join(SRC, 'shared', 'vsSource.js'));
  const vpy = buildSourceVpy({ inputPath: '/m.mkv', cachePath: '/tmp/s.lwi' });
  // Only the decode side-effect is wanted; retaining full run-up frames would add
  // RUNUP_FRAMES x frame-size per in-flight request on 4K sources.
  assert(vpy.includes('core.std.Crop('), `run-up clips must be cropped:\n${vpy}`);
}

async function vsSourceRunupDisablable() {
  const { buildSourceVpy } = require(path.join(SRC, 'shared', 'vsSource.js'));
  const vpy = buildSourceVpy({ inputPath: '/m.mkv', cachePath: '/tmp/s.lwi', runupFrames: 0 });
  assert(!vpy.includes('ModifyFrame'), `runupFrames:0 must emit no wrapper:\n${vpy}`);
  assert(/src\.set_output\(\)\s*$/.test(vpy), `must still end with set_output():\n${vpy}`);
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

// A partially-decodable source (the 2026-08-01 VC-1 job) lets lsmas index and
// scene-detect the file, then fails to deliver a frame once a chunk worker seeks
// into it. Only the lsmas error itself identifies that as a source failure.
async function sourceDecodeErrorLineDetection() {
  const { isSourceDecodeErrorLine } = require(path.join(SRC, 'shared', 'vsSource.js'));
  // Verbatim from the failed production job (chunk 913 of 914).
  assert(isSourceDecodeErrorLine(
    'Error: Failed to retrieve frame 196 with error: lsmas: failed to output a video frame.') === true,
    'must detect the lsmas frame-delivery failure from the failed VC-1 job');
  assert(isSourceDecodeErrorLine('lsmas: failed to output a video frame') === true,
    'must detect the bare lsmas message');
  // Downstream failures must NOT trigger a full lossless pre-pass of the source.
  assert(isSourceDecodeErrorLine('WARN encode_chunk: Encoder failed (on chunk 913):') === false,
    'generic chunk failure is not a source-decode error');
  assert(isSourceDecodeErrorLine('encoder crashed: exit status: 0') === false,
    'encoder crash is not a source-decode error');
  assert(isSourceDecodeErrorLine('ERROR [chunk 913] encoder failed 3 times, shutting down worker') === false,
    'encoder retry exhaustion is not a source-decode error');
  assert(isSourceDecodeErrorLine(
    'INFO encode_file: scenecut: found 1 scene(s) [with extra_splits (240 frames): 914 scene(s)]') === false,
    'scenecut progress is not a source-decode error');
  assert(isSourceDecodeErrorLine('') === false, 'empty line => false');
  assert(isSourceDecodeErrorLine(undefined) === false, 'undefined => false');
}

// The regression itself: the v2.3.0 gate only asked "did av1an reach chunking?",
// so a mid-encode lsmas failure (chunks.json already written) skipped the retry.
async function mezzanineRetryDecision() {
  const { shouldRetryWithMezzanine } = require(path.join(SRC, 'shared', 'vsSource.js'));

  // The 2026-08-01 VC-1 failure: reached chunking, then lsmas failed mid-encode.
  assert(shouldRetryWithMezzanine({
    exitCode: 1, sizeExceeded: false, sawSourceDecodeError: true, reachedChunking: true,
  }) === true, 'mid-encode lsmas failure must retry even though chunking was reached');

  // The v2.2.0/2.3.0 case: starved scene detection, died before chunking.
  assert(shouldRetryWithMezzanine({
    exitCode: 1, sizeExceeded: false, sawSourceDecodeError: false, reachedChunking: false,
  }) === true, 'failure before chunking must still retry');

  // Downstream failure past chunking with no source error => do NOT retry.
  assert(shouldRetryWithMezzanine({
    exitCode: 1, sizeExceeded: false, sawSourceDecodeError: false, reachedChunking: true,
  }) === false, 'downstream failure must not trigger a pointless lossless pre-pass');

  // Success and the size-limit abort are never source failures.
  assert(shouldRetryWithMezzanine({
    exitCode: 0, sizeExceeded: false, sawSourceDecodeError: true, reachedChunking: true,
  }) === false, 'a successful encode must never retry (transient error recovered)');
  assert(shouldRetryWithMezzanine({
    exitCode: 1, sizeExceeded: true, sawSourceDecodeError: true, reachedChunking: false,
  }) === false, 'size-limit abort must not be mistaken for a source failure');
}

// ---- lsmas pre-flight probe: catch an undecodable source BEFORE encoding ----
// v2.3.1 only reacted after av1an exited, which on the 2026-08-01 VC-1 job meant
// 13m15s of encoding (3 doomed retries of chunk 913) before the fallback fired.

async function vspipeFrameCountParse() {
  const { parseVspipeFrameCount } = require(path.join(SRC, 'shared', 'vsSource.js'));
  const info = [
    'Width: 1920', 'Height: 1080', 'Frames: 219360', 'FPS: 24000/1001 (23.976 fps)',
    'Format Name: YUV420P8',
  ].join('\n');
  assert(parseVspipeFrameCount(info) === 219360, 'must read the frame count from vspipe --info');
  assert(parseVspipeFrameCount('Frames: 0') === 0, 'zero frames => 0');
  assert(parseVspipeFrameCount('no frame line here') === 0, 'missing => 0');
  assert(parseVspipeFrameCount(undefined) === 0, 'undefined => 0');
  // Must not be fooled by a similar-looking line.
  assert(parseVspipeFrameCount('Frames per second: 24') === 0, 'must anchor on the Frames: line');
}

async function probeWindowsCoverTailAndSpread() {
  const { buildProbeWindows } = require(path.join(SRC, 'shared', 'vsSource.js'));
  const n = 219360;                                   // the failing film
  const w = buildProbeWindows(n, { tailFrames: 240, spread: 6 });

  assert(w.length > 0, 'must produce probe windows');
  for (const { start, end } of w) {
    assert(Number.isInteger(start) && Number.isInteger(end), `integer bounds: ${start}-${end}`);
    assert(start >= 0 && end <= n - 1, `windows must stay in range: ${start}-${end} of ${n}`);
    assert(start <= end, `start must not exceed end: ${start}-${end}`);
  }
  // The tail is where this class of lsmas failure lives (the .lwi index claims
  // more frames than the decoder can deliver). Frame 219316 actually failed.
  const last = w[w.length - 1];
  assert(last.end === n - 1, `last window must reach the final frame, got ${last.end}`);
  assert(last.start <= 219316 && last.end >= 219316,
    `tail window must cover the frame that failed in production: ${last.start}-${last.end}`);
  // Ascending and non-overlapping so we fail fast at the earliest bad frame.
  for (let i = 1; i < w.length; i++) {
    assert(w[i].start > w[i - 1].end, `windows must be ordered and disjoint: ${JSON.stringify(w)}`);
  }

  // Degenerate inputs must not produce nonsense.
  assert(buildProbeWindows(0).length === 0, 'no frames => no probes');
  assert(buildProbeWindows(-5).length === 0, 'negative => no probes');
  const tiny = buildProbeWindows(10, { tailFrames: 240, spread: 6 });
  for (const { start, end } of tiny) {
    assert(start >= 0 && end <= 9, `short clip windows must clamp: ${start}-${end}`);
  }
}

async function probeArgsDecodeFrames() {
  const { buildProbeArgs } = require(path.join(SRC, 'shared', 'vsSource.js'));
  const a = buildProbeArgs({ vpyPath: '/w/source.vpy', start: 219120, end: 219359 });
  assert(a[a.indexOf('--start') + 1] === '219120', `start passed: ${a.join(' ')}`);
  assert(a[a.indexOf('--end') + 1] === '219359', `end passed: ${a.join(' ')}`);
  // The script must precede the output target, and frames must be requested but
  // NOT written -- vspipe R77 spells that sink `--` (`vspipe [options] s.vpy --`).
  // Writing real frames anywhere would cost gigabytes.
  const si = a.indexOf('/w/source.vpy');
  assert(si >= 0 && si === a.length - 2, `script second-to-last: ${a.join(' ')}`);
  assert(a[a.length - 1] === '--', `output must be the no-output sink: ${a.join(' ')}`);
}

// A silent scene-detection failure: av1an found ZERO cuts across a 152-minute
// film and only fixed-interval extra_splits produced chunks. Worth surfacing --
// the encode would otherwise be chunked at arbitrary boundaries.
async function degenerateSceneDetection() {
  const { parseScenecutLine, isDegenerateSceneDetection } = require(path.join(SRC, 'shared', 'vsSource.js'));

  // Verbatim from both failed production runs.
  const bad = parseScenecutLine(
    'INFO encode_file: scenecut: found 1 scene(s) [with extra_splits (240 frames): 914 scene(s)]');
  assert(bad && bad.detected === 1, `must parse detected scenes: ${JSON.stringify(bad)}`);
  assert(bad.totalChunks === 914, `must parse post-split chunk count: ${JSON.stringify(bad)}`);
  assert(isDegenerateSceneDetection(bad) === true, 'zero cuts over 914 chunks is degenerate');

  // Healthy detection on a real film.
  const good = parseScenecutLine(
    'INFO encode_file: scenecut: found 1837 scene(s) [with extra_splits (240 frames): 2104 scene(s)]');
  assert(good.detected === 1837, `must parse a healthy count: ${JSON.stringify(good)}`);
  assert(isDegenerateSceneDetection(good) === false, 'many scenes is not degenerate');

  // A genuinely short/single-shot clip legitimately has one scene -- must not warn.
  const shortClip = parseScenecutLine('scenecut: found 1 scene(s) [with extra_splits (240 frames): 3 scene(s)]');
  assert(isDegenerateSceneDetection(shortClip) === false, 'a short single-shot clip is not degenerate');

  assert(parseScenecutLine('unrelated av1an chatter') === null, 'non-matching line => null');
  assert(isDegenerateSceneDetection(null) === false, 'null info => false');
}

// ---- mezzanine: ffmpeg lossless pre-pass (fallback for lsmas-undecodable sources) ----

async function mezzanineLosslessVideoOnlyIntra() {
  const { buildMezzanineArgs } = require(path.join(SRC, 'shared', 'mezzanine.js'));
  const a = buildMezzanineArgs({ inputPath: '/media/x.mkv', outputPath: '/tmp/m.mkv' });
  const s = a.join(' ');
  // FFV1 = mathematically lossless: the pre-pass must not degrade the source
  // before the (quality-critical) AV1 encode.
  assert(a.includes('ffv1'), `mezzanine must use lossless ffv1:\n${s}`);
  assert(!/\bcrf\b|\bqp\b|-b:v|-q:v/i.test(s), `mezzanine must not set any lossy rate:\n${s}`);
  // Intra-only (-g 1) so av1an's chunk workers seek every frame with no pre-roll.
  const gi = a.indexOf('-g');
  assert(gi >= 0 && a[gi + 1] === '1', `mezzanine must be all-intra (-g 1):\n${s}`);
  // Video only -- audio/subs are muxed from the ORIGINAL source later.
  assert(a.includes('-an') && a.includes('-sn'), `mezzanine must drop audio+subs:\n${s}`);
  assert(a.indexOf('-map') >= 0 && a.indexOf('0:v:0') > a.indexOf('-map'), 'maps first video stream');
}

async function mezzanineInputBeforeOutput() {
  const { buildMezzanineArgs } = require(path.join(SRC, 'shared', 'mezzanine.js'));
  const a = buildMezzanineArgs({ inputPath: '/in.mkv', outputPath: '/out.mkv' });
  assert(a[a.length - 1] === '/out.mkv', 'output path is last');
  assert(a[a.indexOf('-i') + 1] === '/in.mkv', 'input follows -i');
  assert(a.includes('-y') && a.includes('-nostdin'), 'non-interactive overwrite');
}

const TESTS = [
  ['vsSource: lsmas line', vsSourceLsmasLine],
  ['vsSource: escapes quotes/backslashes in path', vsSourceEscapesPath],
  ['vsSource: downscale lines after source', vsSourceDownscaleAfterSource],
  ['vsSource: cold-seek run-up wraps source', vsSourceRunupWrapsSource],
  ['vsSource: run-up precedes downscale', vsSourceRunupBeforeDownscale],
  ['vsSource: run-up clips cropped (4K memory)', vsSourceRunupCroppedForMemory],
  ['vsSource: run-up disablable', vsSourceRunupDisablable],
  ['vsSource: av1anReachedChunking gate (chunks.json)', av1anReachedChunkingGate],
  ['vsSource: sceneDetectProducedScenes gate', sceneDetectProducedScenesGate],
  ['vsSource: detects lsmas frame-delivery failure', sourceDecodeErrorLineDetection],
  ['vsSource: mezzanine retry decision (mid-encode + pre-chunking)', mezzanineRetryDecision],
  ['vsSource: parses vspipe --info frame count', vspipeFrameCountParse],
  ['vsSource: probe windows cover tail + spread', probeWindowsCoverTailAndSpread],
  ['vsSource: probe args decode to /dev/null', probeArgsDecodeFrames],
  ['vsSource: detects degenerate scene detection', degenerateSceneDetection],
  ['mezzanine: lossless ffv1, video-only, intra', mezzanineLosslessVideoOnlyIntra],
  ['mezzanine: input/output arg order', mezzanineInputBeforeOutput],
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
