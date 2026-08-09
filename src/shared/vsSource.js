// src/shared/vsSource.js
'use strict';

// VapourSynth source-filter construction + source-failure gates, shared by the
// av1an-based encoders. lsmas is the only source filter; inputs lsmas cannot
// decode directly (e.g. some VC-1 streams) are first re-wrapped losslessly by
// the mezzanine pre-pass (see shared/mezzanine.js), then read through lsmas.

const fs = require('fs');
const path = require('path');

// Escape a path for single-quoted Python string literals in the .vpy.
const escPy = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/**
 * Frames of decoder run-up forced before every delivered frame.
 *
 * lsmas does not prime the decoder's reorder buffer after a seek: the first
 * outputs of a cold seek come back as featureless mid-grey, with no error. av1an
 * gives every chunk worker exactly one cold seek (`vspipe -s START -e END`), so
 * the blanks land on chunk boundaries -- the grey frames reported on 2026-08-09.
 *
 * Measured on The Conjuring's 998 chunk starts, probed in randomised (cold) order:
 *   run-up 0 -> 21 grey   run-up 4 -> 1 grey   run-up 8+ -> 0 grey
 * 8 is the first depth that reaches zero; the extra frames are cache hits during
 * sequential decode, so the cost is paid only at a chunk start.
 */
const RUNUP_FRAMES = 8;

/**
 * Build the full lsmas .vpy text.
 * @param {object} o
 * @param {string} o.inputPath      source media path (original or mezzanine)
 * @param {string} o.cachePath      lsmas .lwi cache path
 * @param {string[]} [o.downscaleLines]  VapourSynth lines that transform `src`
 * @param {number} [o.runupFrames]  decoder run-up depth; 0 disables the wrapper
 * @returns {string} .vpy text (trailing newline)
 */
function buildSourceVpy({ inputPath, cachePath, downscaleLines, runupFrames = RUNUP_FRAMES }) {
  const lines = ['import vapoursynth as vs', 'core = vs.core'];
  const src = escPy(inputPath);
  const cache = escPy(cachePath);
  const runup = Math.max(0, Math.floor(Number(runupFrames) || 0));

  lines.push(`src = core.lsmas.LWLibavSource(source='${src}', cachefile='${cache}')`);

  // Make frame n depend on n-1..n-RUNUP so the decoder is primed before the frame
  // is handed over. The run-up clips are cropped to a corner: the decode is the
  // point, and holding 16x16 instead of full frames keeps this off the 4K memory
  // ceiling. Output is bit-identical -- ModifyFrame returns source frame n itself.
  if (runup > 0) {
    lines.push(
      '# lsmas cold-seek run-up -- see RUNUP_FRAMES in src/shared/vsSource.js',
      `_ru_n, _ru_w, _ru_h = src.num_frames, min(16, src.width), min(16, src.height)`,
      '_runup = [core.std.Crop(core.std.DuplicateFrames(src, [0] * j)[:_ru_n],'
        + ' right=src.width - _ru_w, bottom=src.height - _ru_h)'
        + ` for j in range(1, ${runup + 1})]`,
      'src = core.std.ModifyFrame(src, [src] + _runup, lambda n, f: f[0].copy())',
    );
  }

  if (Array.isArray(downscaleLines)) {
    for (const l of downscaleLines) lines.push(l);
  }

  lines.push('src.set_output()');
  return lines.join('\n') + '\n';
}

/**
 * av1an writes chunks.json only after scene-splitting succeeds. On a non-zero
 * exit, its absence means av1an died at/before splitting — the signature of a
 * source-decode failure (see split/mod.rs:167 panic when scene detection is
 * starved).
 *
 * Its presence does NOT prove the source is fine: lsmas can index and
 * scene-detect a stream it later fails to decode frame-accurately. Always pair
 * this with isSourceDecodeErrorLine() via shouldRetryWithMezzanine().
 */
function av1anReachedChunking(av1anTempDir) {
  return fs.existsSync(path.join(av1anTempDir, 'chunks.json'));
}

// lsmas failing to hand VapourSynth a frame. This is the ONLY unambiguous
// source-decode signature, and it can surface at any point in a run: a partially
// decodable stream (seen with VC-1 Advanced) indexes and scene-detects fine, then
// fails when a chunk worker seeks into a region lsmas cannot decode -- i.e. long
// after chunks.json exists. Deliberately narrow: a false positive costs a full
// lossless pre-pass of the source.
const SOURCE_DECODE_ERROR = /lsmas:\s*failed to output a video frame|Failed to retrieve frame\s+\d+\s+with error/i;

/**
 * True if an av1an output line reports lsmas failing to deliver a frame.
 * @param {string} line
 */
function isSourceDecodeErrorLine(line) {
  return SOURCE_DECODE_ERROR.test(String(line == null ? '' : line));
}

/**
 * Decide whether a failed av1an run warrants the lossless-mezzanine retry.
 *
 * Two independent source-decode signatures:
 *  - `sawSourceDecodeError` — lsmas explicitly failed to deliver a frame. Valid
 *    at any stage, including mid-encode (the 2026-08-01 VC-1 job failed this way
 *    on chunk 913 of 914, with chunks.json long since written).
 *  - `!reachedChunking` — av1an died at/before scene-splitting, the signature of
 *    scene detection being starved by an undecodable source. Callers that already
 *    proved lsmas can scene-detect this source (crfSearchEncode phase 2) pass
 *    `reachedChunking: true` so only the explicit error triggers a retry.
 *
 * @param {object} o
 * @param {number} o.exitCode              av1an exit code
 * @param {boolean} o.sizeExceeded         run was killed by the size guard
 * @param {boolean} o.sawSourceDecodeError an lsmas frame-delivery error was seen
 * @param {boolean} o.reachedChunking      av1an wrote chunks.json
 * @returns {boolean}
 */
