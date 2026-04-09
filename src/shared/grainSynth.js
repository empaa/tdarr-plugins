// src/shared/grainSynth.js
'use strict';

const cp = require('child_process');
const path = require('path');
const fs = require('fs');

// Control points for sigma -> NLMeans h parameter mapping.
// Calibrated from 5 sources (2 action, 1 horror, 1 CGI, 1 drama)
// using Laplacian spatial noise estimation + ternary PSNR search.
// Linear fit: h ≈ 0.86 * sigma - 0.52 (RMSE=0.31 across 40 data points).
const DENOISE_CURVE = [
  { sigma: 1.38, h: 0.64 },
  { sigma: 1.81, h: 1.03 },
  { sigma: 2.15, h: 1.31 },
  { sigma: 2.45, h: 1.57 },
  { sigma: 2.95, h: 2.02 },
  { sigma: 3.38, h: 2.39 },
  { sigma: 3.76, h: 2.74 },
  { sigma: 4.57, h: 3.44 },
];

// Control points for sigma -> av1an --photon-noise value mapping.
// TODO: photon-noise calibration needs a different approach — Laplacian
// measurement of decoded AV1 saturates at max values. For now, use a
// conservative linear estimate based on the av1an community guidelines.
const PHOTON_CURVE = [
  { sigma: 1.38, param: 4 },
  { sigma: 1.81, param: 6 },
  { sigma: 2.15, param: 8 },
  { sigma: 2.45, param: 10 },
  { sigma: 2.95, param: 14 },
  { sigma: 3.38, param: 18 },
  { sigma: 3.76, param: 22 },
  { sigma: 4.57, param: 30 },
];

// Below this Laplacian sigma, source is clean enough to skip grain synthesis.
// Derived from calibration: h drops below meaningful denoising (~0.1) at ~0.6.
// Clean CGI sources read 0.1-0.3, noisy film reads 0.7+.
const SIGMA_SKIP_THRESHOLD = 0.6;
const CHROMA_SIGMA_RATIO = 0.5;
const SAMPLE_REGIONS = 4;
const FRAMES_PER_REGION = 50;

/**
 * Linearly interpolate through a curve of {sigma, <valueKey>} control points.
 * Returns 0 if sigma is below SIGMA_SKIP_THRESHOLD.
 */
const interpolateCurve = (curve, valueKey, sigma) => {
  if (sigma < SIGMA_SKIP_THRESHOLD) return 0;
  if (sigma >= curve[curve.length - 1].sigma) {
    return curve[curve.length - 1][valueKey];
  }
  for (let i = 0; i < curve.length - 1; i++) {
    const lo = curve[i];
    const hi = curve[i + 1];
    if (sigma >= lo.sigma && sigma < hi.sigma) {
      const t = (sigma - lo.sigma) / (hi.sigma - lo.sigma);
      return lo[valueKey] + t * (hi[valueKey] - lo[valueKey]);
    }
  }
  return 0;
};

const mapSigmaToNlmH = (sigma) => {
  const h = interpolateCurve(DENOISE_CURVE, 'h', sigma);
  return Math.round(h * 100) / 100;
};

const mapSigmaToPhotonNoise = (sigma) => {
  const pn = interpolateCurve(PHOTON_CURVE, 'param', sigma);
  return Math.round(pn);
};

/**
 * Escape a path for embedding in a Python single-quoted string.
 */
const esc = (p) => p.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/**
 * Build a VapourSynth script that samples SAMPLE_REGIONS regions of the video,
 * applies a Laplacian convolution to each frame (spatial noise estimation),
 * and prints SIGMA:<value> to stderr. Uses the Immerkaer estimator:
 *   sigma = sqrt(pi/2) * (1/6) * mean(|Laplacian|) * 255
 * This is immune to motion (single-frame, spatial-only) unlike temporal
 * differencing, and only requires built-in VS filters.
 */
