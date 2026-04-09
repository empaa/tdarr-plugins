// src/abAv1Encode/index.js
'use strict';

const details = () => ({
  name: 'AV1 Encode (ab-av1)',
  description: [
    'Encodes video to AV1 using ab-av1 automatic VMAF-targeted CRF search.',
    'Uses SVT-AV1 with quality-optimized settings.',
    'Live progress, FPS, and ETA on dashboard. Cancel kills encoder immediately.',
  ].join(' '),
  style: { borderColor: 'purple' },
  tags: 'av1,ab-av1,svt-av1,vmaf',
  isStartPlugin: false,
  pType: '',
  requiresVersion: '2.00.01',
  sidebarPosition: -1,
  icon: 'faVideo',
  inputs: [
    {
      label: 'Target VMAF',
      name: 'target_vmaf',
      type: 'number',
      defaultValue: '93',
      inputUI: { type: 'text' },
      tooltip: 'VMAF score to target (0-100). Typically 90-96.',
    },
    {
      label: 'Min CRF',
      name: 'min_crf',
      type: 'number',
      defaultValue: '10',
      inputUI: { type: 'text' },
      tooltip: 'Minimum CRF bound for quality search.',
    },
    {
      label: 'Max CRF',
      name: 'max_crf',
      type: 'number',
      defaultValue: '50',
      inputUI: { type: 'text' },
      tooltip: 'Maximum CRF bound for quality search.',
    },
    {
      label: 'Preset',
      name: 'preset',
      type: 'number',
      defaultValue: '4',
      inputUI: { type: 'text' },
      tooltip: 'SVT-AV1 preset (0-13, lower=slower/better). Recommended: 4-6.',
    },
    {
      label: 'Max Encoded Percent',
      name: 'max_encoded_percent',
      type: 'number',
      defaultValue: '80',
      inputUI: { type: 'text' },
      tooltip: 'Abort if output exceeds this % of source size (uses ab-av1 native flag). Set to 100 to disable.',
    },
    {
      label: 'Enable Downscale',
      name: 'downscale_enabled',
      type: 'boolean',
      defaultValue: 'false',
      inputUI: { type: 'switch' },
      tooltip: 'Downscale output using ab-av1 native vfilter.',
    },
    {
      label: 'Downscale Resolution',
      name: 'downscale_resolution',
      type: 'string',
      defaultValue: '1080p',
      inputUI: { type: 'dropdown', options: ['720p', '1080p', '1440p'] },
      tooltip: 'Target resolution for downscaling. Only used when downscale is enabled.',
    },
  ],
  outputs: [
    { number: 1, tooltip: 'Encode succeeded -- output file is the encoded video+audio MKV' },
    { number: 2, tooltip: 'Not processed -- compression target not met, input file passed through unchanged' },
  ],
});

