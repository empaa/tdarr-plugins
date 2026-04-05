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

const svtConfig = (preset, lp, hdrSvt, grainParam) => {
  const entries = [
    ['rc', '0'],
    ['preset', String(preset)],
    ['tune', '1'],
    ['input-depth', '10'],
    ['lookahead', '48'],
    ['keyint', '-1'],
    ['irefresh-type', '2'],
    ['enable-overlays', '1'],
    ['enable-variance-boost', '1'],
    ['variance-boost-strength', '2'],
    ['variance-octile', '6'],
    ['enable-qm', '1'],
    ['qm-min', '0'],
    ['qm-max', '15'],
    ['chroma-qm-min', '8'],
    ['chroma-qm-max', '15'],
    ['tf-strength', '1'],
    ['sharpness', '1'],
    ['tile-columns', '1'],
    ['scm', '0'],
  ];
  if (lp) entries.push(['lp', String(lp)]);
  if (grainParam > 0) {
    entries.push(['film-grain', String(grainParam)]);
    entries.push(['film-grain-denoise', '1']);
  }
  return { entries, hdrSvt };
};

const formatSvtForAv1an = ({ entries, hdrSvt }) =>
  entries.map(([k, v]) => `--${k} ${v}`).concat(hdrSvt || []).filter(Boolean).join(' ');

const formatSvtForAbAv1 = ({ entries }) =>
  entries.map(([k, v]) => `--svt ${k}=${v}`).join(' ');

const buildSvtFlags = (preset, svtLp, hdrSvt, grainParam) =>
  formatSvtForAv1an(svtConfig(preset, svtLp, hdrSvt, grainParam));

const buildAbAv1SvtFlags = (lp, grainParam) => {
  const cfg = svtConfig(0, lp, '', grainParam);
  const skip = new Set(['rc', 'preset', 'input-depth', 'keyint']);
  const filtered = { entries: cfg.entries.filter(([k]) => !skip.has(k)), hdrSvt: '' };
  return [formatSvtForAbAv1(filtered), '--keyint 10s', '--scd true'].join(' ');
};

const buildAbAv1AomFlags = (preset, threadsPerWorker, hdrAom, grainParam) => {
  // ffmpeg-native libaom-av1 options (exposed directly by ffmpeg)
  const ffmpegArgs = [
    `--enc cpu-used=${preset}`,
    '--enc tune=ssim',
    `--enc lag-in-frames=48`,
    '--enc tile-columns=0',
    '--enc tile-rows=0',
    '--enc aq-mode=0',
    '--enc arnr-strength=1',
    `--enc arnr-max-frames=4`,
    grainParam > 0 ? `--enc denoise-noise-level=${grainParam}` : '',
  ].filter(Boolean);

  // Raw aomenc params not exposed by ffmpeg — passed via aom-params
  const aomParams = [
    'end-usage=q',
    'enable-fwd-kf=0',
    'disable-kf=1',
    'kf-max-dist=9999',
    'enable-qm=1',
    'sb-size=dynamic',
    'deltaq-mode=0',
    'enable-chroma-deltaq=1',
    'disable-trellis-quant=0',
    'quant-b-adapt=1',
    'enable-keyframe-filtering=1',
    grainParam <= 0 ? 'enable-dnl-denoising=0' : '',
  ].filter(Boolean).join(':');

  return [...ffmpegArgs, `--enc aom-params=${aomParams}`].join(' ');
};

// SVT-AV1 effective thread limits per encoder preset.
// SVT-AV1 benefits more from extra workers (av1an parallelism) than from
// extra threads per worker. lp beyond ~6 shows diminishing returns, so we
// cap low to maximize workers. Lower presets cap even tighter at 4.
const SVT_LP_CAP_BY_PRESET = {
  0: 6, 1: 6, 2: 6, 3: 6,
  4: 6, 5: 6, 6: 6,
  7: 6, 8: 6, 9: 6, 10: 6, 11: 6, 12: 6, 13: 6,
};

const capSvtLpByPreset = (lp, encPreset) => {
  const cap = SVT_LP_CAP_BY_PRESET[encPreset];
  return cap != null ? Math.min(lp, cap) : lp;
};

const THREAD_PRESETS = {
  safe:        { aomWorkerDiv: 4, aomOversub: 1.0, svtWorkerFill: 0.5,  svtLpMax: 6,  vmafThreadDiv: 8, halve4kHdr: true },
  balanced:    { aomWorkerDiv: 4, aomOversub: 2.0, svtWorkerFill: 0.9,  svtLpMax: 20, vmafThreadDiv: 2, halve4kHdr: false },
  aggressive:  { aomWorkerDiv: 4, aomOversub: 4.0, svtWorkerFill: 1.4,  svtLpMax: 28, vmafThreadDiv: 2, halve4kHdr: false },
  max:         { aomWorkerDiv: 4, aomOversub: 6.0, svtWorkerFill: 2.8,  svtLpMax: 28, vmafThreadDiv: 2, halve4kHdr: false },
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
  buildAbAv1AomFlags,
  calculateThreadBudget,
  capSvtLpByPreset,
  THREAD_PRESETS,
};