function shouldRetryWithMezzanine({ exitCode, sizeExceeded, sawSourceDecodeError, reachedChunking }) {
  // Our own size-limit kill and a clean exit are never source failures. A run
  // that recovered (exit 0) after a transient frame error needs no retry either.
  if (sizeExceeded || exitCode === 0) return false;
  return Boolean(sawSourceDecodeError) || !reachedChunking;
}

/**
 * Frame count as lsmas itself reports it, from `vspipe --info`. This is the
 * count av1an will chunk against -- and on a stream whose .lwi index overstates
 * what the decoder can deliver, the frames near this count are exactly the ones
 * that fail.
 * @param {string} text  full `vspipe --info` output
 * @returns {number} frame count, or 0 if not found
 */
function parseVspipeFrameCount(text) {
  const m = /^\s*Frames:\s*(\d+)\s*$/m.exec(String(text == null ? '' : text));
  return m ? Number(m[1]) : 0;
}

/**
 * Frame windows to decode as a pre-flight check that lsmas can actually deliver
 * frames from this source, before committing to an encode.
 *
 * The tail comes last and always reaches the final frame: an .lwi index that
 * claims more frames than the decoder can produce fails there, and probing it is
 * what turns a 13-minute discovery (3 doomed chunk retries) into a few seconds.
 * The spread windows ahead of it are single frames, cheap insurance against a
 * source that breaks somewhere in the middle instead.
 *
 * @param {number} frameCount
 * @param {object} [o]
 * @param {number} [o.tailFrames=240]  length of the final window
 * @param {number} [o.spread=6]        single frames sampled before the tail
 * @returns {Array<{start:number,end:number}>} ordered, disjoint, in-range
 */
function buildProbeWindows(frameCount, { tailFrames = 240, spread = 6 } = {}) {
  const n = Math.floor(Number(frameCount) || 0);
  if (n <= 0) return [];

  const last = n - 1;
  const tailStart = Math.max(0, n - Math.max(1, tailFrames));
  const windows = [];

  // Single frames spread over the part of the file the tail window won't cover.
  for (let i = 1; i <= spread; i++) {
    const f = Math.floor((n * i) / (spread + 1));
    if (f < tailStart && (!windows.length || f > windows[windows.length - 1].end)) {
      windows.push({ start: f, end: f });
    }
  }

  windows.push({ start: tailStart, end: last });
  return windows;
}

/**
 * `vspipe` args that decode a frame range and throw the pixels away. Decoding is
 * the point -- `--info` alone reads the index and would not surface a decoder
 * that cannot produce the frames. `--` is vspipe's documented no-output sink
 * ("Request all frames but don't output them"), so nothing is written.
 * @param {object} o
 * @param {string} o.vpyPath
 * @param {number} o.start
 * @param {number} o.end
 * @returns {string[]}
 */
function buildProbeArgs({ vpyPath, start, end }) {
  return ['--start', String(start), '--end', String(end), vpyPath, '--'];
}

/**
 * Parse av1an's scenecut summary, e.g.
 *   `INFO encode_file: scenecut: found 1 scene(s) [with extra_splits (240 frames): 914 scene(s)]`
 * @param {string} line
 * @returns {{detected:number, extraSplitFrames:number, totalChunks:number}|null}
 */
function parseScenecutLine(line) {
  const m = /found\s+(\d+)\s+scene\(s\)(?:\s*\[with\s+extra_splits\s*\((\d+)\s*frames?\):\s*(\d+)\s+scene\(s\)\])?/i
    .exec(String(line == null ? '' : line));
  if (!m) return null;
  return {
    detected: Number(m[1]),
    extraSplitFrames: m[2] ? Number(m[2]) : 0,
    totalChunks: m[3] ? Number(m[3]) : Number(m[1]),
  };
}

/**
 * True when av1an found NO scene cuts at all across a file long enough that this
 * cannot be real content -- the signature of a scenecut analyzer being fed
 * nothing usable (seen on the VC-1 remux: 1 scene across 914 chunks). Diagnostic
 * only: a genuinely single-shot clip is legitimately one scene, so this warns
 * rather than triggering anything.
 * @param {ReturnType<typeof parseScenecutLine>} info
 * @param {number} [minChunks=10]
 */
function isDegenerateSceneDetection(info, minChunks = 10) {
  return Boolean(info) && info.detected === 1 && info.totalChunks >= minChunks;
}

/**
 * crfSearchEncode gate. av1an `--sc-only` serializes its scenes JSON only after
 * extra-splits, so a starved/panicked scene-detection leaves it missing or with
 * empty scene lists. Non-empty scenes => detection succeeded.
 */
function sceneDetectProducedScenes(scenesJsonPath) {
  try {
    const data = JSON.parse(fs.readFileSync(scenesJsonPath, 'utf8'));
    const scenes = Array.isArray(data.scenes) ? data.scenes : [];
    const splits = Array.isArray(data.split_scenes) ? data.split_scenes : [];
    return scenes.length > 0 || splits.length > 0;
  } catch (_) {
    return false;
  }
}

module.exports = {
  RUNUP_FRAMES,
  buildSourceVpy,
  av1anReachedChunking,
  sceneDetectProducedScenes,
  isSourceDecodeErrorLine,
  shouldRetryWithMezzanine,
  parseVspipeFrameCount,
  buildProbeWindows,
  buildProbeArgs,
  parseScenecutLine,
  isDegenerateSceneDetection,
};