const plugin = async (args) => {
  const fs   = require('fs');
  const path = require('path');
  const os   = require('os');

  const { createProcessManager } = require('../shared/processManager');
  const { createLogger, humanSize } = require('../shared/logger');
  const { detectHdrMeta, buildAbAv1SvtFlags } = require('../shared/encoderFlags');
  const { shouldDownscale, buildAbAv1DownscaleArgs } = require('../shared/downscale');
  const { createAbAv1Tracker } = require('../shared/progressTracker');

  const inputs = args.inputs || {};
  const targetVmaf        = Number(inputs.target_vmaf) || 93;
  const minCrf            = Number(inputs.min_crf) || 10;
  const maxCrf            = Number(inputs.max_crf) || 50;
  const encPreset         = Number(inputs.preset) || 4;
  const maxEncodedPercent = Number(inputs.max_encoded_percent) || 80;
  const downscaleEnabled  = inputs.downscale_enabled === true || inputs.downscale_enabled === 'true';
  const downscaleRes      = String(inputs.downscale_resolution || '1080p');

  const BIN_AB_AV1 = ['/usr/local/bin/ab-av1', '/usr/bin/ab-av1'].find((p) => fs.existsSync(p));
  if (!BIN_AB_AV1) throw new Error('Required binary not found: ab-av1 (checked /usr/local/bin, /usr/bin)');
  const BIN_FFMPEG = ['/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p) => fs.existsSync(p));
  if (!BIN_FFMPEG) throw new Error('Required binary not found: ffmpeg (checked /usr/local/bin, /usr/bin)');
  const vmafModel = '/usr/local/share/vmaf/vmaf_v0.6.1.json';
  if (!fs.existsSync(vmafModel)) throw new Error(`VMAF model not found: ${vmafModel}`);

  const { jobLog, dbg } = createLogger(args.jobLog, args.workDir);
  const pm = createProcessManager(jobLog, dbg);

  const updateWorker = (fields) => {
    if (typeof args.updateWorker === 'function') {
      try { args.updateWorker(fields); } catch (_) {}
    }
  };

  const file = args.inputFileObj;
  const inputPath = file._id;
  const stream = (file.ffProbeData && file.ffProbeData.streams && file.ffProbeData.streams[0]) || {};
  const height = stream.height || 0;
  const sourceWidth = stream.width || 0;

  const doDownscale = downscaleEnabled && shouldDownscale(sourceWidth, downscaleRes);
  if (downscaleEnabled && !doDownscale) {
    jobLog(`Downscale skipped: source ${sourceWidth}px is already at or below ${downscaleRes} target`);
  }

  detectHdrMeta(stream);

  const abWorkDir = path.join(args.workDir, 'ab-av1-work');
  const outputPath = path.join(args.workDir, 'ab-av1-output.mkv');
  fs.mkdirSync(abWorkDir, { recursive: true });

  const srcFps = (() => {
    const r = stream.r_frame_rate || stream.avg_frame_rate || '24/1';
    const parts = r.split('/').map(Number);
    return parts[1] ? parts[0] / parts[1] : parts[0];
  })();

  const svtFlags = buildAbAv1SvtFlags();

  const sourceSizeGb = (() => {
    try { return fs.statSync(inputPath).size / (1024 ** 3); } catch (_) { return 0; }
  })();

  jobLog('='.repeat(64));
  jobLog(`AB-AV1 ENCODE  preset=${encPreset}  vmaf=${targetVmaf}  crf=${minCrf}-${maxCrf}`);
  jobLog(`  input      : ${inputPath}`);
  jobLog(`  resolution : ${stream.width || '?'}x${height || '?'}${doDownscale ? ` -> ${downscaleRes}` : ''}`);
  jobLog(`  max size   : ${maxEncodedPercent}% of source`);
  jobLog(`  svt flags  : ${svtFlags}`);
  jobLog('='.repeat(64));

  updateWorker({ percentage: 0, startTime: Date.now(), status: 'CRF Search' });

  const abArgs = [
    'auto-encode',
    '--input', inputPath,
    '--output', outputPath,
    '--preset', String(encPreset),
    '--min-vmaf', String(targetVmaf),
    '--min-crf', String(minCrf),
    '--max-crf', String(maxCrf),
    '--vmaf', `n_threads=${os.cpus().length}:model=path=${vmafModel}`,
    '--max-encoded-percent', String(maxEncodedPercent),
    '--cache', 'false',
    '--verbose',
  ];

  if (doDownscale) {
    abArgs.push(...buildAbAv1DownscaleArgs(downscaleRes));
  }

  svtFlags.split(/\s+/).filter(Boolean).forEach((tok) => abArgs.push(tok));

  jobLog(`ab-av1 ${abArgs.map((a) => /\s/.test(a) ? `"${a}"` : a).join(' ')}`);

  let sizeExceeded = false;

  const tracker = createAbAv1Tracker({
    outputPath,
    sourceSizeGb,
    updateWorker,
    jobLog,
    dbg,
    onSizeExceeded: () => { sizeExceeded = true; },
  });

  pm.installCancelHandler(() => { tracker.stop(); });
  tracker.startInterval();

  const abExit = await pm.spawnAsync(BIN_AB_AV1, abArgs, {
    cwd: abWorkDir,
    onLine: tracker.onLine,
    filter: () => false,
    onSpawn: (pid) => pm.startPpidWatcher(pid),
  });

  tracker.stop();

  let encodeOk = false;
  if (abExit !== 0) {
    if (sizeExceeded) {
      jobLog('[ab-av1] encode stopped: compression target not met');
    } else {
      jobLog(`ERROR: ab-av1 exited ${abExit}`);
    }
  } else {
    encodeOk = true;
  }

  pm.cleanup();

  if (sizeExceeded) {
    jobLog('='.repeat(64));
    jobLog('ENCODE SKIPPED -- output would exceed max-encoded-percent limit');
    jobLog('='.repeat(64));
    return {
      outputFileObj: args.inputFileObj,
      outputNumber: 2,
      variables: args.variables,
    };
  }

  if (!encodeOk) {
    throw new Error('ab-av1 encode failed -- check logs for details');
  }

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    throw new Error('ab-av1 output file missing or empty');
  }

  const inBytes = (() => { try { return fs.statSync(inputPath).size; } catch (_) { return 0; } })();
  const outBytes = (() => { try { return fs.statSync(outputPath).size; } catch (_) { return 0; } })();
  const pct = inBytes ? (((inBytes - outBytes) / inBytes) * 100).toFixed(1) : '?';

  jobLog('='.repeat(64));
  jobLog('ENCODE COMPLETE');
  jobLog(`  source  : ${humanSize(inBytes)}`);
  jobLog(`  output  : ${humanSize(outBytes)}  (${pct}% reduction)`);
  jobLog('='.repeat(64));

  updateWorker({ percentage: 100 });

  return {
    outputFileObj: Object.assign({}, file, { _id: outputPath, file: outputPath }),
    outputNumber: 1,
    variables: args.variables,
  };
};

module.exports.details = details;
module.exports.plugin = plugin;
