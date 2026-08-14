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
  assert(!vpy.includes('Splice') && !vpy.includes('cmdline'),
    `runupFrames:0 must emit no scoping machinery either:\n${vpy}`);
  assert(/src\.set_output\(\)\s*$/.test(vpy), `must still end with set_output():\n${vpy}`);
}

async function vsSourceRunupScopedToColdSeek() {
  const { buildSourceVpy, RUNUP_FRAMES } = require(path.join(SRC, 'shared', 'vsSource.js'));
  const vpy = buildSourceVpy({ inputPath: '/m.mkv', cachePath: '/tmp/s.lwi' });
  // The wrapper must apply only around this vspipe process's own seek target,
  // read from /proc/self/cmdline -- not tax every frame of every target-quality
  // probe (+20% av1an-phase time measured on Scary Movie 5, 2026-08-11). Frames
  // outside [start, start+RUNUP) must be the bare lsmas clip via a splice.
  assert(vpy.includes('/proc/self/cmdline'), `must read the process cmdline:\n${vpy}`);
  assert(vpy.includes("b'-s'") && vpy.includes("b'--start'"),
    `must recognise both vspipe seek flags:\n${vpy}`);
  assert(vpy.includes(`min(_ru_a + ${RUNUP_FRAMES}`),
    `window width must be RUNUP_FRAMES (${RUNUP_FRAMES}):\n${vpy}`);
  assert(vpy.includes('TDARR_RUNUP_START_OVERRIDE'),
    `test/emergency env override missing:\n${vpy}`);
  const iSrc = vpy.indexOf('core.lsmas.LWLibavSource');
  const iWrap = vpy.indexOf('core.std.ModifyFrame');
  const iSplice = vpy.indexOf('core.std.Splice');
  const iOut = vpy.indexOf('set_output');
  assert(iSrc >= 0 && iWrap > iSrc && iSplice > iWrap && iOut > iSplice,
    `ordering wrong: src=${iSrc} wrap=${iWrap} splice=${iSplice} out=${iOut}\n${vpy}`);
}

async function vsSourceRunupStartParserBehaviour() {
  const { buildSourceVpy } = require(path.join(SRC, 'shared', 'vsSource.js'));
  const vpy = buildSourceVpy({ inputPath: '/m.mkv', cachePath: '/tmp/s.lwi' });
  // Execute the ACTUAL parser emitted into the .vpy (marker-delimited), not a
  // copy of it, against the vspipe invocation shapes we must support.
  const m = /# >>> runup-start parser[\s\S]*?# <<< runup-start parser/.exec(vpy);
  assert(m, `parser markers missing from .vpy:\n${vpy}`);
  const harness = [
    m[0],
    "assert _runup_start([b'vspipe', b'-s', b'123', b'x.vpy']) == 123, 'av1an chunk worker'",
    "assert _runup_start([b'vspipe', b'--start', b'7', b'x.vpy', b'--']) == 7, 'pre-flight probe'",
    "assert _runup_start([b'vspipe', b'--info', b'x.vpy']) == 0, 'info query'",
    "assert _runup_start([b'vspipe', b'x.vpy', b'-']) == 0, 'sequential full decode'",
    "assert _runup_start([b'vspipe', b'-s', b'junk', b'x.vpy']) == 0, 'unparsable value'",
    "assert _runup_start([b'vspipe', b'-s', b'-9', b'x.vpy']) == 0, 'negative clamps to 0'",
    "assert _runup_start([b'vspipe', b'x.vpy', b'-s']) == 0, 'trailing flag without value'",
  ].join('\n');
  const r = require('child_process').spawnSync('python3', ['-c', harness], { encoding: 'utf8' });
  assert(r.status === 0, `parser behaviour wrong:\n${r.stderr || r.stdout}`);
}

