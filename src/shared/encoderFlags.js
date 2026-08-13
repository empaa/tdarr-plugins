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

// SVT-AV1 parameters. Verified against MAINLINE SVT-AV1 v4.2.0, which is what
// ../tdarr-av1/Dockerfile pins -- not a psy fork. See
// docs/svt-av1-settings-research.md for sources.
//
// Only flags that genuinely OVERRIDE a v4.2.0 default are listed. Ten flags were
// removed on 2026-08-13 because they were inert or redundant:
//
//   rc 0, irefresh-type 2, variance-boost-strength 2, qm-max 15,
//   chroma-qm-min 8, chroma-qm-max 15   -- byte-identical to v4.2.0 defaults
//   input-depth 10                      -- overwritten by the y4m header from vspipe
//   lookahead 48                        -- inert under --rc 0 (CRF takes lad_mg =
//                                          tpl_lad_mg); also bounded by chunk length
//                                          under av1an
//   variance-octile 6                   -- pinned a default upstream MOVED to 5 in
//                                          v4.0.0; we were holding a stale value
//   enable-overlays 1                   -- off by default upstream, and roughly
//                                          doubles picture buffers (min_parent *= 2),
//                                          multiplied across parallel av1an workers.
//                                          Bears directly on our 4K OOM history.
//
// The set below was inherited from a psy-FORK recipe (the JET guide's example line,
// which is anime-targeted) applied to a mainline binary. variance-octile, sharpness,
// tf-strength and chroma-qm were psyex/hdr defaults, not mainline ones.
const svtConfig = (preset, hdrSvt) => {
  const entries = [
    ['preset', String(preset)],
    // Default is already 1, kept explicit because it is a deliberate choice: tune 0
    // is designed to trade full-reference metric score for perceived detail, which
    // an SSIMULACRA2/VMAF acceptance gate scores as damage. Do not change this
    // without also changing how encodes are accepted.
    ['tune', '1'],
    ['keyint', '-1'],          // av1an owns keyframes; chunk starts are keyframes
    ['enable-variance-boost', '1'],
    ['enable-qm', '1'],
    // Was 0, which has no backing in any guide or fork. Every maintainer ships 4-6,
    // and mainline's own SSIMULACRA2-optimised tune hard-selects 4. Our sweep also
    // measured --enable-qm 0 as the single largest effect in the whole matrix
    // (up to +33.9% bytes), so QM is doing heavy lifting here.
    ['qm-min', '4'],
    ['tf-strength', '1'],      // mainline default 3; 1 avoids the tf blocking issue
    ['sharpness', '1'],        // mainline default 0
    // Kept pending measurement. Upstream calls tile threading a known quality
    // decrease and it buys no encode parallelism, but tiles do help hardware/dav1d
    // decode at 4K, so this is a playback tradeoff rather than a pure loss.
    ['tile-columns', '1'],
    // Kept pending measurement. A 2021 hedge against a screen-content detector that
    // has since been rebuilt in 4.0/4.1/4.2; likely near-neutral on live action.
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
  // ab-av1 sets rate control, preset and keyframes itself. (rc/input-depth are no
  // longer in svtConfig at all, but the skip set is kept explicit so a future
  // re-addition cannot leak into the ab-av1 path unnoticed.)
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

module.exports = {
  detectHdrMeta,
  buildAomFlags,
  buildSvtFlags,
  buildAbAv1SvtFlags,
  buildAbAv1AomFlags,
};
