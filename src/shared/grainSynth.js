// src/shared/grainSynth.js
'use strict';

const cp = require('child_process');

// Control points for noise level -> --film-grain / --denoise-noise-level mapping.
// Noise is measured as the YHIGH (90th percentile) of a blur-diff residual.
// Clean synthetic content reads ~1, grainy Blu-ray reads ~5+.
// Linear interpolation between points. Tune these based on test encodes.
const GRAIN_CURVE = [
  { noise: 2,  param: 4 },
  { noise: 3,  param: 8 },
  { noise: 5,  param: 15 },
  { noise: 8,  param: 25 },
  { noise: 12, param: 50 },
];

const NOISE_SKIP_THRESHOLD = 2;
const SAMPLE_FRAMES = 200;

/**
 * Interpolate noise level through the control-point curve.
 * Returns integer 0-50, or 0 if noise is below threshold.
 */
const mapNoiseToGrainParam = (noise) => {
  if (noise < NOISE_SKIP_THRESHOLD) return 0;
  if (noise >= GRAIN_CURVE[GRAIN_CURVE.length - 1].noise) {
    return GRAIN_CURVE[GRAIN_CURVE.length - 1].param;
  }
  for (let i = 0; i < GRAIN_CURVE.length - 1; i++) {
    const lo = GRAIN_CURVE[i];
    const hi = GRAIN_CURVE[i + 1];
    if (noise >= lo.noise && noise < hi.noise) {
      const t = (noise - lo.noise) / (hi.noise - lo.noise);
      return Math.round(lo.param + t * (hi.param - lo.param));
    }
  }
  return 0;
};

/**
 * Estimate noise level from the source file using ffmpeg blur-diff technique.
 * Blurs each frame with avgblur, diffs against original, measures the residual
 * with signalstats YHIGH (90th percentile of luma difference).
 * Clean content reads ~1, grainy film reads ~5+, heavy noise reads 8+.
 * Returns { noise, grainParam }.
 */
const estimateNoise = (inputPath, durationSec, ffmpegBin, dbg) => {
  const seekSec = Math.max(0, (durationSec || 0) / 2 - 5);

  const vf = [
    'split[a][b]',
    '[b]avgblur=7[b]',
    '[a][b]blend=all_mode=difference',
    'signalstats',
    'metadata=mode=print',
  ].join(',');

  const args = [
    '-hide_banner',
    '-ss', String(Math.floor(seekSec)),
    '-i', inputPath,
    '-frames:v', String(SAMPLE_FRAMES),
    '-vf', vf,
    '-f', 'null', '-',
  ];

  dbg(`[grain] estimating noise: ffmpeg ${args.join(' ')}`);

  let output;
  try {
    const result = cp.spawnSync(ffmpegBin, args, {
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf8',
    });
    output = (result.stderr || '') + (result.stdout || '');
    if (result.error || result.status !== 0) {
      dbg(`[grain] ffmpeg noise estimation exited ${result.status || 'unknown'}: ${(result.stderr || '').slice(0, 200)}`);
      return { noise: 0, grainParam: 0 };
    }
  } catch (err) {
    dbg(`[grain] ffmpeg noise estimation failed: ${err.message}`);
    return { noise: 0, grainParam: 0 };
  }

  // Parse YHIGH (90th percentile luma) from blur-diff residual.
  // Output format: [Parsed_metadata_N @ ...] lavfi.signalstats.YHIGH=5
  const yhighRegex = /lavfi\.signalstats\.YHIGH=(\d+(?:\.\d+)?)/g;
  const values = [];
  let match;
  while ((match = yhighRegex.exec(output)) !== null) {
    values.push(parseFloat(match[1]));
  }

  if (values.length === 0) {
    dbg('[grain] no YHIGH values found in noise estimation output');
    return { noise: 0, grainParam: 0 };
  }

  // Use median of YHIGH values (robust to scene changes and outliers)
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  const noise = values.length % 2 === 0
    ? (values[mid - 1] + values[mid]) / 2
    : values[mid];

  const grainParam = mapNoiseToGrainParam(noise);
  dbg(`[grain] noise=${noise.toFixed(2)} -> film-grain=${grainParam} (from ${values.length} frames)`);

  return { noise, grainParam };
};

module.exports = { estimateNoise, mapNoiseToGrainParam, GRAIN_CURVE, NOISE_SKIP_THRESHOLD };