async function vsSourceVpyIsValidPython() {
  const { buildSourceVpy } = require(path.join(SRC, 'shared', 'vsSource.js'));
  const { buildVsDownscaleLines } = require(path.join(SRC, 'shared', 'downscale.js'));
  const variants = {
    default: buildSourceVpy({ inputPath: '/m.mkv', cachePath: '/tmp/s.lwi' }),
    downscale: buildSourceVpy({
      inputPath: '/m.mkv', cachePath: '/tmp/s.lwi',
      downscaleLines: buildVsDownscaleLines('1080p'),
    }),
    noRunup: buildSourceVpy({ inputPath: '/m.mkv', cachePath: '/tmp/s.lwi', runupFrames: 0 }),
  };
  for (const [name, vpy] of Object.entries(variants)) {
    const r = require('child_process').spawnSync(
      'python3', ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'],
      { input: vpy, encoding: 'utf8' },
    );
    assert(r.status === 0, `generated .vpy (${name}) is not valid Python:\n${r.stderr}\n${vpy}`);
  }
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

// Regression: killAll's delayed SIGKILL swept the LIVE activeChildren set, so
// anything spawned through the same manager after cleanup() -- probeOutput's
// ffprobe, then mkvmerge -- was killed 3 s in. That failed 100% of xav jobs with
// "output has non-positive dimensions (0x0)". A child spawned after killAll must
// outlive the sweep.
async function killAllDoesNotReachLaterChildren() {
  // Other tests poison require.cache with a stub manager; this one needs the real one.
  const pmPath = require.resolve(path.join(SRC, 'shared', 'processManager.js'));
  delete require.cache[pmPath];
  const { createProcessManager } = require(pmPath);

  const pm = createProcessManager(() => {}, () => {});

  // spawnAsync unref()s its children, so awaiting one does NOT hold the event
  // loop open -- without this the process exits mid-test, reporting success by
  // printing nothing at all.
  const keepAlive = setInterval(() => {}, 250);
  try {
    const doomed = pm.spawnAsync('sleep', ['30']);
    await new Promise((r) => setTimeout(r, 200));

    pm.killAll();

    // Stands in for ffprobe -count_frames: spawned after killAll, runs past the
    // 3 s sweep. Must exit cleanly on its own.
    const later = pm.spawnAsync('sleep', ['4']);

    const laterCode = await later;
    assert(laterCode === 0, `child spawned after killAll was killed by the sweep (exit ${laterCode})`);

    const doomedCode = await doomed;
    assert(doomedCode !== 0, `child alive at killAll should have been killed (exit ${doomedCode})`);
  } finally {
    clearInterval(keepAlive);
    delete require.cache[pmPath];
  }
}

// Regression: buildEncoderParams emitted only `--preset N`, so every job ran SVT
// stock and none of the researched settings reached production. The captured
// launcher read `-p '--preset 4'`. Assert the actual -p payload, not just that
// the argv builds.
async function xavArgvCarriesResearchedParams() {
  const { buildXavArgs, MAINLINE_PARAMS } = require(path.join(SRC, 'shared', 'xav.js'));

  const argvFor = (binPath, paramSet, extraParams) => {
    const a = buildXavArgs({
      inputPath: '/w/in.mkv',
      outputPath: '/w/out.mkv',
      workers: 2,
      preset: 4,
      binPath,
      paramSet,
      extraParams,
      targetQuality: '74.8-75.2',
      crfRange: '5-63',
      vship: 1,
      tqMode: 'mean',
    });
    return a[a.indexOf('-p') + 1];
  };

  const mainline = argvFor('/opt/xav/xav-mainline', 'auto');
  assert(mainline.startsWith('--preset 4 '), `preset must lead: ${mainline}`);
  for (const flag of ['--tune 1', '--enable-qm 1', '--qm-min 0', '--tf-strength 1',
    '--tile-columns 1', '--sharpness 1', '--enable-variance-boost 1']) {
    assert(mainline.includes(flag), `mainline argv is missing ${flag}: ${mainline}`);
  }
  assert(mainline !== '--preset 4', 'mainline must not fall back to SVT stock');

  // xav owns these and rejects them outright; emitting them fails argument validation.
  assert(!mainline.includes('--keyint'), `must not send --keyint: ${mainline}`);
  assert(!mainline.includes('--scm'), `must not send --scm: ${mainline}`);

  // The hdr fork's own defaults are the recipe -- our mainline string fights them.
  assert(argvFor('/opt/xav/xav-hdr', 'auto') === '--preset 4',
    'hdr build must get preset only');
  assert(argvFor('/opt/xav/xav-HDR', 'auto') === '--preset 4', 'hdr sniff is case-insensitive');

  // Explicit modes override the filename sniff in both directions.
  assert(argvFor('/opt/xav/xav-hdr', 'mainline').includes('--qm-min 0'), 'forced mainline');
  assert(argvFor('/opt/xav/xav-mainline', 'hdr') === '--preset 4', 'forced hdr');
  assert(argvFor('/opt/xav/xav-mainline', 'none') === '--preset 4', 'none = preset only');

  // extra_params come last so a hand-set value wins over the default set.
  const overridden = argvFor('/opt/xav/xav-mainline', 'auto', '--qm-min 6');
  assert(overridden.lastIndexOf('--qm-min 6') > overridden.indexOf(MAINLINE_PARAMS.split(' ')[0]),
    `extra_params must be appended last: ${overridden}`);
}

// Regression: the plugins passed format.duration -- the CONTAINER duration, i.e.
// the longest stream -- as the source duration, then validated a VIDEO-ONLY
// output against it. A clip whose subtitle track ran 1.22 s past the last video
// frame failed with "duration 25.11s differs from source 26.33s" on a perfect
// encode. Prefer the video stream's own duration.
async function sourceDurationComesFromVideoStream() {
  const { sourceVideoDuration } = require(path.join(SRC, 'shared', 'xav.js'));

  // Matroska: no per-stream duration, carried in the tags.DURATION string. The
  // container runs longer because a subtitle cue outlives the video.
  assert(
    Math.abs(sourceVideoDuration(
      { codec_type: 'video', tags: { DURATION: '00:02:00.138000000' } },
      { duration: '120.870000' },
    ) - 120.138) < 0.001,
    'must prefer the video tags.DURATION over the longer container duration',
  );

  // MP4-style: a real per-stream duration wins outright.
  assert(sourceVideoDuration({ duration: '25.11' }, { duration: '26.33' }) === 25.11,
    'stream duration wins over container');

  // Neither available: the container is the only thing left.
  assert(sourceVideoDuration({}, { duration: '26.33' }) === 26.33, 'falls back to container');
  assert(sourceVideoDuration({}, {}) === 0, 'no duration at all is 0, which disables the check');

  // Hour-rollover and malformed tags must not silently produce a wrong number.
  assert(Math.abs(sourceVideoDuration({ tags: { DURATION: '01:30:05.5' } }, {}) - 5405.5) < 0.001,
    'parses hours');
  assert(sourceVideoDuration({ tags: { DURATION: 'garbage' } }, { duration: '10' }) === 10,
    'unparseable tag falls through to container');
}

// The mean alone cannot distinguish "the band is unreachable, widen it" from
// "a few chunks are stuck at the CRF floor and nothing will fix them". Those
// need opposite responses, and detectCrfPinning stays silent unless EVERY chunk
// pins -- so starved chunks were previously invisible.
async function targetHitSummarySeparatesFailureModes() {
  const { summariseTargetHit } = require(path.join(SRC, 'shared', 'xav.js'));

  // Uniform near-miss: everything just under the band, nothing at the floor.
  // Diagnosis is "band too narrow", and there is nothing starved.
  const uniform = [78.9, 79.0, 79.1, 79.2].map((score, i) => ({ chunk: i, crf: 14, score }));
  const u = summariseTargetHit(uniform, '79.8-80.2', '5-63');
  assert(u.inBand === 0 && u.below === 4, `uniform: ${JSON.stringify(u)}`);
  assert(u.starved.length === 0, 'nothing is starved when no chunk is at the floor');

  // Mixed: most chunks fine, two pinned at the CRF floor and still far short.
  // Those two are unfixable by any parameter change and must be called out.
  const mixed = [
    { chunk: 0, crf: 14, score: 80.0 },
    { chunk: 1, crf: 14, score: 79.9 },
    { chunk: 2, crf: 5, score: 49.86 },
    { chunk: 3, crf: 5, score: 61.2 },
    { chunk: 4, crf: 5, score: 80.1 },
  ];
  const m = summariseTargetHit(mixed, '79.8-80.2', '5-63');
  assert(m.inBand === 3, `three chunks in band, got ${m.inBand}`);
  assert(m.atFloor === 3, `three chunks at the floor, got ${m.atFloor}`);
  assert(m.starved.length === 2,
    `only the floor chunks that ALSO miss are starved, got ${m.starved.length}`);
  assert(m.worst[0].score === 49.86, 'worst chunks listed worst-first');

  assert(summariseTargetHit([], '79.8-80.2', '5-63') === null, 'no chunks -> no summary');
}

const TESTS = [
  ['processManager: killAll spares later children', killAllDoesNotReachLaterChildren],
  ['xav: target-hit summary separates failure modes', targetHitSummarySeparatesFailureModes],
  ['xav: source duration comes from the video stream', sourceDurationComesFromVideoStream],
  ['xav: argv carries the researched param set', xavArgvCarriesResearchedParams],
  ['vsSource: lsmas line', vsSourceLsmasLine],
  ['vsSource: escapes quotes/backslashes in path', vsSourceEscapesPath],
  ['vsSource: downscale lines after source', vsSourceDownscaleAfterSource],
  ['vsSource: cold-seek run-up wraps source', vsSourceRunupWrapsSource],
  ['vsSource: run-up precedes downscale', vsSourceRunupBeforeDownscale],
  ['vsSource: run-up clips cropped (4K memory)', vsSourceRunupCroppedForMemory],
  ['vsSource: run-up disablable', vsSourceRunupDisablable],
  ['vsSource: run-up scoped to cold-seek window', vsSourceRunupScopedToColdSeek],
  ['vsSource: runup-start parser behaviour (python3)', vsSourceRunupStartParserBehaviour],
  ['vsSource: generated .vpy is valid Python', vsSourceVpyIsValidPython],
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
  ['sanitizeFile: stages already-clean file into workDir', sanitizeStagesAlreadyCleanFileIntoWorkDir],
  ['audio: drops commentaries when keep off', audioDropsCommentariesWhenOff],
  ['audio: keeps additional-lang commentaries when keep on', audioKeepsAdditionalLangCommentariesWhenOn],
  ['subtitles: drop commentary, keep SDH/forced when off', subtitlesDropCommentaryKeepSdhForcedWhenOff],
  ['subtitles: keep commentary when on', subtitlesKeepCommentaryWhenOn],
  ['isCommentary: title or flag, not SDH/forced', commentaryDetection],
  ['svt flags: no inert or redundant params', svtFlagsCarryNoInertParams],
  ['svt flags: deliberate overrides kept', svtFlagsKeepDeliberateOverrides],
  ['svt flags: qm-min matches measurement', svtQmMinMatchesMeasurement],
  ['ab-av1 flags: exclude encoder-owned params', abAv1SvtFlagsExcludeEncoderOwnedParams],
  ['xav: parses real encode master lines', xavParsesRealEncodeLine],
  ['xav: parses CROP/SCD phase lines', xavParsesPhaseLines],
  ['xav: phase totals survive segment boundaries', xavPhaseTotalsAreNotGlued],
  ['xav: parses per-worker CRF and score', xavParsesWorkerCrfAndScore],
  ['xav: reports newest state from glued segments', xavStripsAnsiAndGluedSegments],
  ['xav: size gate needs progress and stability', xavSizeGateNeedsProgressAndStability],
  ['xav: validation catches the no-TTY artefact', xavValidationCatchesNoTtyArtefact],
  ['xav: validation allows autocropped dimensions', xavValidationAllowsAutocroppedDimensions],
  ['xav: validation catches frame drift', xavValidationCatchesFrameDrift],
  ['xav: detects CRF pinning at both bounds', xavDetectsCrfPinning],
  ['xav: CRF range spans both measured extremes', xavCrfRangeIsWideEnoughForBothEnds],
  ['xav: argv is video-only and carries TQ', xavArgsAreVideoOnlyAndCarryTq],
  ['xav: pipe argv keeps input, ffmpeg scales', xavPipeArgsKeepInputAndScale],
  ['xav: strips params xav rejects outright', xavFiltersParamsXavRejects],
  ['xav: param filter handles empty and clean input', xavParamFilterHandlesEmptyAndClean],
  ['xav: estimate does not double-extrapolate', xavEstimateDoesNotDoubleExtrapolate],
  ['xav: size gate waits for convergence', sizeGateWaitsForConvergenceNotJustDecline],
  ['xavEncode: happy path replays real xav output', xavEncodePluginHappyPath],
  ['xavEncode: arms the ppid watchdog so cancel cannot orphan xav', xavEncodeArmsPpidWatchdog],
  ['xav: reports actual bytes written, not a permanent zero', trackerReportsActualBytesWritten],
  ['xav: master line parses with a four-digit chunk count', masterLineParsesWithFourDigitChunkCount],
  ['xav: master line tolerates feature-length ETA and size units', masterLineToleratesFeatureLengthFormats],
  ['xavEncode: validates by counting packets, never decoding frames', probeCountsPacketsNotFrames],
  ['xav: mux takes video only from the encode, no duplicate streams', muxTakesVideoOnlyFromEncode],
  ['xavEncode: refuses input outside workDir', xavEncodeRefusesInputOutsideWorkDir],
];

async function sanitizeStagesAlreadyCleanFileIntoWorkDir() {
  injectProcessManagerStub();
  const { plugin } = require(path.join(SRC, 'sanitizeFile', 'index.js'));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sanitize-staged-'));
  const libDir = path.join(tmp, 'library');
  const workDir = path.join(tmp, 'work');
  fs.mkdirSync(libDir); fs.mkdirSync(workDir);

  const srcFile = path.join(libDir, 'Already Clean (2009).mkv');
  fs.writeFileSync(srcFile, 'x'.repeat(2048));

  // An MKV with one video + one English audio, in order, no images or subs:
  // exactly the "already clean" shape that used to return the library path.
  const args = {
    inputFileObj: {
      _id: srcFile,
      file: srcFile,
      ffProbeData: {
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'audio', codec_name: 'dts', channels: 6, tags: { language: 'eng' } },
        ],
      },
    },
    workDir,
    inputs: { audio_language: 'eng' },
    jobLog: () => {},
    variables: {},
  };

  const res = await plugin(args);
  assert(res.outputNumber === 2, `already-clean must still use port 2, got ${res.outputNumber}`);

  const outPath = res.outputFileObj._id;
  assert(outPath !== srcFile,
    'already-clean file must NOT be handed on at its library path -- xav would write its '
    + 'temp dir there');
  assert(path.dirname(fs.realpathSync(outPath)) === fs.realpathSync(workDir),
    `staged file must live in workDir, got ${outPath}`);
  assert(res.outputFileObj.file === outPath, '_id and file must both point at the staged copy');
  assert(fs.statSync(outPath).size === 2048, 'staged copy must have the original content');
  assert(fs.existsSync(srcFile), 'the original library file must be left untouched');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- encoder flags --------------------------------------------------------