const buildNoiseVpy = (inputPath, lwiCachePath, starts) => {
  const src = esc(inputPath);
  const cache = esc(lwiCachePath);
  const fpr = FRAMES_PER_REGION;

  const lines = [
    'import vapoursynth as vs',
    'import sys',
    'import math',
    'core = vs.core',
    `clip = core.lsmas.LWLibavSource(source='${src}', cachefile='${cache}')`,
    'luma = core.std.ShufflePlanes(clip, planes=0, colorfamily=vs.GRAY)',
    // Convert to 32-bit float to avoid clipping in Laplacian convolution
    'luma = core.resize.Point(luma, format=vs.GRAYS)',
  ];

  // Unroll regions — VS needs explicit clip variables, not a loop.
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    lines.push(`r${i} = luma[${s}:${s + fpr}]`);
    // Laplacian 3x3 kernel: [1, -2, 1, -2, 4, -2, 1, -2, 1]
    lines.push(`lap${i} = core.std.Convolution(r${i}, matrix=[1, -2, 1, -2, 4, -2, 1, -2, 1])`);
    lines.push(`d${i} = core.std.PlaneStats(core.std.Expr(lap${i}, expr=['x abs']))`);
  }

  // Splice regions together.
  const parts = starts.map((_, i) => `d${i}`);
  lines.push(`out = ${parts[0]}${parts.slice(1).map(p => ' + ' + p).join('')}`);

  // ModifyFrame callback prints SIGMA to stderr.
  // Immerkaer: sigma = sqrt(pi/2) * (1/6) * mean(|Laplacian|) * 255
  lines.push('');
  lines.push('def emit_sigma(n, f):');
  lines.push('    avg = f.props["PlaneStatsAverage"]');
  lines.push('    sigma = math.sqrt(math.pi / 2.0) * (1.0 / 6.0) * avg * 255.0');
  lines.push('    sys.stderr.write("SIGMA:{:.6f}\\n".format(sigma))');
  lines.push('    sys.stderr.flush()');
  lines.push('    return f');
  lines.push('');
  lines.push('out = core.std.ModifyFrame(out, out, emit_sigma)');
  lines.push('out.set_output()');

  return lines.join('\n') + '\n';
};

/**
 * Estimate noise sigma from the source file using VapourSynth spatial
 * Laplacian estimation (Immerkaer method). Samples SAMPLE_REGIONS regions
 * spread across the video. Immune to motion unlike temporal differencing.
 * Returns { sigma, nlmH, nlmChromaH, photonNoise }.
 */
const estimateNoise = (inputPath, durationSec, totalFrames, vspipeBin, lwiCache, dbg) => {
  if (totalFrames < FRAMES_PER_REGION + 10) {
    dbg('[grain] totalFrames too small for noise estimation, skipping');
    return { sigma: 0, nlmH: 0, nlmChromaH: 0, photonNoise: 0 };
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
    return { sigma: 0, nlmH: 0, nlmChromaH: 0, photonNoise: 0 };
  }

  let output = '';
  try {
    const args = ['-p', vpyPath, '--'];
    dbg(`[grain] estimating noise: vspipe ${args.join(' ')}`);

    // '--' tells vspipe to process all frames without writing output.
    // SIGMA values are printed to stderr by the ModifyFrame callback.
    const result = cp.spawnSync(vspipeBin, args, {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf8',
    });

    output = (result.stderr || '') + (result.stdout || '');

    if (result.error) {
      dbg(`[grain] vspipe error: ${result.error.message}`);
      return { sigma: 0, nlmH: 0, nlmChromaH: 0, photonNoise: 0 };
    }
    if (result.status !== 0) {
      dbg(`[grain] vspipe exited ${result.status}: ${(result.stderr || '').slice(0, 200)}`);
      return { sigma: 0, nlmH: 0, nlmChromaH: 0, photonNoise: 0 };
    }
  } catch (err) {
    dbg(`[grain] vspipe failed: ${err.message}`);
    return { sigma: 0, nlmH: 0, nlmChromaH: 0, photonNoise: 0 };
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
    return { sigma: 0, nlmH: 0, nlmChromaH: 0, photonNoise: 0 };
  }

  // Median across all sampled frames (robust to scene changes / motion).
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  const sigma = values.length % 2 === 0
    ? (values[mid - 1] + values[mid]) / 2
    : values[mid];

  const nlmH = mapSigmaToNlmH(sigma);
  const nlmChromaH = mapSigmaToNlmH(sigma * CHROMA_SIGMA_RATIO);
  const photonNoise = mapSigmaToPhotonNoise(sigma);
  dbg(`[grain] estimated sigma=${sigma.toFixed(2)} -> nlmH=${nlmH} nlmChromaH=${nlmChromaH} photon-noise=${photonNoise} (from ${values.length} frames)`);

  return { sigma, nlmH, nlmChromaH, photonNoise };
};

module.exports = {
  estimateNoise, mapSigmaToNlmH, mapSigmaToPhotonNoise,
  DENOISE_CURVE, PHOTON_CURVE, SIGMA_SKIP_THRESHOLD, CHROMA_SIGMA_RATIO,
};
