// src/shared/grainSynth.js
'use strict';

const cp = require('child_process');
const path = require('path');
const fs = require('fs');

// Control points for sigma -> --film-grain / --denoise-noise-level mapping.
// Sigma is estimated via VapourSynth temporal frame differencing (luma abs diff
// between successive frames, converted to Gaussian sigma). Clean content reads
// ~0, moderate grain ~3, heavy ~6+. Linear interpolation between points.
// Tune these based on test encodes.
const GRAIN_CURVE = [
  { sigma: 2,  param: 4 },
  { sigma: 4,  param: 8 },
  { sigma: 6,  param: 15 },
  { sigma: 10, param: 25 },
  { sigma: 15, param: 50 },
];

const SIGMA_SKIP_THRESHOLD = 2;
const SAMPLE_REGIONS = 4;
const FRAMES_PER_REGION = 50;

/**
 * Interpolate sigma through the control-point curve.
 * Returns integer 0-50, or 0 if sigma is below threshold.
 */
const mapSigmaToGrainParam = (sigma) => {
  if (sigma < SIGMA_SKIP_THRESHOLD) return 0;
  if (sigma >= GRAIN_CURVE[GRAIN_CURVE.length - 1].sigma) {
    return GRAIN_CURVE[GRAIN_CURVE.length - 1].param;
  }
  for (let i = 0; i < GRAIN_CURVE.length - 1; i++) {
    const lo = GRAIN_CURVE[i];
    const hi = GRAIN_CURVE[i + 1];
    if (sigma >= lo.sigma && sigma < hi.sigma) {
      const t = (sigma - lo.sigma) / (hi.sigma - lo.sigma);
      return Math.round(lo.param + t * (hi.param - lo.param));
    }
  }
  return 0;
};

/**
 * Escape a path for embedding in a Python single-quoted string.
 */
const esc = (p) => p.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/**
 * Build a VapourSynth script that samples SAMPLE_REGIONS regions of the video,
 * computes per-frame luma abs temporal diff, and prints SIGMA:<value> to stderr
 * for each processed frame. sigma = avg * 255.0 * 1.2533 / 1.4142 converts
 * mean absolute diff (0-1 range) to an approximate Gaussian noise sigma.
 */
const buildNoiseVpy = (inputPath, lwiCachePath, starts) => {
  const src = esc(inputPath);
  const cache = esc(lwiCachePath);
  const fpr = FRAMES_PER_REGION;

  const lines = [
    'import vapoursynth as vs',
    'import sys',
    'core = vs.core',
    `clip = core.lsmas.LWLibavSource(source='${src}', cachefile='${cache}')`,
    'luma = core.std.ShufflePlanes(clip, planes=0, colorfamily=vs.GRAY)',
  ];

  // Unroll regions — VS needs explicit clip variables, not a loop.
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    lines.push(`r${i} = luma[${s}:${s + fpr}]`);
    lines.push(`d${i} = core.std.Expr([r${i}[:-1], r${i}[1:]], expr=['x y - abs'])`);
    lines.push(`d${i} = core.std.PlaneStats(d${i})`);
  }

  // Splice regions together.
  const parts = starts.map((_, i) => `d${i}`);
  lines.push(`out = ${parts[0]}${parts.slice(1).map(p => ' + ' + p).join('')}`);

  // ModifyFrame callback prints SIGMA to stderr.
  lines.push('');
  lines.push('def emit_sigma(n, f):');
  lines.push('    avg = f.props["PlaneStatsAverage"]');
  lines.push('    sigma = avg * 255.0 * 1.2533 / 1.4142');
  lines.push('    sys.stderr.write("SIGMA:{:.6f}\\n".format(sigma))');
  lines.push('    sys.stderr.flush()');
  lines.push('    return f');
  lines.push('');
  lines.push('out = core.std.ModifyFrame(out, out, emit_sigma)');
  lines.push('out.set_output()');

  return lines.join('\n') + '\n';
};

/**
 * Estimate noise sigma from the source file using VapourSynth temporal luma
 * differencing. Samples SAMPLE_REGIONS regions spread across the video.
 * Returns { sigma, grainParam }.
 */
const estimateNoise = (inputPath, durationSec, totalFrames, vspipeBin, lwiCache, dbg) => {
  if (totalFrames < FRAMES_PER_REGION + 10) {
    dbg('[grain] totalFrames too small for noise estimation, skipping');
    return { sigma: 0, grainParam: 0 };
  }

  // Sample positions at 15%, 35%, 55%, 75% of totalFrames, clamped to valid range.
  const positions = [0.15, 0.35, 0.55, 0.75];
  const maxStart = totalFrames - FRAMES_PER_REGION - 1;
  const starts = positions.map((p) => Math.min(Math.max(0, Math.floor(p * totalFrames)), maxStart));

  dbg(`[grain] source: ${totalFrames} frames, ${durationSec.toFixed(1)}s`);

  const vpyPath = path.join(path.dirname(lwiCache), 'noise_estimate.vpy');
  const script = buildNoiseVpy(inputPath, lwiCache, starts);

  dbg(`[grain] writing noise estimation script to ${vpyPath}`);

  try {
    fs.writeFileSync(vpyPath, script, 'utf8');
  } catch (err) {
    dbg(`[grain] failed to write .vpy script: ${err.message}`);
    return { sigma: 0, grainParam: 0 };
  }

  let output = '';
  try {
    const args = ['-p', vpyPath, '-'];
    dbg(`[grain] estimating noise: vspipe ${args.join(' ')}`);

    const result = cp.spawnSync(vspipeBin, args, {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf8',
    });

    output = (result.stderr || '') + (result.stdout || '');

    if (result.error) {
      dbg(`[grain] vspipe error: ${result.error.message}`);
      return { sigma: 0, grainParam: 0 };
    }
    if (result.status !== 0) {
      dbg(`[grain] vspipe exited ${result.status}: ${(result.stderr || '').slice(0, 200)}`);
      return { sigma: 0, grainParam: 0 };
    }
  } catch (err) {
    dbg(`[grain] vspipe failed: ${err.message}`);
    return { sigma: 0, grainParam: 0 };
  } finally {
    try { fs.unlinkSync(vpyPath); } catch (_) { /* ignore */ }
  }

  // Parse SIGMA: lines printed by the ModifyFrame callback.
  const sigmaRegex = /SIGMA:([\d.]+)/g;
  const values = [];
  let match;
  while ((match = sigmaRegex.exec(output)) !== null) {
    const v = parseFloat(match[1]);
    if (isFinite(v)) values.push(v);
  }

  if (values.length === 0) {
    dbg('[grain] no SIGMA values found in vspipe output');
    return { sigma: 0, grainParam: 0 };
  }

  // Median across all sampled frames (robust to scene changes / motion).
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  const sigma = values.length % 2 === 0
    ? (values[mid - 1] + values[mid]) / 2
    : values[mid];

  const grainParam = mapSigmaToGrainParam(sigma);
  dbg(`[grain] estimated sigma=${sigma.toFixed(2)} -> film-grain=${grainParam} (from ${values.length} frames)`);

  return { sigma, grainParam };
};

module.exports = { estimateNoise, mapSigmaToGrainParam, GRAIN_CURVE, SIGMA_SKIP_THRESHOLD };
