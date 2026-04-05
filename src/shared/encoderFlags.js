// src/shared/encoderFlags.js
'use strict';

const primTable = {
  bt709:     { aom: 'bt709',    svt: 1 },
  bt470m:    { aom: 'bt470m',   svt: 4 },
  bt470bg:   { aom: 'bt470bg',  svt: 5 },
  smpte170m: { aom: 'smpte170m', svt: 6 },
  smpte240m: { aom: 'smpte240m', svt: 7 },
  film:      { aom: 'film',     svt: 8 },
  bt2020:    { aom: 'bt2020',   svt: 9 },
  smpte428:  { aom: 'smpte428', svt: 10 },
  smpte431:  { aom: 'smpte431', svt: 11 },
  smpte432:  { aom: 'smpte432', svt: 12 },
};

const transTable = {
  bt709:         { aom: 'bt709',        svt: 1 },
  bt470m:        { aom: 'bt470m',       svt: 4 },
  bt470bg:       { aom: 'bt470bg',      svt: 5 },
  smpte170m:     { aom: 'smpte170m',    svt: 6 },
  smpte240m:     { aom: 'smpte240m',    svt: 7 },
  linear:        { aom: 'linear',       svt: 8 },
  log100:        { aom: 'log100',       svt: 9 },
  log316:        { aom: 'log316',       svt: 10 },
  iec61966:      { aom: 'iec61966',     svt: 12 },
  'bt2020-10':   { aom: 'bt2020-10bit', svt: 14 },
  'bt2020-12':   { aom: 'bt2020-12bit', svt: 15 },
  smpte2084:     { aom: 'smpte2084',    svt: 16 },
  smpte428:      { aom: 'smpte428',     svt: 17 },
  'arib-std-b67': { aom: 'arib-std-b67', svt: 18 },
};

const matTable = {
  bt709:                { aom: 'bt709',              svt: 1 },
  fcc:                  { aom: 'fcc73',              svt: 4 },
  bt470bg:              { aom: 'bt470bg',            svt: 5 },
  smpte170m:            { aom: 'smpte170m',          svt: 6 },
  smpte240m:            { aom: 'smpte240m',          svt: 7 },
  bt2020nc:             { aom: 'bt2020ncl',          svt: 9 },
  bt2020ncl:            { aom: 'bt2020ncl',          svt: 9 },
  bt2020c:              { aom: 'bt2020cl',           svt: 10 },
  bt2020cl:             { aom: 'bt2020cl',           svt: 10 },
  smpte2085:            { aom: 'smpte2085',          svt: 11 },
  'chroma-derived-ncl': { aom: 'chroma-derived-ncl', svt: 12 },
  'chroma-derived-cl':  { aom: 'chroma-derived-cl',  svt: 13 },
  ictcp:                { aom: 'ictcp',              svt: 14 },
};

const chromaTable = {
  left:    { svt: 1 },
  topleft: { svt: 2 },
};

const detectHdrMeta = (stream) => {
  const prim   = primTable[stream.color_primaries];
  const trans  = transTable[stream.color_transfer];
  const matrix = matTable[stream.color_space];
  const chroma = chromaTable[stream.chroma_location];

  let hdrAom = '';
  let hdrSvt = '';

  if (prim && trans && matrix) {
    hdrAom = `--color-primaries=${prim.aom} --transfer-characteristics=${trans.aom} --matrix-coefficients=${matrix.aom}`;
    hdrSvt = [
      `--color-primaries ${prim.svt}`,
      `--transfer-characteristics ${trans.svt}`,
      `--matrix-coefficients ${matrix.svt}`,
      chroma ? `--chroma-sample-position ${chroma.svt}` : '',
    ].filter(Boolean).join(' ');
  }

  return { prim, trans, matrix, chroma, hdrAom, hdrSvt };
};

const buildAomFlags = (preset, threadsPerWorker, hdrAom, grainParam) => {
  const grainFlags = grainParam > 0
    ? `--denoise-noise-level=${grainParam}`
    : '--enable-dnl-denoising=0';
  return [
    '--end-usage=q', `--cpu-used=${preset}`, `--threads=${threadsPerWorker}`,
    '--tune=ssim', '--enable-fwd-kf=0', '--disable-kf', '--kf-max-dist=9999',
    '--enable-qm=1', '--bit-depth=10', '--lag-in-frames=48',
    '--tile-columns=0', '--tile-rows=0', '--sb-size=dynamic',
    '--deltaq-mode=0', '--aq-mode=0', '--arnr-strength=1', '--arnr-maxframes=4',
    '--enable-chroma-deltaq=1', grainFlags,
    '--disable-trellis-quant=0', '--quant-b-adapt=1',
    '--enable-keyframe-filtering=1', hdrAom,
  ].filter(Boolean).join(' ');
};

const buildSvtFlags = (preset, svtLp, hdrSvt, grainParam) => {
  const grainFlags = grainParam > 0
    ? [`--film-grain ${grainParam}`, '--film-grain-denoise 1']
    : [];
  return [
    '--rc 0', `--preset ${preset}`, '--tune 1', '--input-depth 10',
    '--lookahead 48', '--keyint -1', '--irefresh-type 2',
    '--enable-overlays 1', '--enable-variance-boost 1',
    '--variance-boost-strength 2', '--variance-octile 6',
    '--enable-qm 1', '--qm-min 0', '--qm-max 15',
    '--chroma-qm-min 8', '--chroma-qm-max 15',
    '--tf-strength 1', '--sharpness 1', '--tile-columns 1',
    '--scm 0', `--lp ${svtLp}`, hdrSvt,
    ...grainFlags,
  ].filter(Boolean).join(' ');
};

