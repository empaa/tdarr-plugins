// src/crfSearchEncode/index.js
'use strict';

const details = () => ({
  name: 'AV1 Encode (CRF Search + av1an)',
  description: [
    'Two-phase hybrid: ab-av1 finds the optimal CRF via VMAF search,',
    'then av1an encodes at that fixed CRF with multi-worker chunked encoding.',
    'Supports aomenc and SVT-AV1. Live progress on dashboard.',
  ].join(' '),
  style: { borderColor: 'purple' },
  tags: 'av1,av1an,ab-av1,svt-av1,aomenc,vmaf,crf',
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
      tooltip: 'aomenc: cpu-used (0-8, lower=slower/better). SVT-AV1: preset (0-13). Recommended: 3 for aom, 4-6 for SVT.',
    },
    {
      label: 'Max Encoded Percent',
      name: 'max_encoded_percent',
      type: 'number',
      defaultValue: '80',
      inputUI: { type: 'text' },
      tooltip: 'Abort if estimated output exceeds this % of source size. Applied to both CRF search and encode phases. Set to 100 to disable.',
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
      tooltip: 'Controls thread/worker budget. auto=let encoders decide. safe=conservative. balanced=~70% CPU. aggressive=saturate cores. max=heavy oversubscription. custom=use thread_overrides JSON.',
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
      tooltip: 'Automatically detect noise, denoise during encoding, and synthesize matching grain at playback.',
    },
  ],
  outputs: [
    { number: 1, tooltip: 'Encode succeeded -- output file is the encoded video+audio MKV' },
    { number: 2, tooltip: 'Not processed -- CRF search failed or compression target not met' },
  ],
});