// Pins the 2026-08-13 cleanup (docs/svt-av1-settings-research.md). We ship
// MAINLINE SVT-AV1 v4.2.0; the old set was a psy-fork recipe applied to it.

async function svtFlagsCarryNoInertParams() {
  const { buildSvtFlags } = require(path.join(SRC, 'shared', 'encoderFlags.js'));
  const flags = buildSvtFlags(4, '');

  // Inert or redundant against v4.2.0 defaults. Re-adding any of these means
  // someone reintroduced a no-op -- or worse, pinned a default that may move.
  for (const dead of ['--rc ', '--irefresh-type', '--variance-boost-strength',
    '--qm-max', '--chroma-qm-min', '--chroma-qm-max', '--input-depth', '--lookahead',
    '--variance-octile']) {
    assert(!flags.includes(dead), `${dead} is inert or redundant and must not be set: ${flags}`);
  }

  // Roughly doubles picture buffers, multiplied across parallel av1an workers.
  assert(!flags.includes('--enable-overlays'),
    `--enable-overlays doubles picture buffers and is off by default upstream: ${flags}`);
}

async function svtFlagsKeepDeliberateOverrides() {
  const { buildSvtFlags } = require(path.join(SRC, 'shared', 'encoderFlags.js'));
  const flags = buildSvtFlags(4, '');

  // Each of these genuinely differs from a v4.2.0 default, or is a decision we
  // want to survive an upstream default change.
  for (const kept of ['--preset 4', '--tune 1', '--keyint -1',
    '--enable-variance-boost 1', '--enable-qm 1', '--tf-strength 1', '--sharpness 1']) {
    assert(flags.includes(kept), `${kept} must be set explicitly: ${flags}`);
  }
}

async function svtQmMinMatchesMeasurement() {
  const { buildSvtFlags } = require(path.join(SRC, 'shared', 'encoderFlags.js'));
  const flags = buildSvtFlags(4, '');

  // Measured, not inherited. The settings sweep found qm-min monotonic at matched
  // quality on clean digital: 0 beats 4 by 1.2-2.1% and 6 by 2.4-3.9%. An earlier
  // version of this test asserted 4-6 on maintainer consensus alone; the
  // measurement overruled it. If a future sweep (grain, or a different gate)
  // reverses this, change the value AND this test together, with the numbers.
  const m = flags.match(/--qm-min\s+(\d+)/);
  assert(m, `qm-min must be set explicitly: ${flags}`);
  assert(Number(m[1]) === 0,
    `qm-min should be 0 per measurement (0 beat 4 by 1.2-2.1% at matched quality), got ${m[1]}`);

  // QM itself must stay enabled: disabling costs +4.3% to +15.6% on mainline and
  // +33.9% on the hdr fork. This is the load-bearing half of the pair.
  assert(/--enable-qm\s+1/.test(flags), `QM must stay enabled: ${flags}`);
}

async function abAv1SvtFlagsExcludeEncoderOwnedParams() {
  const { buildAbAv1SvtFlags } = require(path.join(SRC, 'shared', 'encoderFlags.js'));
  const flags = buildAbAv1SvtFlags();
  // ab-av1 drives rate control, preset and keyframes itself.
  for (const owned of ['rc=', 'preset=', 'keyint=', 'input-depth=']) {
    assert(!flags.includes(owned), `ab-av1 owns ${owned} -- must not be passed: ${flags}`);
  }
  assert(flags.includes('--svt qm-min=0'), `qm-min (measured value) must carry into ab-av1 too: ${flags}`);
}

