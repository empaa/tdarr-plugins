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

const buildAomFlags = (preset, hdrAom) => {
  return [
    '--end-usage=q', `--cpu-used=${preset}`,
    '--tune=ssim', '--enable-fwd-kf=0', '--disable-kf', '--kf-max-dist=9999',
    '--enable-qm=1', '--bit-depth=10', '--lag-in-frames=48',
    '--tile-columns=0', '--tile-rows=0', '--sb-size=dynamic',
    '--deltaq-mode=0', '--aq-mode=0', '--arnr-strength=1', '--arnr-maxframes=4',
    '--enable-chroma-deltaq=1', '--enable-dnl-denoising=0',
    '--disable-trellis-quant=0', '--quant-b-adapt=1',
    '--enable-keyframe-filtering=1', hdrAom,
  ].filter(Boolean).join(' ');
};

const svtConfig = (preset, hdrSvt) => {
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
  return { entries, hdrSvt };
};

const formatSvtForAv1an = ({ entries, hdrSvt }) =>
  entries.map(([k, v]) => `--${k} ${v}`).concat(hdrSvt || []).filter(Boolean).join(' ');

const formatSvtForAbAv1 = ({ entries }) =>
  entries.map(([k, v]) => `--svt ${k}=${v}`).join(' ');

const buildSvtFlags = (preset, hdrSvt) =>
  formatSvtForAv1an(svtConfig(preset, hdrSvt));

const buildAbAv1SvtFlags = () => {
  const cfg = svtConfig(0, '');
  const skip = new Set(['rc', 'preset', 'input-depth', 'keyint']);
  const filtered = { entries: cfg.entries.filter(([k]) => !skip.has(k)), hdrSvt: '' };
  return [formatSvtForAbAv1(filtered), '--keyint 10s', '--scd true'].join(' ');
};

const buildAbAv1AomFlags = (preset, hdrAom) => {
  // ffmpeg-native libaom-av1 options (exposed directly by ffmpeg)
  // Note: cpu-used and keyframe control are handled by ab-av1 natively
  // (--preset maps to -cpu-used, --keyint maps to -g)
  const ffmpegArgs = [
    '--enc tune=ssim',
    '--enc lag-in-frames=48',
    '--enc tile-columns=0',
    '--enc tile-rows=0',
    '--enc aq-mode=0',
    '--enc arnr-strength=1',
    '--enc arnr-max-frames=4',
  ];

  // Raw aomenc params not exposed by ffmpeg — passed via aom-params
  // Note: end-usage omitted — ab-av1 uses CRF mode natively
  const aomParams = [
    'enable-qm=1',
    'sb-size=dynamic',
    'deltaq-mode=0',
    'enable-chroma-deltaq=1',
    'disable-trellis-quant=0',
    'quant-b-adapt=1',
    'enable-keyframe-filtering=1',
    'enable-dnl-denoising=0',
  ].join(':');

  return [...ffmpegArgs, `--enc aom-params=${aomParams}`].join(' ');
};

const probeVideoStream = (inputPath, ffmpegBin) => {
  const cp = require('child_process');
  const ffprobeBin = ffmpegBin.replace(/ffmpeg$/, 'ffprobe');
  const result = cp.spawnSync(ffprobeBin, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_streams',
    '-select_streams', 'v:0',
    inputPath,
  ], { timeout: 30000 });
  if (result.status !== 0) {
    throw new Error(`ffprobe failed (exit ${result.status}) on ${inputPath}`);
  }
  const data = JSON.parse(result.stdout.toString());
  return (data.streams && data.streams[0]) || {};
};

module.exports = {
  detectHdrMeta,
  buildAomFlags,
  buildSvtFlags,
  buildAbAv1SvtFlags,
  buildAbAv1AomFlags,
  probeVideoStream,
};
