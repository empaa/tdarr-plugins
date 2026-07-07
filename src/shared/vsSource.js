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
  buildSourceVpy,
  av1anReachedChunking,
  sceneDetectProducedScenes,
};