// --- xav ------------------------------------------------------------------
// The fixture is a real capture from the Avatar bake-off (1080p, TQ, 2 workers),
// escape codes and all, so the parser is tested against genuine xav output
// rather than strings we invented to match our own regexes.

const XAV_FIXTURE = path.join(__dirname, 'fixtures', 'xav-tui-sample.log');

async function xavParsesRealEncodeLine() {
  const { parseXavLine } = require(path.join(SRC, 'shared', 'xav.js'));
  const raw = fs.readFileSync(XAV_FIXTURE, 'utf8');

  const events = raw.split(/[\r\n]/).map(parseXavLine).filter(Boolean);
  const encodes = events.filter((e) => e.type === 'encode');
  assert(encodes.length > 0, 'no encode master lines parsed from the real fixture');

  for (const e of encodes) {
    assert(e.totalFrames === 2899, `totalFrames should be 2899, got ${e.totalFrames}`);
    assert(e.frames >= 0 && e.frames <= e.totalFrames, `frames out of range: ${e.frames}`);
    assert(e.percent >= 0 && e.percent <= 100, `percent out of range: ${e.percent}`);
    assert(e.chunksTotal > 0, 'chunksTotal must be positive');
    assert(e.megabytes >= 0, 'megabytes must be non-negative');
  }
}

async function xavParsesPhaseLines() {
  const { parseXavEvents } = require(path.join(SRC, 'shared', 'xav.js'));
  const raw = fs.readFileSync(XAV_FIXTURE, 'utf8');
  const phases = raw.split(/[\r\n]/).flatMap(parseXavEvents)
    .filter((e) => e.type === 'phase').map((e) => e.phase);
  // CROP and SCD arrive glued into a single read by cursor addressing, so this
  // only passes if segmentation splits them rather than reporting the newest.
  assert(phases.includes('CROP'), `CROP phase not seen, got: ${[...new Set(phases)]}`);
  assert(phases.includes('SCD'), `SCD phase not seen, got: ${[...new Set(phases)]}`);
  assert(phases.includes('MUX'), `MUX phase not seen, got: ${[...new Set(phases)]}`);
}

async function xavPhaseTotalsAreNotGlued() {
  const { parseXavEvents } = require(path.join(SRC, 'shared', 'xav.js'));
  const raw = fs.readFileSync(XAV_FIXTURE, 'utf8');
  const events = raw.split(/[\r\n]/).flatMap(parseXavEvents).filter((e) => e.type === 'phase');
  // The CROP phase counts 13 items and SCD counts 2899 frames. Matching across
  // a segment boundary produced 1300 / 289900 before segmentation was added.
  for (const e of events) {
    if (e.phase === 'CROP') {
      assert(e.totalFrames === 13, `CROP total should be 13, got ${e.totalFrames}`);
    }
    if (e.phase === 'SCD' || e.phase === 'MUX') {
      assert(e.totalFrames === 2899, `${e.phase} total should be 2899, got ${e.totalFrames}`);
    }
  }
}

async function xavParsesWorkerCrfAndScore() {
  const { parseXavLine } = require(path.join(SRC, 'shared', 'xav.js'));
  const raw = fs.readFileSync(XAV_FIXTURE, 'utf8');
  const workers = raw.split(/[\r\n]/).map(parseXavLine).filter(Boolean)
    .flatMap((e) => e.workers || []);
  assert(workers.length > 0, 'no per-worker lines parsed');
  assert(workers.every((w) => isFinite(w.crf)), 'every worker line must carry a CRF');
  // The score field is blank until the chunk has been measured; both forms occur.
  assert(workers.some((w) => w.score === null), 'expected some unscored worker lines');
}

async function xavStripsAnsiAndGluedSegments() {
  const { parseXavLine, parseXavEvents } = require(path.join(SRC, 'shared', 'xav.js'));
  // Stripping CSI glues consecutive TUI updates together with no separator.
  // `912/2899` runs straight into the next segment's `00:00`, which naive
  // matching reads as `912/289900`.
  const glued = '00:00 SCD: [##------] 31%, 912 FPS, -00:00, 912/2899'
    + '00:00 SCD: [########] 100%, 2899 FPS, -00:00, 2899/2899';

  const events = parseXavEvents(glued);
  assert(events.length === 2, `expected 2 segments, got ${events.length}`);
  assert(events[0].frames === 912 && events[0].totalFrames === 2899,
    `first segment wrong: ${JSON.stringify(events[0])}`);
  assert(events[1].frames === 2899 && events[1].totalFrames === 2899,
    `second segment wrong: ${JSON.stringify(events[1])}`);

  const newest = parseXavLine(glued);
  assert(newest.frames === 2899, `newest should be 2899, got ${newest.frames}`);
}

async function xavSizeGateNeedsProgressAndStability() {
  const { sizeGateDecision } = require(path.join(SRC, 'shared', 'xav.js'));
  const opts = { maxEncodedPercent: 50, sourceBytes: 1000, nonVideoBytes: 0 };

  // Too early: percent below the floor, even though projection is over budget.
  const early = [
    { percent: 10, projectedBytes: 900 },
    { percent: 12, projectedBytes: 800 },
    { percent: 15, projectedBytes: 700 },
  ];
  assert(sizeGateDecision(early, opts).abort === false, 'must not abort below the progress floor');

  // Rising projection: xav's size curve is front-loaded, so a still-rising
  // estimate is not yet trustworthy.
  const rising = [
    { percent: 40, projectedBytes: 700 },
    { percent: 45, projectedBytes: 800 },
    { percent: 50, projectedBytes: 900 },
  ];
  assert(sizeGateDecision(rising, opts).abort === false, 'must not abort on a rising projection');

  // Converged and genuinely over budget. NOTE: "converged" now means the spread
  // is inside GATE_STABLE_TOLERANCE, not merely that the series declines. A
  // steady decline like 900/850/800 is still moving ~6% per sample and is no
  // longer accepted -- treating decline as convergence is what let a 1/progress
  // curve satisfy the guard while several times too high.
  const settled = [
    { percent: 40, projectedBytes: 810 },
    { percent: 45, projectedBytes: 800 },
    { percent: 50, projectedBytes: 805 },
  ];
  const d = sizeGateDecision(settled, opts);
  assert(d.abort === true, `should abort at 80% of source against a 50% limit, got ${JSON.stringify(d)}`);

  // Converged and within budget.
  const ok = [
    { percent: 40, projectedBytes: 400 },
    { percent: 45, projectedBytes: 350 },
    { percent: 50, projectedBytes: 300 },
  ];
  assert(sizeGateDecision(ok, opts).abort === false, 'must not abort when within budget');
}

async function xavValidationCatchesNoTtyArtefact() {
  const { validateOutput } = require(path.join(SRC, 'shared', 'xav.js'));
  const source = { frames: 2899, duration: 120.9 };

  const noTty = validateOutput(
    { exists: true, bytes: 870, width: 0, height: 0, frames: 0, duration: 0 }, source, {},
  );
  assert(noTty.ok === false, 'the ~870-byte no-TTY artefact must fail validation');
  assert(/no-TTY signature/.test(noTty.problems.join(' ')),
    `error must name the no-TTY cause, got: ${noTty.problems.join(' | ')}`);

  const missing = validateOutput({ exists: false }, source, {});
  assert(missing.ok === false, 'a missing output must fail');
}

