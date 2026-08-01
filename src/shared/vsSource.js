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
 * Build the full lsmas .vpy text.
 * @param {object} o
 * @param {string} o.inputPath      source media path (original or mezzanine)
 * @param {string} o.cachePath      lsmas .lwi cache path
 * @param {string[]} [o.downscaleLines]  VapourSynth lines that transform `src`
 * @returns {string} .vpy text (trailing newline)
 */
function buildSourceVpy({ inputPath, cachePath, downscaleLines }) {
  const lines = ['import vapoursynth as vs', 'core = vs.core'];
  const src = escPy(inputPath);
  const cache = escPy(cachePath);

  lines.push(`src = core.lsmas.LWLibavSource(source='${src}', cachefile='${cache}')`);

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
  buildSourceVpy,
  av1anReachedChunking,
  sceneDetectProducedScenes,
  isSourceDecodeErrorLine,
  shouldRetryWithMezzanine,
};
