// src/shared/vsSource.js
'use strict';

// VapourSynth source-filter construction + source-failure gates, shared by the
// av1an-based encoders. lsmas is the fast default; BestSource (core.bs) is a
// ffmpeg-based fallback for inputs lsmas cannot decode (e.g. some VC-1 streams).

const fs = require('fs');
const path = require('path');

const SOURCE_LSMAS = 'lsmas';
const SOURCE_BESTSOURCE = 'bestsource';

// Escape a path for single-quoted Python string literals in the .vpy.
const escPy = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/**
 * Build the full .vpy text for a chosen source filter.
 * @param {object} o
 * @param {string} o.sourceFilter   SOURCE_LSMAS | SOURCE_BESTSOURCE
 * @param {string} o.inputPath      source media path
 * @param {string} o.cachePath      lsmas .lwi cache / BestSource cachepath
 * @param {number} [o.fpsNum]       ffprobe framerate numerator (BestSource only)
 * @param {number} [o.fpsDen]       ffprobe framerate denominator (BestSource only)
 * @param {string[]} [o.downscaleLines]  VapourSynth lines that transform `src`
 * @returns {string} .vpy text (trailing newline)
 */
function buildSourceVpy({ sourceFilter, inputPath, cachePath, fpsNum, fpsDen, downscaleLines }) {
  const lines = ['import vapoursynth as vs', 'core = vs.core'];
  const src = escPy(inputPath);
  const cache = escPy(cachePath);

  if (sourceFilter === SOURCE_BESTSOURCE) {
    lines.push(`src = core.bs.VideoSource(source='${src}', cachepath='${cache}')`);
    // BestSource can misdetect the framerate (e.g. VC-1 remuxes report ~10.979
    // fps for true 23.976). Relabel to ffprobe's rate; AssumeFPS is metadata
    // only and preserves the exact frame count. Skipped if fps is unknown.
    if (fpsNum > 0 && fpsDen > 0) {
      lines.push(`src = core.std.AssumeFPS(src, fpsnum=${fpsNum}, fpsden=${fpsDen})`);
    }
  } else {
    lines.push(`src = core.lsmas.LWLibavSource(source='${src}', cachefile='${cache}')`);
  }

  if (Array.isArray(downscaleLines)) {
    for (const l of downscaleLines) lines.push(l);
  }

  lines.push('src.set_output()');
  return lines.join('\n') + '\n';
}

/**
 * av1anEncode gate. av1an writes chunks.json only after scene-splitting
 * succeeds. On a non-zero exit, its absence means av1an died at/before
 * splitting — the signature of a source-decode failure (see split/mod.rs:167
 * panic when scene detection is starved). Present => the failure is downstream
 * of the source and must NOT be retried.
 */
function av1anReachedChunking(av1anTempDir) {
  return fs.existsSync(path.join(av1anTempDir, 'chunks.json'));
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
  SOURCE_LSMAS,
  SOURCE_BESTSOURCE,
  buildSourceVpy,
  av1anReachedChunking,
  sceneDetectProducedScenes,
};