async function xavValidationAllowsAutocroppedDimensions() {
  const { validateOutput } = require(path.join(SRC, 'shared', 'xav.js'));
  // xav autocrops: 1920x1080 legitimately becomes 1920x1040. That must pass.
  const r = validateOutput(
    {
      exists: true, bytes: 200 * 1024 * 1024, width: 1920, height: 1040,
      codec: 'av1', frames: 2899, duration: 120.9,
    },
    { frames: 2899, duration: 120.9 }, {},
  );
  assert(r.ok === true, `autocropped output must validate, got: ${r.problems.join(' | ')}`);
}

async function xavValidationCatchesFrameDrift() {
  const { validateOutput } = require(path.join(SRC, 'shared', 'xav.js'));
  const r = validateOutput(
    {
      exists: true, bytes: 200 * 1024 * 1024, width: 1920, height: 1040,
      codec: 'av1', frames: 2894, duration: 120.9,
    },
    { frames: 2899, duration: 120.9 }, {},
  );
  assert(r.ok === false, 'a 5-frame drift must fail validation');
  assert(/frame count/.test(r.problems.join(' ')), 'must report the frame count problem');
}

async function xavDetectsCrfPinning() {
  const { detectCrfPinning } = require(path.join(SRC, 'shared', 'xav.js'));

  const ceiling = detectCrfPinning([40, 40, 40, 40], '10-40');
  assert(ceiling.pinned === true && ceiling.bound === 'ceiling',
    `all-at-ceiling must be flagged, got ${JSON.stringify(ceiling)}`);

  const floor = detectCrfPinning([10, 10, 10], '10-40');
  assert(floor.pinned === true && floor.bound === 'floor',
    `all-at-floor must be flagged, got ${JSON.stringify(floor)}`);

  const healthy = detectCrfPinning([16.25, 27.5, 23.8, 40], '10-40');
  assert(healthy.pinned === false, 'a converged spread must not be flagged as pinned');
}

async function xavCrfRangeIsWideEnoughForBothEnds() {
  const { details } = require(path.join(SRC, 'xavEncode', 'index.js'));
  const input = details().inputs.find((i) => i.name === 'crf_range');
  assert(input, 'crf_range input must exist');
  const [lo, hi] = String(input.defaultValue).split('-').map(Number);

  // Measured mean CRF spans ~8 (demanding content, top tier) to ~41 (easy
  // content, low tier). A range that excludes either end silently converts
  // target-quality into fixed-CRF: chunks pin at the bound and the search
  // measures nothing. 10-50 was the old default and fails at both ends.
  assert(lo <= 5, `CRF floor ${lo} is too high -- demanding content reaches ~8`);
  assert(hi >= 60, `CRF ceiling ${hi} is too low -- easy content reaches ~41 and beyond`);
}

async function xavArgsAreVideoOnlyAndCarryTq() {
  const { buildXavArgs } = require(path.join(SRC, 'shared', 'xav.js'));
  const args = buildXavArgs({
    inputPath: '/w/in.mkv', outputPath: '/w/out.mkv',
    workers: 2, buffer: 2, preset: 4, targetQuality: '72.3-72.7',
    crfRange: '10-40', vship: 1, tqMode: 'mean',
  });
  const joined = args.join(' ');
  assert(!joined.includes('-a '), `xav must stay video-only (no -a), got: ${joined}`);
  assert(joined.includes('-t 72.3-72.7'), `target quality missing: ${joined}`);
  assert(joined.includes('-f 10-40'), `crf range missing: ${joined}`);
  assert(args.indexOf('/w/in.mkv') < args.indexOf('/w/out.mkv'), 'input must precede output');
}

async function xavPipeArgsKeepInputAndScale() {
  const { buildXavArgs, buildPipeFfmpegArgs } = require(path.join(SRC, 'shared', 'xav.js'));

  // Pipe path still passes the source file as <INPUT>: xav reads scene
  // detection, crop and frame count from it, and only takes frames from stdin.
  const args = buildXavArgs({
    inputPath: '/w/in.mkv', outputPath: '/w/out.mkv', workers: 2, preset: 4,
    targetQuality: '72.3-72.7', crfRange: '10-40', vship: 1,
  });
  assert(args[0] === '/w/in.mkv', `pipe args must still pass the source, got ${args[0]}`);
  assert(args[1] === '/w/out.mkv', `output must follow the input, got ${args[1]}`);
  // -b is omitted unless explicitly set; `-b null` is not a valid argument.
  assert(!args.includes('-b'), `-b must be omitted when unset, got: ${args.join(' ')}`);

  const ff = buildPipeFfmpegArgs({ inputPath: '/w/in.mkv', resolution: '1080p' });
  const j = ff.join(' ');
  assert(j.includes('scale=1920:-2:flags=lanczos'), `scale filter missing: ${j}`);
  assert(j.includes('yuv4mpegpipe'), `must emit Y4M: ${j}`);
  assert(j.includes('-an') && j.includes('-sn'), `pipe must be video-only: ${j}`);
}

async function xavFiltersParamsXavRejects() {
  const { filterEncoderParams } = require(path.join(SRC, 'shared', 'xav.js'));
  // Our real production av1an SVT param string. Handed to xav unfiltered it
  // aborts with "argument parsing failed" before encoding anything -- this is
  // exactly how the first parameter sweep died on all 40 runs in 20 seconds.
  const av1anParams = '--scd 0 --crf 25 --rc 0 --preset 4 --tune 1 --input-depth 10 '
    + '--lookahead 48 --keyint -1 --irefresh-type 2 --enable-overlays 1 '
    + '--enable-variance-boost 1 --variance-boost-strength 2 --enable-qm 1 --tile-columns 1';

  const { params, dropped } = filterEncoderParams(av1anParams);
  const droppedNames = dropped.map((d) => d.param);

  for (const rejected of ['--input-depth', '--lookahead', '--keyint', '--irefresh-type',
    '--enable-overlays', '--crf', '--rc', '--scd']) {
    assert(droppedNames.includes(rejected), `${rejected} must be dropped, got: ${droppedNames}`);
    assert(!params.includes(rejected), `${rejected} survived into: ${params}`);
  }

  // Everything xav accepts must survive untouched.
  for (const kept of ['--preset 4', '--tune 1', '--enable-variance-boost 1',
    '--variance-boost-strength 2', '--enable-qm 1', '--tile-columns 1']) {
    assert(params.includes(kept), `${kept} should have been kept, got: ${params}`);
  }

  // Negative values must be consumed as values, not mistaken for the next flag.
  assert(!params.includes('-1'), `a dropped param's negative value leaked: ${params}`);
  assert(dropped.every((d) => d.reason && d.reason.length > 0), 'every drop needs a stated reason');
}

async function xavParamFilterHandlesEmptyAndClean() {
  const { filterEncoderParams, buildEncoderParams } = require(path.join(SRC, 'shared', 'xav.js'));
  assert(filterEncoderParams('').params === '', 'empty input yields empty params');
  assert(filterEncoderParams(undefined).dropped.length === 0, 'undefined input drops nothing');

  const clean = filterEncoderParams('--tune 1 --sharpness 1');
  assert(clean.dropped.length === 0, `clean params must not be filtered: ${JSON.stringify(clean.dropped)}`);

  // buildEncoderParams always supplies the preset and filters the rest.
  const built = buildEncoderParams({ preset: 6, extraParams: '--lookahead 48 --tune 2' });
  assert(built.includes('--preset 6'), `preset missing: ${built}`);
  assert(built.includes('--tune 2'), `tune should survive: ${built}`);
  assert(!built.includes('--lookahead'), `lookahead should be stripped: ${built}`);
}

