// src/shared/grainSynth.js
'use strict';

const cp = require('child_process');

// Control points for sigma -> --film-grain / --denoise-noise-level mapping.
// Linear interpolation between points. Tune these based on test encodes.
const GRAIN_CURVE = [
  { sigma: 2,  param: 4 },
  { sigma: 4,  param: 8 },
  { sigma: 6,  param: 15 },
  { sigma: 10, param: 25 },
  { sigma: 15, param: 50 },
];

const SIGMA_SKIP_THRESHOLD = 2;
const SAMPLE_FRAMES = 200;

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
 * Estimate noise sigma from the source file using ffmpeg signalstats.
 * Samples SAMPLE_FRAMES frames from the middle of the file.
 * Returns { sigma, grainParam }.
 */
const estimateNoise = (inputPath, durationSec, ffmpegBin, dbg) => {
  const seekSec = Math.max(0, (durationSec || 0) / 2 - 5);

  const args = [
    '-hide_banner',
    '-ss', String(Math.floor(seekSec)),
    '-i', inputPath,
    '-frames:v', String(SAMPLE_FRAMES),
    '-vf', 'signalstats',
    '-f', 'null', '-',
  ];

  dbg(`[grain] estimating noise: ffmpeg ${args.join(' ')}`);

  let stderr;
  try {
    const result = cp.spawnSync(ffmpegBin, args, {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf8',
    });
    stderr = (result.stderr || '') + (result.stdout || '');
  } catch (err) {
    dbg(`[grain] ffmpeg signalstats failed: ${err.message}`);
    return { sigma: 0, grainParam: 0 };
  }

  // Parse YHUMED (luma temporal difference median) values from signalstats output.
  // Each frame produces a line like: [Parsed_signalstats_0 @ ...] YHUMED=4.00 ...
  const humedRegex = /YHUMED=(\d+(?:\.\d+)?)/g;
  const values = [];
  let match;
  while ((match = humedRegex.exec(stderr)) !== null) {
    values.push(parseFloat(match[1]));
  }

  if (values.length === 0) {
    dbg('[grain] no YHUMED values found in signalstats output');
    return { sigma: 0, grainParam: 0 };
  }

  // Use median of YHUMED values as sigma estimate (robust to scene changes)
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