const buildAbAv1SvtFlags = (lp, lookahead, grainParam) => {
  const grainFlags = grainParam > 0
    ? [`--svt film-grain=${grainParam}`, '--svt film-grain-denoise=1']
    : [];
  return [
    '--svt tune=1', '--svt enable-variance-boost=1',
    '--svt variance-boost-strength=2', '--svt variance-octile=6',
    '--svt enable-qm=1', '--svt qm-min=0', '--svt qm-max=15',
    '--svt chroma-qm-min=8', '--svt chroma-qm-max=15',
    '--svt irefresh-type=2', '--svt scm=0', '--svt sharpness=1',
    '--svt tf-strength=1', '--svt tile-columns=1', '--svt enable-overlays=1',
    `--svt lookahead=${lookahead}`, '--keyint 10s', '--scd true',
    `--svt lp=${lp}`,
    ...grainFlags,
  ].join(' ');
};

// SVT-AV1 effective thread limits per encoder preset.
// Lower presets have algorithmic dependencies that prevent parallelization.
// See: https://gitlab.com/AOMediaCodec/SVT-AV1/-/issues/1843
const SVT_LP_CAP_BY_PRESET = {
  0: 4, 1: 4, 2: 6, 3: 6,
  4: 8, 5: 12, 6: 16,
  7: 32, 8: 32, 9: 32, 10: 32, 11: 32, 12: 32, 13: 32,
};

const capSvtLpByPreset = (lp, encPreset) => {
  const cap = SVT_LP_CAP_BY_PRESET[encPreset];
  return cap != null ? Math.min(lp, cap) : lp;
};

const THREAD_PRESETS = {
  safe:        { aomWorkerDiv: 4, aomOversub: 1.0, svtWorkerFill: 0.5,  svtLpMax: 6,  vmafThreadDiv: 8, halve4kHdr: true },
  balanced:    { aomWorkerDiv: 4, aomOversub: 2.0, svtWorkerFill: 0.9,  svtLpMax: 20, vmafThreadDiv: 2, halve4kHdr: false },
  aggressive:  { aomWorkerDiv: 4, aomOversub: 4.0, svtWorkerFill: 1.0,  svtLpMax: 28, vmafThreadDiv: 2, halve4kHdr: false },
  max:         { aomWorkerDiv: 4, aomOversub: 6.0, svtWorkerFill: 1.5,  svtLpMax: 28, vmafThreadDiv: 2, halve4kHdr: false },
};

const resolveThreadStrategy = (strategyName, overrides) => {
  const base = strategyName === 'custom'
    ? THREAD_PRESETS.aggressive
    : (THREAD_PRESETS[strategyName] || THREAD_PRESETS.safe);
  return { preset: base, overrides: overrides || {} };
};

const calculateThreadBudget = (availableThreads, encoder, is4kHdr, options) => {
  const opts = options || {};
  const strategyName = opts.strategy || 'safe';
  const { preset, overrides } = resolveThreadStrategy(strategyName, opts);

  let threadsPerWorker, maxWorkers;

  if (encoder === 'aom') {
    maxWorkers = Math.max(1, Math.floor(availableThreads / preset.aomWorkerDiv));
    threadsPerWorker = Math.max(1, Math.floor(availableThreads * preset.aomOversub / maxWorkers));
  } else {
    // SVT-AV1: use capped lp, then fill workers by strategy aggressiveness
    let lp = Math.min(preset.svtLpMax, availableThreads);
    if (opts.encPreset != null) lp = capSvtLpByPreset(lp, opts.encPreset);
    threadsPerWorker = lp;
    const maxPossibleWorkers = Math.max(1, Math.floor(availableThreads / lp));
    maxWorkers = Math.max(1, Math.ceil(maxPossibleWorkers * preset.svtWorkerFill));
  }

  if (opts.singleProcess) {
    let lp = Math.min(preset.svtLpMax, availableThreads);
    if (encoder !== 'aom' && opts.encPreset != null) lp = capSvtLpByPreset(lp, opts.encPreset);
    threadsPerWorker = lp;
    maxWorkers = 1;
  }

  if (is4kHdr && preset.halve4kHdr) {
    maxWorkers = Math.max(1, Math.floor(maxWorkers / 2));
  }

  let vmafThreads = Math.max(2, Math.floor(availableThreads / preset.vmafThreadDiv));

  // Apply explicit overrides
  if (overrides.workers != null) maxWorkers = overrides.workers;
  if (overrides.threadsPerWorker != null) threadsPerWorker = overrides.threadsPerWorker;
  if (overrides.vmafThreads != null) vmafThreads = overrides.vmafThreads;

  const svtLp = Math.min(preset.svtLpMax, threadsPerWorker);

  return { maxWorkers, threadsPerWorker, svtLp, vmafThreads, strategy: strategyName };
};

module.exports = {
  detectHdrMeta,
  buildAomFlags,
  buildSvtFlags,
  buildAbAv1SvtFlags,
  calculateThreadBudget,
  capSvtLpByPreset,
  THREAD_PRESETS,
};