// xav's `m` field is a WHOLE-FILE projection (kbps x TOTAL duration), not bytes
// written so far. Proof is in our own captured fixture: it reads 870.6 at 63%
// progress against an 895.3 final -- 97% of the final value, not 63% of it --
// and it DECREASES between ticks (870.6 -> 869.3 as progress rises) because the
// running average bitrate falls. Bytes on disk cannot decrease.
//
// The old code multiplied it by totalFrames/frames anyway, inflating the
// estimate by exactly 1/progress: 100x at 1%, 3.3x at 30% -- which is precisely
// where the size gate first becomes eligible.
async function xavEstimateDoesNotDoubleExtrapolate() {
  const { parseXavEvents, projectedVideoBytes } = require(path.join(SRC, 'shared', 'xav.js'));
  const raw = fs.readFileSync(XAV_FIXTURE, 'utf8');
  const enc = parseXavEvents(raw).filter((e) => e.type === 'encode' && e.megabytes > 0);
  assert(enc.length >= 2, 'fixture must contain encode events');

  const finalBytes = projectedVideoBytes(enc[enc.length - 1].megabytes);

  // `m` is base-10 MB: 57527 kbps x (2899/23.976)s / 8 = 869.5e6 bytes, and the
  // line reads "869.5m". Treating it as MiB overstates by 4.86%.
  assert(Math.abs(projectedVideoBytes(869.5) - 869500000) < 1,
    `m must convert as base-10 MB, got ${projectedVideoBytes(869.5)}`);

  // Every mid-encode sample must already be close to the final, because xav has
  // been averaging bitrate over completed chunks all along.
  for (const ev of enc) {
    if (ev.percent < 50) continue;
    const est = projectedVideoBytes(ev.megabytes);
    const ratio = est / finalBytes;
    assert(ratio > 0.9 && ratio < 1.1,
      `at ${ev.percent}% the estimate is ${(ratio * 100).toFixed(0)}% of final `
      + `(${(est / 1e6).toFixed(1)} MB vs ${(finalBytes / 1e6).toFixed(1)} MB) -- `
      + 'this is the double-extrapolation bug');
  }
}

// The gate only fires once the projection has CONVERGED. The old guard accepted
// any non-increasing run, which a 1/progress decay satisfies from its first three
// samples while still being 3.3x too high -- so at the shipped 80% default it
// would have aborted essentially every good encode at 30% progress.
async function sizeGateWaitsForConvergenceNotJustDecline() {
  const { sizeGateDecision } = require(path.join(SRC, 'shared', 'xav.js'));
  const opts = { maxEncodedPercent: 80, sourceBytes: 1000e6, nonVideoBytes: 0 };

  // An encode heading for 30% of source, seen through the old 1/progress
  // inflation: still falling steeply, still far too high. Must NOT abort.
  const decaying = [10, 20, 30].map((p) => ({
    percent: p, projectedBytes: 300e6 / (p / 100),
  }));
  assert(!sizeGateDecision(decaying, opts).abort,
    'a steeply falling projection is not converged -- aborting here kills good encodes');

  // Converged and genuinely over the limit: must abort.
  const overLimit = [40, 45, 50].map((p) => ({ percent: p, projectedBytes: 900e6 }));
  assert(sizeGateDecision(overLimit, opts).abort, 'converged and over limit must abort');

  // Converged and under the limit: must not abort.
  const underLimit = [40, 45, 50].map((p) => ({ percent: p, projectedBytes: 300e6 }));
  assert(!sizeGateDecision(underLimit, opts).abort, 'converged and under limit must not abort');

  // Small wobble around a converged value is still converged -- the corrected
  // projection is xav's own running average and moves in both directions.
  const wobble = [
    { percent: 40, projectedBytes: 900e6 },
    { percent: 45, projectedBytes: 890e6 },
    { percent: 50, projectedBytes: 903e6 },
  ];
  assert(sizeGateDecision(wobble, opts).abort,
    'a 1.5% wobble must still count as converged, or the gate never fires');

  // Below the progress floor nothing fires, however stable it looks.
  const early = [5, 10, 15].map((p) => ({ percent: p, projectedBytes: 900e6 }));
  assert(!sizeGateDecision(early, opts).abort, 'must respect the progress floor');
}

// Plugin-level test: replays the REAL captured xav output through xavEncode with
// every binary stubbed, so the whole path -- launcher, tracker, validation,
// mux, propagation -- is exercised with no xav, no GPU and no container.
const STUB_ENCODER_PID = 424242;

function injectXavPluginStubs(opts) {
  const pmPath = require.resolve(path.join(SRC, 'shared', 'processManager.js'));
  const captured = opts.captured;
  // Pids the plugin asked the ppid watchdog to guard. Cancellation correctness
  // is invisible from the return value, so the test has to observe this.
  const watched = opts.watched || [];

  require.cache[pmPath] = {
    id: pmPath,
    filename: pmPath,
    loaded: true,
    exports: {
      createProcessManager: () => ({
        spawnAsync: async (bin, spawnArgs, spawnOpts) => {
          const o = spawnOpts || {};
          if (bin.endsWith('script')) {
            // The real spawnAsync reports the child pid through onSpawn; the stub
            // must too, or a plugin that arms the ppid watchdog there looks
            // identical to one that never arms it.
            if (o.onSpawn) o.onSpawn(STUB_ENCODER_PID);
            // Feed the real fixture through the tracker, then produce output.
            if (o.onLine) {
              for (const line of captured.split(/[\r\n]/)) {
                if (line.trim()) o.onLine(line);
              }
            }
            fs.writeFileSync(opts.videoOnlyPath, 'x'.repeat(opts.outputBytes));
            return opts.exitCode != null ? opts.exitCode : 0;
          }
          if (opts.onSpawnArgs) opts.onSpawnArgs(bin, spawnArgs);
          if (bin.includes('ffprobe')) {
            for (const line of opts.probeLines) if (o.onLine) o.onLine(line);
            return 0;
          }
          // mkvmerge mux
          const oi = spawnArgs.indexOf('-o');
          if (oi >= 0) fs.writeFileSync(spawnArgs[oi + 1], 'muxed');
          return 0;
        },
        cleanup: () => {},
        installCancelHandler: () => {},
        removeCancelHandler: () => {},
        killAll: () => {},
        adopt: (c) => c,
        startPpidWatcher: (pid) => watched.push(pid),
        stopPpidWatchers: () => {},
      }),
    },
  };
}

