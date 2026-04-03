// src/shared/downscale.js
'use strict';

const RESOLUTION_PRESETS = {
  '720p':  { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
};

const shouldDownscale = (sourceWidth, resolution) => {
  const preset = RESOLUTION_PRESETS[resolution];
  if (!preset) return false;
  return sourceWidth > preset.width;
};

const buildVsDownscaleLines = (resolution) => {
  const preset = RESOLUTION_PRESETS[resolution];
  if (!preset) return [];
  return [
    'src_w, src_h = src.width, src.height',
    `tgt_w = ${preset.width}`,
    'tgt_h = int(round(src_h * tgt_w / src_w / 2) * 2)',
    'src = core.resize.Lanczos(src, width=tgt_w, height=tgt_h, filter_param_a=3)',
  ];
};

const buildAv1anVmafResArgs = (resolution) => {
  const preset = RESOLUTION_PRESETS[resolution];
  if (!preset) return [];
  const vmafW = Math.floor(preset.width / 2);
  const vmafH = Math.floor(preset.height / 2);
  const vmafHEven = vmafH % 2 === 0 ? vmafH : vmafH + 1;
  return ['--vmaf-res', `${vmafW}x${vmafHEven}`];
};

const buildAbAv1DownscaleArgs = (resolution) => {
  const preset = RESOLUTION_PRESETS[resolution];
  if (!preset) return [];
  return ['--vfilter', `scale=${preset.width}:-2:flags=lanczos`];
};

module.exports = {
  RESOLUTION_PRESETS,
  shouldDownscale,
  buildVsDownscaleLines,
  buildAv1anVmafResArgs,
  buildAbAv1DownscaleArgs,
};
