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

const TESTS = [
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
  ['xav: argv is video-only and carries TQ', xavArgsAreVideoOnlyAndCarryTq],
  ['xav: pipe argv keeps input, ffmpeg scales', xavPipeArgsKeepInputAndScale],
  ['xav: strips params xav rejects outright', xavFiltersParamsXavRejects],
  ['xav: param filter handles empty and clean input', xavParamFilterHandlesEmptyAndClean],
  ['xav: size projection is frame-proportional', xavProjectionIsFrameProportional],
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

  // Converged and genuinely over budget.
  const settled = [
    { percent: 40, projectedBytes: 900 },
    { percent: 45, projectedBytes: 850 },
    { percent: 50, projectedBytes: 800 },
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

async function xavProjectionIsFrameProportional() {
  const { projectVideoBytes } = require(path.join(SRC, 'shared', 'xav.js'));
  assert(projectVideoBytes(500, 1000, 2000) === 1000, 'half the frames should project double');
  assert(projectVideoBytes(0, 1000, 2000) === 0, 'no bytes yet projects zero');
  assert(projectVideoBytes(500, 0, 2000) === 0, 'no frames yet projects zero');
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