// The mux must take ONLY the video from the encoded file. xav copies the
// source's audio/subs/chapters into its own output, so muxing that file whole
// and then adding `--no-video <source>` produced TWO complete sets of every
// non-video stream. Found in production on the first real encodes (Avatar:
// 2 TrueHD + 8 subtitle tracks; Harry Potter the same), and it silently
// inflated every measured output size by a full copy of the audio.
//
// Note the pre-existing test named "xav: argv is video-only" does NOT cover
// this -- it asserts the xav COMMAND LINE has no -a flag, which says nothing
// about what xav writes into its container.
async function muxTakesVideoOnlyFromEncode() {
  const { mergeAudioVideo } = require(path.join(SRC, 'shared', 'audioMerge.js'));
  let seen = null;
  const pm = {
    spawnAsync: async (_bin, a) => { seen = a; return 0; },
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xav-mux-'));
  const out = path.join(tmp, 'out.mkv');
  fs.writeFileSync(out, 'muxed');
  await mergeAudioVideo(path.join(tmp, 'video.mkv'), path.join(tmp, 'source.mkv'),
    out, pm, () => {}, () => {});

  assert(seen, 'mkvmerge was never invoked');
  const vi = seen.indexOf(path.join(tmp, 'video.mkv'));
  const si = seen.indexOf(path.join(tmp, 'source.mkv'));
  assert(vi > 0 && si > vi, `unexpected argv order: ${seen.join(' ')}`);

  // Every non-video exclusion must apply to the ENCODED file, i.e. appear
  // before it on the command line -- mkvmerge options are positional.
  for (const flag of ['--no-audio', '--no-subtitles', '--no-chapters', '--no-attachments']) {
    const fi = seen.indexOf(flag);
    assert(fi >= 0, `mux must pass ${flag} for the encoded file: ${seen.join(' ')}`);
    assert(fi < vi, `${flag} must precede the encoded file to apply to it: ${seen.join(' ')}`);
  }
  assert(seen.indexOf('--no-video') > vi && seen.indexOf('--no-video') < si,
    `--no-video must apply to the source: ${seen.join(' ')}`);

  fs.rmSync(tmp, { recursive: true, force: true });
}

// Output validation must not DECODE the output to count its frames. On Avatar
// (16.8 GB, 283893 frames) `ffprobe -count_frames` took 42m42s -- about 40% of
// the whole job -- while the dashboard still read "Muxing". -count_packets
// returns the identical number for AV1 in Matroska by demuxing only: verified
// on a real output, 2896 both ways, 23.5s versus 0.075s.
async function probeCountsPacketsNotFrames() {
  const seen = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xav-probe-'));
  const workDir = path.join(tmp, 'work');
  fs.mkdirSync(workDir);
  const inputPath = path.join(workDir, 'staged.mkv');
  fs.writeFileSync(inputPath, 'y'.repeat(400 * 1024 * 1024 / 1024));

  injectXavPluginStubs({
    captured: fs.readFileSync(XAV_FIXTURE, 'utf8'),
    videoOnlyPath: path.join(workDir, 'xav-video.mkv'),
    outputBytes: 8 * 1024 * 1024,
    probeLines: [
      'width=1920', 'height=1040', 'codec_name=av1',
      'nb_read_packets=2899', 'duration=120.910000',
    ],
    onSpawnArgs: (bin, a) => { if (bin.includes('ffprobe')) seen.push(a.join(' ')); },
  });

  const realExists = fs.existsSync;
  fs.existsSync = (p) => (p === '/usr/local/bin/xav' ? true : realExists(p));
  try {
    delete require.cache[require.resolve(path.join(SRC, 'xavEncode', 'index.js'))];
    const { plugin } = require(path.join(SRC, 'xavEncode', 'index.js'));
    await plugin({
      inputFileObj: {
        _id: inputPath,
        file: inputPath,
        ffProbeData: {
          streams: [{ codec_type: 'video', width: 1920, height: 1080, nb_frames: '2899' }],
          format: { duration: '120.910000' },
        },
      },
      workDir,
      inputs: {},
      variables: {},
      jobLog: () => {},
      updateWorker: () => {},
    });
  } finally {
    fs.existsSync = realExists;
  }

  const probeArgs = seen.join(' | ');
  assert(probeArgs.includes('-count_packets'),
    `validation must use -count_packets, got: ${probeArgs}`);
  assert(!probeArgs.includes('-count_frames'),
    `validation must NOT decode with -count_frames, got: ${probeArgs}`);

  fs.rmSync(tmp, { recursive: true, force: true });
}

// Feature-length encodes produce master lines our 2-minute test clips never
// did: an ETA past an hour and a projected size past 1000m. The Avatar job
// (2649 chunks) froze the dashboard for its whole run, and no local source is
// long enough to reproduce it, so the parser accepts the wider forms rather
// than pinning the one shape we happened to capture.
function masterLineToleratesFeatureLengthFormats() {
  const { parseXavEvents } = require(path.join(SRC, 'shared', 'xav.js'));
  const enc = (l) => parseXavEvents(l).filter((e) => e.type === 'encode')[0];

  // Baseline, the shape captured from a real run: two-field ETA is H:MM.
  const a = enc('00:03 [22/25] [#####-----] 79% 2316/2899 (12.59, -00:28, 57527k, 869.5m)');
  assert(a && a.megabytes === 869.5, `baseline megabytes wrong: ${a && a.megabytes}`);
  assert(a.etaSeconds === 28 * 60, `two-field ETA must be H:MM, got ${a.etaSeconds}s`);

  // Gigabyte-scale projection -- normalised to megabytes so the size gate and
  // the estimate keep working in one unit.
  const g = enc('23:45 [355/2649] [###-----] 13% 38000/283597 (44.60, -01:45, 3000k, 4.3g)');
  assert(g, 'a gigabyte-scale size field must still parse');
  assert(Math.abs(g.megabytes - 4300) < 0.001, `4.3g must be 4300 MB, got ${g.megabytes}`);

  // Three-field ETA (H:MM:SS) on a long job.
  const h = enc('23:45 [355/2649] [###-----] 13% 38000/283597 (44.60, -2:05:30, 3000k, 430.5m)');
  assert(h, 'a three-field ETA must still parse');
  assert(h.etaSeconds === 2 * 3600 + 5 * 60 + 30, `H:MM:SS wrong: ${h.etaSeconds}`);
}

// A master line whose chunks-done has four digits must still parse. The segment
// splitter used to treat `[1234/` as the start of a per-worker line, splitting
// mid-master-line and removing the timestamp the master pattern anchors on.
// Every clip we ever tested had under 1000 chunks; Avatar had 2649.
function masterLineParsesWithFourDigitChunkCount() {
  const { parseXavEvents } = require(path.join(SRC, 'shared', 'xav.js'));
  const line = '23:45 [1234/2649] [####----------------] 21% 38000/283597 '
    + '(44.60, -01:45, 3000k, 430.5m)';
  const evs = parseXavEvents(line).filter((e) => e.type === 'encode');
  assert(evs.length === 1, `four-digit chunk count must yield an encode event, got ${evs.length}`);
  assert(evs[0].chunksDone === 1234 && evs[0].chunksTotal === 2649,
    `wrong chunk numbers: ${JSON.stringify(evs[0])}`);

  // The three-digit case must keep working.
  const evs3 = parseXavEvents('23:45 [355/2649] [####----------------] 21% 38000/283597 '
    + '(44.60, -01:45, 3000k, 430.5m)').filter((e) => e.type === 'encode');
  assert(evs3.length === 1 && evs3[0].chunksDone === 355, 'three-digit chunk count regressed');
}

// ee1bcc2 removed outputFileSizeInGbytes because the value fed to it was a
// whole-file PROJECTION, which made the dashboard count backwards. Removing it
// left the field reading 0 forever, which Emil noticed on 2026-08-13: "the
// current Output file size has always displayed 0 since we fixed the estimated
// output at finish". xav never prints bytes-written, but it leaves them on disk
// as one .obu per finished chunk, so the number is measurable even though it is
// not reported.
async function trackerReportsActualBytesWritten() {
  const { createXavTracker } = require(path.join(SRC, 'shared', 'xav.js'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xav-bytes-'));
  // xav's chunk directory: a dot-dir whose name is a hash we do not control.
  const encDir = path.join(tmp, '.a1b2c3', 'encode');
  fs.mkdirSync(encDir, { recursive: true });
  fs.writeFileSync(path.join(encDir, '0000.obu'), Buffer.alloc(3 * 1024 * 1024));
  fs.writeFileSync(path.join(encDir, '0001.obu'), Buffer.alloc(1 * 1024 * 1024));

  const updates = [];
  const tracker = createXavTracker({
    updateWorker: (f) => updates.push(f),
    jobLog: () => {}, dbg: () => {},
    onSizeExceeded: () => {},
    sourceBytes: 1000 * 1024 * 1024,
    nonVideoBytes: 0,
    maxEncodedPercent: 100,
    workDir: tmp,
  });

  tracker.onLine('00:03 [22/25] [#####-----] 79% 2316/2899 (12.59, -00:30, 57527k, 869.5m)');
  tracker.startInterval();
  await new Promise((r) => setTimeout(r, 5200));   // one POLL_INTERVAL_MS tick
  tracker.stop();

  const sized = updates.filter((u) => u.outputFileSizeInGbytes != null);
  assert(sized.length > 0,
    'tracker must report outputFileSizeInGbytes -- it read 0 forever after ee1bcc2');
  const gb = sized[sized.length - 1].outputFileSizeInGbytes;
  const expected = 4 / 1024;                        // 4 MiB of chunks
  assert(Math.abs(gb - expected) < 1e-6,
    `expected ${expected} GB from the chunk dir, got ${gb}`);

  fs.rmSync(tmp, { recursive: true, force: true });
}

// Regression test for a PRODUCTION incident (2026-08-13, Avatar, job eUZ3g_6xN).
// Emil cancelled from the dashboard; Tdarr killed the job worker; xav kept
// running at 1267% CPU holding a deleted 39.6 GB file open until it was killed
// by hand. `ps` showed the whole tree reparented to init: PPID 1.
//
// installCancelHandler alone cannot cover this. It listens for SIGTERM/SIGINT/
// disconnect on OUR process -- if that process is killed outright, no handler
// runs. startPpidWatcher is the safety net for exactly that case: a detached
// bash that polls the worker pid and group-kills the encoder when it vanishes.
// av1anEncode armed it; both xav plugins never called it, so the net was not
// there on the one path that needed it.
async function xavEncodeArmsPpidWatchdog() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xav-watchdog-'));
  const workDir = path.join(tmp, 'work');
  fs.mkdirSync(workDir);

  const inputPath = path.join(workDir, 'staged.mkv');
  fs.writeFileSync(inputPath, 'y'.repeat(400 * 1024 * 1024 / 1024));

  const watched = [];
  injectXavPluginStubs({
    captured: fs.readFileSync(XAV_FIXTURE, 'utf8'),
    videoOnlyPath: path.join(workDir, 'xav-video.mkv'),
    // Must clear the no-TTY guard: a tiny output is xav's "encode never ran"
    // signature and the plugin correctly throws before we reach the assertion.
    outputBytes: 8 * 1024 * 1024,
    probeLines: [
      'width=1920', 'height=1040', 'codec_name=av1',
      'nb_read_frames=2899', 'duration=120.910000',
    ],
    watched,
  });

  const realExists = fs.existsSync;
  fs.existsSync = (p) => (p === '/usr/local/bin/xav' ? true : realExists(p));
  try {
    delete require.cache[require.resolve(path.join(SRC, 'xavEncode', 'index.js'))];
    const { plugin } = require(path.join(SRC, 'xavEncode', 'index.js'));
    await plugin({
      inputFileObj: {
        _id: inputPath,
        file: inputPath,
        ffProbeData: {
          streams: [{ codec_type: 'video', width: 1920, height: 1080, nb_frames: '2899' }],
          format: { duration: '120.910000' },
        },
      },
      workDir,
      inputs: {},
      variables: {},
      jobLog: () => {},
      updateWorker: () => {},
    });
  } finally {
    fs.existsSync = realExists;
  }

  assert(watched.includes(STUB_ENCODER_PID),
    'xavEncode must arm the ppid watchdog on the encoder pid -- without it a cancelled '
    + `job orphans xav (production incident eUZ3g_6xN). watched=${JSON.stringify(watched)}`);

  fs.rmSync(tmp, { recursive: true, force: true });
}

async function xavEncodePluginHappyPath() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xav-func-'));
  const workDir = path.join(tmp, 'work');
  fs.mkdirSync(workDir);

  const inputPath = path.join(workDir, 'staged.mkv');
  fs.writeFileSync(inputPath, 'y'.repeat(400 * 1024 * 1024 / 1024)); // small stand-in

  const videoOnlyPath = path.join(workDir, 'xav-video.mkv');
  const captured = fs.readFileSync(XAV_FIXTURE, 'utf8');

  injectXavPluginStubs({
    captured,
    videoOnlyPath,
    outputBytes: 8 * 1024 * 1024,
    probeLines: [
      'width=1920', 'height=1040', 'codec_name=av1',
      'nb_read_frames=2899', 'duration=120.910000',
    ],
  });

  // xav is discovered by existsSync; pretend it is mounted.
  const realExists = fs.existsSync;
  fs.existsSync = (p) => (p === '/usr/local/bin/xav' ? true : realExists(p));

  const updates = [];
  let result;
  try {
    delete require.cache[require.resolve(path.join(SRC, 'xavEncode', 'index.js'))];
    const { plugin } = require(path.join(SRC, 'xavEncode', 'index.js'));
    result = await plugin({
      inputFileObj: {
        _id: inputPath,
        file: inputPath,
        ffProbeData: {
          streams: [{ codec_type: 'video', width: 1920, height: 1080, nb_frames: '2899' }],
          format: { duration: '120.910000' },
        },
      },
      workDir,
      inputs: { target_quality: '72.3-72.7', crf_range: '10-50', preset: 4 },
      variables: {},
      jobLog: () => {},
      updateWorker: (f) => updates.push(f),
    });
  } finally {
    fs.existsSync = realExists;
  }

  assert(result.outputNumber === 1, `expected success port 1, got ${result.outputNumber}`);
  assert(result.outputFileObj._id === path.join(workDir, 'xav-output.mkv'),
    `working file must point at the muxed output, got ${result.outputFileObj._id}`);
  assert(result.outputFileObj.file === result.outputFileObj._id, '_id and file must agree');

  // The dashboard must have received real numbers parsed from the fixture.
  const statuses = updates.filter((u) => u.status).map((u) => u.status);
  assert(statuses.includes('Encoding'), `never reported Encoding, got: ${statuses}`);

  fs.rmSync(tmp, { recursive: true, force: true });
}

async function xavEncodeRefusesInputOutsideWorkDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xav-func-'));
  const workDir = path.join(tmp, 'work');
  const libDir = path.join(tmp, 'library');
  fs.mkdirSync(workDir); fs.mkdirSync(libDir);

  const inputPath = path.join(libDir, 'movie.mkv');
  fs.writeFileSync(inputPath, 'z');

  injectXavPluginStubs({
    captured: '', videoOnlyPath: path.join(workDir, 'xav-video.mkv'),
    outputBytes: 1024, probeLines: [],
  });

  const realExists = fs.existsSync;
  fs.existsSync = (p) => (p === '/usr/local/bin/xav' ? true : realExists(p));

  let threw = null;
  try {
    delete require.cache[require.resolve(path.join(SRC, 'xavEncode', 'index.js'))];
    const { plugin } = require(path.join(SRC, 'xavEncode', 'index.js'));
    await plugin({
      inputFileObj: { _id: inputPath, file: inputPath, ffProbeData: { streams: [], format: {} } },
      workDir,
      inputs: {},
      variables: {},
      jobLog: () => {},
      updateWorker: () => {},
    });
  } catch (err) {
    threw = err;
  } finally {
    fs.existsSync = realExists;
  }

  // xav writes its temp dir next to the input; a library-path input must be
  // refused rather than scattering hashed temp dirs across the library.
  assert(threw !== null, 'must refuse an input outside workDir');
  assert(/working directory/i.test(threw.message),
    `error must explain the workDir requirement, got: ${threw.message}`);

  fs.rmSync(tmp, { recursive: true, force: true });
}

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