const plugin = async (args) => {
  const fs   = require('fs');
  const path = require('path');
  const os   = require('os');

  const { createProcessManager } = require('../shared/processManager');
  const { createLogger, humanSize } = require('../shared/logger');
  const {
    detectHdrMeta, buildAomFlags, buildSvtFlags,
    buildAbAv1SvtFlags, buildAbAv1AomFlags, calculateThreadBudget,
  } = require('../shared/encoderFlags');
  const { shouldDownscale, buildVsDownscaleLines, buildAv1anVmafResArgs, buildAbAv1DownscaleArgs } = require('../shared/downscale');
  const { probeAudioSize, mergeAudioVideo } = require('../shared/audioMerge');
  const { createAv1anTracker } = require('../shared/progressTracker');
  const { estimateNoise } = require('../shared/grainSynth');

  const inputs = args.inputs || {};
  const encoder           = String(inputs.encoder || 'svt-av1');
  const targetVmaf        = Number(inputs.target_vmaf) || 93;
  const minCrf            = Number(inputs.min_crf) || 10;
  const maxCrf            = Number(inputs.max_crf) || 50;
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
    ab_av1:   findBin('ab-av1',   '/usr/local/bin/ab-av1',   '/usr/bin/ab-av1'),
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

  // Phase 1 thread budget: single-process for CRF search
  const searchBudget = isAutoThreads
    ? { svtLp: null, vmafThreads: null }
    : calculateThreadBudget(
      availableThreads, encoder === 'aom' ? 'aom' : 'svt-av1', is4kHdr,
      { strategy: threadStrategy, ...threadOverrides, singleProcess: true, encPreset },
    );

  // Phase 2 thread budget: multi-worker for av1an encode
  const encodeBudget = isAutoThreads
    ? { maxWorkers: null, threadsPerWorker: null, svtLp: null, vmafThreads: null }
    : calculateThreadBudget(
      availableThreads, encoder, is4kHdr,
      { strategy: threadStrategy, ...threadOverrides, encPreset },
    );

  // ── Grain estimation and work directory setup ────────────────────────
  const workBase = path.join(args.workDir, 'crf-search-work');
  const vsDir = path.join(workBase, 'vs');
  const av1anTemp = path.join(workBase, 'work');
  const searchDir = path.join(workBase, 'search');
  const outputPath = path.join(args.workDir, 'crf-output.mkv');
  fs.mkdirSync(vsDir, { recursive: true });
  fs.mkdirSync(av1anTemp, { recursive: true });
  fs.mkdirSync(searchDir, { recursive: true });

  const lwiCache = path.join(vsDir, 'source.lwi');

  // Build VapourSynth script (needed for both scene detection and phase 2)
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

  // Pre-index lwi if needed (shared by scene detection and phase 2)
  if (!fs.existsSync(lwiCache)) {
    updateWorker({ status: 'Indexing' });
    const lwiExit = await pm.spawnAsync(BIN.vspipe, ['--info', vpyScript], {
      cwd: vsDir,
      silent: true,
    });
    dbg(lwiExit === 0 ? '[vs] .lwi index ready' : '[vs] WARNING: .lwi non-zero -- workers will retry');
  }

  let grainParam = 0;
  if (grainSynthEnabled) {
    const durationSec = parseFloat(stream.duration || '0')
      || (file.ffProbeData && file.ffProbeData.format && parseFloat(file.ffProbeData.format.duration)) || 0;
    const srcFps = (() => {
      const r = stream.r_frame_rate || stream.avg_frame_rate || '24/1';
      const parts = r.split('/').map(Number);
      return parts[1] ? parts[0] / parts[1] : parts[0];
    })();
    const totalFrames = parseInt(stream.nb_frames || '0', 10)
      || (durationSec > 0 && srcFps > 0 ? Math.round(durationSec * srcFps) : 0);
    const result = estimateNoise(inputPath, durationSec, totalFrames, BIN.vspipe, lwiCache, dbg);
    grainParam = result.grainParam;
    if (grainParam > 0) {
      jobLog(`[grain] detected sigma=${result.sigma.toFixed(2)} -> film-grain=${grainParam}`);
    } else {
      jobLog('[grain] source is clean (sigma < 2), skipping grain synthesis');
    }
  }

  // ── Phase 1: CRF Search ──────────────────────────────────────────────
  jobLog('='.repeat(64));
  jobLog(`CRF SEARCH ENCODE  encoder=${encoder}  preset=${encPreset}`);
  jobLog(`  input      : ${inputPath}`);
  jobLog(`  resolution : ${stream.width || '?'}x${height || '?'}${doDownscale ? ` -> ${downscaleRes}` : ''}`);
  jobLog(`  target     : VMAF ${targetVmaf}  CRF ${minCrf}-${maxCrf}`);
  jobLog(`  max size   : ${maxEncodedPercent}% of source`);
  jobLog(`  threads    : cpu=${availableThreads}  strategy=${threadStrategy}`);
  jobLog(`  phase 1    : ab-av1 crf-search (single-process, lp=${isAutoThreads ? 'auto' : searchBudget.svtLp})`);
  jobLog(`  phase 2    : av1an fixed-CRF (workers=${isAutoThreads ? 'auto' : encodeBudget.maxWorkers}, threads/worker=${isAutoThreads ? 'auto' : encodeBudget.threadsPerWorker})`);
  if (grainSynthEnabled) {
    jobLog(`  grain      : ${grainParam > 0 ? `enabled (film-grain=${grainParam})` : 'enabled (clean source, skipped)'}`);
  }
  jobLog('='.repeat(64));

  const sourceSizeGb = (() => {
    try { return fs.statSync(inputPath).size / (1024 ** 3); } catch (_) { return 0; }
  })();

  updateWorker({ percentage: 0, startTime: Date.now(), status: 'CRF Search' });

  // Build ab-av1 encoder flags
  let searchEncFlags;
  if (encoder === 'aom') {
    const tpw = isAutoThreads ? availableThreads : searchBudget.threadsPerWorker;
    searchEncFlags = buildAbAv1AomFlags(encPreset, tpw, hdrAom, grainParam);
  } else {
    searchEncFlags = isAutoThreads
      ? buildAbAv1SvtFlags(0, grainParam).replace(/--svt lp=\d+\s*/, '')
      : buildAbAv1SvtFlags(searchBudget.svtLp, grainParam);
  }

  const abEncoder = encoder === 'aom' ? 'libaom-av1' : 'libsvtav1';
  const searchVmafThreads = isAutoThreads ? availableThreads : searchBudget.vmafThreads;

  const abArgs = [
    'crf-search',
    '--input', inputPath,
    '--encoder', abEncoder,
    '--preset', String(encPreset),
    '--min-vmaf', String(targetVmaf),
    '--min-crf', String(minCrf),
    '--max-crf', String(maxCrf),
    '--vmaf', `n_threads=${searchVmafThreads}:model=path=${vmafModel}`,
    '--max-encoded-percent', String(maxEncodedPercent),
    '--cache', 'false',
  ];

  if (doDownscale) {
    abArgs.push(...buildAbAv1DownscaleArgs(downscaleRes));
  }

  searchEncFlags.split(/\s+/).filter(Boolean).forEach((tok) => abArgs.push(tok));

  jobLog(`[phase 1] ab-av1 ${abArgs.map((a) => /\s/.test(a) ? `"${a}"` : a).join(' ')}`);

  let crfSearchFailed = false;
  let foundCrf = null;

  // Parse ab-av1 crf-search output for the found CRF
  const onSearchLine = (line) => {
    dbg(`[ab-av1] ${line}`);

    // Log crf_search progress lines to Tdarr job log
    if (/command::crf_search\]/i.test(line)) {
      jobLog(line);
    }

    // Parse "crf N successful" -- definitive result from ab-av1
    const successMatch = line.match(/crf\s+([\d.]+)\s+successful/i);
    if (successMatch) {
      foundCrf = parseFloat(successMatch[1]);
      dbg(`[crf-search] success: crf=${foundCrf}`);
      return;
    }

    // Parse "crf N VMAF X" results -- fallback, keep updating to last meeting target
    const crfMatch = line.match(/crf\s+([\d.]+)\s+.*VMAF\s+([\d.]+)/i);
    if (crfMatch) {
      const crf = parseFloat(crfMatch[1]);
      const vmaf = parseFloat(crfMatch[2]);
      dbg(`[crf-search] candidate crf=${crf} vmaf=${vmaf}`);
      if (vmaf >= targetVmaf) {
        foundCrf = crf;
      }
    }

    if (/failed to find a suitable crf/i.test(line)) {
      jobLog('[crf-search] could not find a suitable CRF');
      crfSearchFailed = true;
    }
    if (/encoded size .* too large|max.encoded.percent|will not be smaller/i.test(line)) {
      jobLog('[crf-search] estimated output exceeds max-encoded-percent limit');
      crfSearchFailed = true;
    }
    if (/\b(error|warn|panic|failed|abort)\b/i.test(line)) {
      jobLog(line);
    }
  };

  pm.installCancelHandler(() => {});

  const abExit = await pm.spawnAsync(BIN.ab_av1, abArgs, {
    cwd: searchDir,
    onLine: onSearchLine,
    filter: () => false,
    onSpawn: (pid) => pm.startPpidWatcher(pid),
  });

  if (crfSearchFailed || abExit !== 0 || foundCrf == null) {
    pm.cleanup();
    jobLog('='.repeat(64));
    jobLog(`CRF SEARCH FAILED -- ${crfSearchFailed ? 'criteria not met' : `ab-av1 exited ${abExit}`}`);
    jobLog('='.repeat(64));
    return {
      outputFileObj: args.inputFileObj,
      outputNumber: 2,
      variables: args.variables,
    };
  }

  jobLog(`[phase 1] found CRF ${foundCrf} meeting VMAF >= ${targetVmaf}`);

  // ── Phase 2: av1an Chunked Encode ─────────────────────────────────────
  updateWorker({ percentage: 0, status: 'Encoding' });

  const audioSizeGb = await probeAudioSize(inputPath, args.workDir, dbg, dbg);

  // Build encoder flags for av1an (fixed CRF, no target-quality)
  let encFlags;
  if (encoder === 'aom') {
    const crfFlag = `--cq-level=${foundCrf}`;
    if (isAutoThreads) {
      encFlags = buildAomFlags(encPreset, 0, hdrAom, grainParam).replace(/--threads=\d+\s*/, '') + ' ' + crfFlag;
    } else {
      encFlags = buildAomFlags(encPreset, encodeBudget.threadsPerWorker, hdrAom, grainParam) + ' ' + crfFlag;
    }
  } else {
    const crfFlag = `--crf ${foundCrf}`;
    if (isAutoThreads) {
      encFlags = buildSvtFlags(encPreset, 0, hdrSvt, grainParam).replace(/--lp \d+\s*/, '') + ' ' + crfFlag;
    } else {
      encFlags = buildSvtFlags(encPreset, encodeBudget.svtLp, hdrSvt, grainParam) + ' ' + crfFlag;
    }
  }

  jobLog(`[phase 2] enc flags: ${encFlags}`);

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
    ...(isAutoThreads ? [] : ['--workers', String(encodeBudget.maxWorkers)]),
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

  jobLog(`[phase 2] av1an ${av1anArgs.map((a) => /\s/.test(a) ? `"${a}"` : a).join(' ')}`);

  let sizeExceeded = false;
  let tracker;

  pm.installCancelHandler(() => {
    if (tracker) tracker.stop();
  });

  updateWorker({ status: 'Scene Detection' });

  tracker = createAv1anTracker({
    workBase,
    maxWorkers: encodeBudget.maxWorkers,
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
  jobLog(`  CRF used: ${foundCrf}`);
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
