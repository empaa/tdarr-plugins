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
    {
      label: 'Thread Strategy',
      name: 'thread_strategy',
      type: 'string',
      defaultValue: 'auto',
      inputUI: { type: 'dropdown', options: ['auto', 'safe', 'balanced', 'aggressive', 'max', 'custom'] },
      tooltip: 'Controls thread/worker budget. auto=let av1an decide. safe=conservative defaults. balanced=~70% CPU. aggressive=saturate all cores (4x oversub). max=heavy oversubscription (6x). custom=use thread_overrides JSON.',
    },
    {
      label: 'Thread Overrides (JSON)',
      name: 'thread_overrides',
      type: 'string',
      defaultValue: '',
      inputUI: { type: 'text' },
      tooltip: 'Only used when Thread Strategy is "custom". JSON: {"workers":16,"threadsPerWorker":2,"vmafThreads":12}. Omitted keys fall back to aggressive preset.',
    },
    {
      label: 'Chunk Method',
      name: 'chunk_method',
      type: 'string',
      defaultValue: 'lsmash',
      inputUI: { type: 'dropdown', options: ['lsmash', 'hybrid'] },
      tooltip: 'lsmash = fast startup via index seeking, low disk usage, best for SVT-AV1. hybrid = ffmpeg segment splitting, better for long aom encodes. Both require VapourSynth.',
    },
    {
      label: 'Grain Synthesis',
      name: 'grain_synth',
      type: 'boolean',
      defaultValue: 'false',
      inputUI: { type: 'switch' },
      tooltip: 'Automatically detect noise, denoise during encoding, and synthesize matching grain at playback. Saves bitrate on noisy sources with no visual penalty.',
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
  const { shouldDownscale, buildVsDownscaleLines, buildAv1anVmafResArgs } = require('../shared/downscale');
  const { probeAudioSize, mergeAudioVideo } = require('../shared/audioMerge');
  const { createAv1anTracker } = require('../shared/progressTracker');
  const { estimateNoise } = require('../shared/grainSynth');

  const inputs = args.inputs || {};
  const encoder           = String(inputs.encoder || 'svt-av1');
  const targetVmaf        = Number(inputs.target_vmaf) || 93;
  const qpRange           = String(inputs.qp_range || '10-50');
  const encPreset         = Number(inputs.preset) || 4;
  const maxEncodedPercent = Number(inputs.max_encoded_percent) || 80;
  const downscaleEnabled  = inputs.downscale_enabled === true || inputs.downscale_enabled === 'true';
  const downscaleRes      = String(inputs.downscale_resolution || '1080p');

  const threadStrategy    = String(inputs.thread_strategy || 'safe');
  let threadOverrides = {};
  let threadOverridesError = null;
  const rawOverrides = String(inputs.thread_overrides || '').trim();
  if (rawOverrides) {
    try { threadOverrides = JSON.parse(rawOverrides); } catch (e) {
      threadOverridesError = e.message;
    }
  }

  const chunkMethod       = String(inputs.chunk_method || 'lsmash');
  const grainSynthEnabled = inputs.grain_synth === true || inputs.grain_synth === 'true';

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
  if (threadOverridesError) {
    jobLog(`WARNING: invalid thread_overrides JSON, falling back to aggressive: ${threadOverridesError}`);
  }
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
  const availableThreads = os.cpus().length;

  const doDownscale = downscaleEnabled && shouldDownscale(sourceWidth, downscaleRes);
  if (downscaleEnabled && !doDownscale) {
    jobLog(`Downscale skipped: source ${sourceWidth}px is already at or below ${downscaleRes} target`);
  }

  const { hdrAom, hdrSvt } = detectHdrMeta(stream);

  const isAutoThreads = threadStrategy === 'auto';
  const is4kHdr = height >= 2160 && stream.color_transfer === 'smpte2084';
  const { maxWorkers, threadsPerWorker, svtLp, vmafThreads } = isAutoThreads
    ? { maxWorkers: null, threadsPerWorker: null, svtLp: null, vmafThreads: null }
    : calculateThreadBudget(
      availableThreads, encoder, is4kHdr,
      { strategy: threadStrategy, ...threadOverrides, encPreset },
    );

  const workBase = path.join(args.workDir, 'av1an-work');
  const vsDir = path.join(workBase, 'vs');
  const av1anTemp = path.join(workBase, 'work');
  const outputPath = path.join(args.workDir, 'av1-output.mkv');
  fs.mkdirSync(vsDir, { recursive: true });
  fs.mkdirSync(av1anTemp, { recursive: true });

  const lwiCache = path.join(vsDir, 'source.lwi');

  let grainParam = 0;
  if (grainSynthEnabled) {
    const durationSec = parseFloat(stream.duration || '0')
      || (file.ffProbeData && file.ffProbeData.format && parseFloat(file.ffProbeData.format.duration)) || 0;
    const srcFpsForGrain = (() => {
      const r = stream.r_frame_rate || stream.avg_frame_rate || '24/1';
      const parts = r.split('/').map(Number);
      return parts[1] ? parts[0] / parts[1] : parts[0];
    })();
    const totalFrames = parseInt(stream.nb_frames || '0', 10)
      || (durationSec > 0 && srcFpsForGrain > 0 ? Math.round(durationSec * srcFpsForGrain) : 0);
    const result = estimateNoise(inputPath, durationSec, totalFrames, BIN.vspipe, lwiCache, dbg);
    grainParam = result.grainParam;
    if (grainParam > 0) {
      jobLog(`[grain] detected sigma=${result.sigma.toFixed(2)} -> film-grain=${grainParam}`);
    } else {
      jobLog('[grain] source is clean (sigma < 2), skipping grain synthesis');
    }
  }

  let encFlags;
  if (isAutoThreads) {
    encFlags = encoder === 'aom'
      ? buildAomFlags(encPreset, 0, hdrAom, grainParam).replace(/--threads=\d+\s*/, '')
      : buildSvtFlags(encPreset, 0, hdrSvt, grainParam).replace(/--lp \d+\s*/, '');
  } else {
    encFlags = encoder === 'aom'
      ? buildAomFlags(encPreset, threadsPerWorker, hdrAom, grainParam)
      : buildSvtFlags(encPreset, svtLp, hdrSvt, grainParam);
  }

  jobLog('='.repeat(64));
  jobLog(`AV1AN ENCODE  encoder=${encoder}  preset=${encPreset}`);
  jobLog(`  input      : ${inputPath}`);
  jobLog(`  resolution : ${stream.width || '?'}x${height || '?'}${doDownscale ? ` -> ${downscaleRes}` : ''}`);
  jobLog(`  target     : VMAF ${targetVmaf}  QP-range ${qpRange}`);
  jobLog(`  max size   : ${maxEncodedPercent}% of source`);
  jobLog(`  threads    : cpu=${availableThreads}  workers=${isAutoThreads ? 'auto' : maxWorkers}  threads/worker=${isAutoThreads ? 'auto' : threadsPerWorker}  vmaf-threads=${isAutoThreads ? 'auto' : vmafThreads}  strategy=${threadStrategy}`);
  jobLog(`  enc flags  : ${encFlags}`);
  if (grainSynthEnabled) {
    jobLog(`  grain      : ${grainParam > 0 ? `enabled (film-grain=${grainParam})` : 'enabled (clean source, skipped)'}`);
  }
  jobLog('='.repeat(64));

  const sourceSizeGb = (() => {
    try { return fs.statSync(inputPath).size / (1024 ** 3); } catch (_) { return 0; }
  })();

  updateWorker({ percentage: 0, startTime: Date.now(), status: 'Processing' });

  const audioSizeGb = await probeAudioSize(inputPath, args.workDir, dbg, dbg);

  const vpyScript = path.join(vsDir, 'source.vpy');
  const escPy = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  let vpyLines = [
    'import vapoursynth as vs',
    'core = vs.core',
    `src = core.lsmas.LWLibavSource(source='${escPy(inputPath)}', cachefile='${escPy(lwiCache)}')`,
  ];
  if (doDownscale) {
    vpyLines = vpyLines.concat(buildVsDownscaleLines(downscaleRes));
  }
  vpyLines.push('src.set_output()');
  fs.writeFileSync(vpyScript, vpyLines.join('\n') + '\n');
  dbg(`[vs] .vpy written${doDownscale ? ` (Lanczos3 -> ${downscaleRes})` : ' (passthrough)'}`);

  if (!fs.existsSync(lwiCache)) {
    updateWorker({ status: 'Indexing' });
    const lwiExit = await pm.spawnAsync(BIN.vspipe, ['--info', vpyScript], {
      cwd: vsDir,
      silent: true,
    });
    dbg(lwiExit === 0 ? '[vs] .lwi index ready' : '[vs] WARNING: .lwi non-zero -- workers will retry');
  }

  const av1anArgs = [
    '-i', vpyScript,
    '-o', outputPath,
    '--temp', av1anTemp,
    '-c', 'mkvmerge',
    '-e', encoder,
    '--sc-downscale-height', '540',
    '--scaler', 'lanczos',
    '--chunk-method', chunkMethod,
    ...(chunkMethod === 'hybrid' ? ['--ignore-frame-mismatch'] : []),
    ...(isAutoThreads ? [] : ['--workers', String(maxWorkers)]),
    '--qp-range', qpRange,
    '--target-quality', String(targetVmaf),
    '--vmaf-path', vmafModel,
    ...(isAutoThreads ? [] : ['--vmaf-threads', String(vmafThreads)]),
    '--probes', '6',
    '--min-scene-len', '24',
    '--chunk-order', 'long-to-short',
    '--keep',
    '--resume',
    '--verbose',
  ];

  if (doDownscale) {
    av1anArgs.push(...buildAv1anVmafResArgs(downscaleRes));
  }

  av1anArgs.push('-v', encFlags);

  jobLog(`av1an ${av1anArgs.map((a) => /\s/.test(a) ? `"${a}"` : a).join(' ')}`);

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

  const AV1AN_KEEP = /scenecut|error|warn|panic|crash|failed/i;
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
