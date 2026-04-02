// src/av1anEncode/index.js
'use strict';

const details = () => ({
  name: 'AV1 Encode (av1an)',
  description: [
    'Encodes video to AV1 using av1an scene-based chunked encoding.',
    'Supports aomenc (quality) and SVT-AV1 (speed) encoders.',
    'Live progress, FPS, and ETA on dashboard. Cancel kills encoder immediately.',
  ].join(' '),
  style: { borderColor: 'purple' },
  tags: 'av1,av1an,svt-av1,aomenc,vmaf',
  isStartPlugin: false,
  pType: '',
  requiresVersion: '2.00.01',
  sidebarPosition: -1,
  icon: 'faVideo',
  inputs: [
    {
      label: 'Encoder',
      name: 'encoder',
      type: 'string',
      defaultValue: 'svt-av1',
      inputUI: { type: 'dropdown', options: ['aom', 'svt-av1'] },
      tooltip: 'aom = aomenc (quality, slower). svt-av1 = SVT-AV1 (speed, faster).',
    },
    {
      label: 'Target VMAF',
      name: 'target_vmaf',
      type: 'number',
      defaultValue: '93',
      inputUI: { type: 'text' },
      tooltip: 'VMAF score to target (0-100). Typically 90-96.',
    },
    {
      label: 'QP Range',
      name: 'qp_range',
      type: 'string',
      defaultValue: '10-50',
      inputUI: { type: 'text' },
      tooltip: 'QP floor-ceiling for target-quality search. E.g. "10-50".',
    },
    {
      label: 'Preset',
      name: 'preset',
      type: 'number',
      defaultValue: '4',
      inputUI: { type: 'text' },
      tooltip: 'aomenc: cpu-used (0-8, lower=slower/better). SVT-AV1: preset (0-13). Recommended: 3 for aom, 4-6 for SVT.',
    },
    {
      label: 'Max Encoded Percent',
      name: 'max_encoded_percent',
      type: 'number',
      defaultValue: '80',
      inputUI: { type: 'text' },
      tooltip: 'Abort if estimated output exceeds this % of source size. Set to 100 to disable.',
    },
    {
      label: 'Enable Downscale',
      name: 'downscale_enabled',
      type: 'boolean',
      defaultValue: 'false',
      inputUI: { type: 'switch' },
      tooltip: 'Downscale input using VapourSynth pre-filter before encoding.',
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
  const { detectHdrMeta, buildAomFlags, buildSvtFlags, calculateThreadBudget } = require('../shared/encoderFlags');
  const { buildVsDownscaleLines, buildAv1anVmafResArgs } = require('../shared/downscale');
  const { probeAudioSize, mergeAudioVideo } = require('../shared/audioMerge');
  const { createAv1anTracker } = require('../shared/progressTracker');

  const inputs = args.inputs || {};
  const encoder           = String(inputs.encoder || 'svt-av1');
  const targetVmaf        = Number(inputs.target_vmaf) || 93;
  const qpRange           = String(inputs.qp_range || '10-50');
  const encPreset         = Number(inputs.preset) || 4;
  const maxEncodedPercent = Number(inputs.max_encoded_percent) || 80;
  const downscaleEnabled  = inputs.downscale_enabled === true || inputs.downscale_enabled === 'true';
  const downscaleRes      = String(inputs.downscale_resolution || '1080p');

  const findBin = (name, ...paths) => paths.find((p) => fs.existsSync(p))
    || (() => { throw new Error(`Required binary not found: ${name} (checked ${paths.join(', ')})`); })();

  const BIN = {
    av1an:    findBin('av1an',    '/usr/local/bin/av1an',    '/usr/bin/av1an'),
    ffmpeg:   findBin('ffmpeg',   '/usr/local/bin/ffmpeg',   '/usr/bin/ffmpeg'),
    vspipe:   findBin('vspipe',   '/usr/local/bin/vspipe',   '/usr/bin/vspipe'),
    mkvmerge: findBin('mkvmerge', '/usr/local/bin/mkvmerge', '/usr/bin/mkvmerge'),
  };
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
  const availableThreads = os.cpus().length;

  const { hdrAom, hdrSvt } = detectHdrMeta(stream);

  const is4kHdr = height >= 2160 && stream.color_transfer === 'smpte2084';
  const { maxWorkers, threadsPerWorker, svtLp } = calculateThreadBudget(availableThreads, encoder, is4kHdr);

  const encFlags = encoder === 'aom'
    ? buildAomFlags(encPreset, threadsPerWorker, hdrAom)
    : buildSvtFlags(encPreset, svtLp, hdrSvt);

  const workBase = path.join(args.workDir, 'av1an-work');
  const vsDir = path.join(workBase, 'vs');
  const av1anTemp = path.join(workBase, 'work');
  const outputPath = path.join(args.workDir, 'av1-output.mkv');
  fs.mkdirSync(vsDir, { recursive: true });
  fs.mkdirSync(av1anTemp, { recursive: true });

  jobLog('='.repeat(64));
  jobLog(`AV1AN ENCODE  encoder=${encoder}  preset=${encPreset}`);
  jobLog(`  input     : ${inputPath}`);
  jobLog(`  resolution: ${stream.width || '?'}x${height || '?'}${downscaleEnabled ? ` -> ${downscaleRes}` : ''}`);
  jobLog(`  target    : VMAF ${targetVmaf}  QP-range ${qpRange}`);
  jobLog(`  threads   : cpu=${availableThreads}  workers=${maxWorkers}  threads/worker=${threadsPerWorker}`);
  jobLog('='.repeat(64));

  const sourceSizeGb = (() => {
    try { return fs.statSync(inputPath).size / (1024 ** 3); } catch (_) { return 0; }
  })();

  updateWorker({ percentage: 0, startTime: Date.now(), status: 'Processing' });

  const audioSizeGb = await probeAudioSize(inputPath, args.workDir, jobLog, dbg);

  const vpyScript = path.join(vsDir, 'source.vpy');
  const lwiCache = path.join(vsDir, 'source.lwi');
  const escPy = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  let vpyLines = [
    'import vapoursynth as vs',
    'from math import round',
    'core = vs.core',
    `src = core.lsmas.LWLibavSource(source='${escPy(inputPath)}', cachefile='${escPy(lwiCache)}')`,
  ];
  if (downscaleEnabled) {
    vpyLines = vpyLines.concat(buildVsDownscaleLines(downscaleRes));
  }
  vpyLines.push('src.set_output()');
  fs.writeFileSync(vpyScript, vpyLines.join('\n') + '\n');
  jobLog(`[vs] .vpy written${downscaleEnabled ? ` (Lanczos3 -> ${downscaleRes})` : ' (passthrough)'}`);

  if (!fs.existsSync(lwiCache)) {
    jobLog('[vs] pre-generating .lwi index...');
    updateWorker({ status: 'Indexing' });
    const lwiExit = await pm.spawnAsync(BIN.vspipe, ['--info', vpyScript], {
      cwd: vsDir,
      silent: true,
    });
    jobLog(lwiExit === 0 ? '[vs] .lwi index ready' : '[vs] WARNING: .lwi non-zero -- workers will retry');
  }

  const av1anArgs = [
    '-i', vpyScript,
    '-o', outputPath,
    '--temp', av1anTemp,
    '-c', 'mkvmerge',
    '-e', encoder,
    '--sc-downscale-height', '540',
    '--scaler', 'lanczos',
    '--workers', String(maxWorkers),
    '--qp-range', qpRange,
    '--target-quality', String(targetVmaf),
    '--vmaf-path', vmafModel,
    '--vmaf-threads', '4',
    '--probes', '6',
    '--chunk-order', 'long-to-short',
    '--keep',
    '--resume',
    '--verbose',
  ];

  if (downscaleEnabled) {
    av1anArgs.push(...buildAv1anVmafResArgs(downscaleRes));
  } else {
    av1anArgs.push('--probe-res', '1280x720', '--vmaf-res', '1280x720');
  }

  av1anArgs.push('-v', encFlags);

  let tracker;
  let sizeExceeded = false;

  pm.installCancelHandler(() => {
    if (tracker) tracker.stop();
  });

  updateWorker({ status: 'Scene Detection' });

  tracker = createAv1anTracker({
    workBase,
    maxWorkers,
    audioSizeGb,
    sourceSizeGb,
    maxEncodedPercent,
    updateWorker,
    jobLog,
    dbg,
    onSizeExceeded: () => {
      sizeExceeded = true;
      pm.killAll();
    },
  });
  tracker.start();

  const AV1AN_KEEP = /scene|chunk|encoded|vmaf|fps|eta|probe|error|warn|panic|crash/i;
  const av1anExit = await pm.spawnAsync(BIN.av1an, av1anArgs, {
    cwd: vsDir,
    filter: (l) => AV1AN_KEEP.test(l),
    onSpawn: (pid) => pm.startPpidWatcher(pid),
  });

  tracker.stop();

  let encodeOk = false;
  if (sizeExceeded) {
    jobLog('[av1an] encode aborted: estimated output exceeds max-encoded-percent limit');
  } else if (av1anExit !== 0) {
    jobLog(`ERROR: av1an exited ${av1anExit}`);
  } else {
    encodeOk = true;
  }

  if (encodeOk) {
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
      jobLog(`ERROR: encoder output not found or empty: ${outputPath}`);
      encodeOk = false;
    } else {
      const videoOnlyPath = outputPath + '.videoonly.mkv';
      fs.renameSync(outputPath, videoOnlyPath);
      updateWorker({ status: 'Muxing' });
      encodeOk = await mergeAudioVideo(videoOnlyPath, inputPath, outputPath, pm, jobLog, dbg);
      try { fs.unlinkSync(videoOnlyPath); } catch (_) {}
    }
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
    throw new Error('av1an encode failed -- check logs for details');
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
