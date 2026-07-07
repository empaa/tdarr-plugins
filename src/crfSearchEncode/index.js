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
    buildAbAv1SvtFlags, buildAbAv1AomFlags,
  } = require('../shared/encoderFlags');
  const { shouldDownscale, buildVsDownscaleLines, buildAv1anVmafResArgs, buildAbAv1DownscaleArgs } = require('../shared/downscale');
  const { probeAudioSize, mergeAudioVideo } = require('../shared/audioMerge');
  const { createAv1anTracker } = require('../shared/progressTracker');
  const { buildSourceVpy, sceneDetectProducedScenes, SOURCE_LSMAS, SOURCE_BESTSOURCE } = require('../shared/vsSource');

  const inputs = args.inputs || {};
  const encoder           = String(inputs.encoder || 'svt-av1');
  const targetVmaf        = Number(inputs.target_vmaf) || 93;
  const minCrf            = Number(inputs.min_crf) || 10;
  const maxCrf            = Number(inputs.max_crf) || 50;
  const encPreset         = Number(inputs.preset) || 4;
  const maxEncodedPercent = Number(inputs.max_encoded_percent) || 80;
  const downscaleEnabled  = inputs.downscale_enabled === true || inputs.downscale_enabled === 'true';
  const downscaleRes      = String(inputs.downscale_resolution || '1080p');

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
  const pm = createProcessManager(jobLog, dbg);

  const updateWorker = (fields) => {
    if (typeof args.updateWorker === 'function') {
      try { args.updateWorker(fields); } catch (_) {}
    }
  };

  const file = args.inputFileObj;
  const inputPath = file._id;
  const streams = (file.ffProbeData && file.ffProbeData.streams) || [];
  const stream = streams.find((s) => s.codec_type === 'video') || {};
  const height = stream.height || 0;
  const sourceWidth = stream.width || 0;

  const doDownscale = downscaleEnabled && shouldDownscale(sourceWidth, downscaleRes);
  if (downscaleEnabled && !doDownscale) {
    jobLog(`Downscale skipped: source ${sourceWidth}px is already at or below ${downscaleRes} target`);
  }

  const { hdrAom, hdrSvt } = detectHdrMeta(stream);

  // ── Work directory setup ─────────────────────────────────────────────
  const workBase = path.join(args.workDir, 'crf-search-work');
  const vsDir = path.join(workBase, 'vs');
  const av1anTemp = path.join(workBase, 'work');
  const searchDir = path.join(workBase, 'search');
  const outputPath = path.join(args.workDir, 'crf-output.mkv');
  fs.mkdirSync(vsDir, { recursive: true });
  fs.mkdirSync(av1anTemp, { recursive: true });
  fs.mkdirSync(searchDir, { recursive: true });

  const lwiCache = path.join(vsDir, 'source.lwi');
  const bsCache = path.join(vsDir, 'source.bsindex');

  // ffprobe framerate for the BestSource AssumeFPS relabel (BestSource can
  // misdetect fps on some VC-1 remuxes; lsmas reports it correctly).
  const parseFps = (v) => {
    const m = /^(\d+)\/(\d+)$/.exec(String(v || ''));
    return m && +m[2] > 0 ? { num: +m[1], den: +m[2] } : { num: 0, den: 0 };
  };
  const { num: fpsNum, den: fpsDen } = parseFps(stream.r_frame_rate || stream.avg_frame_rate);
  const downscaleLines = doDownscale ? buildVsDownscaleLines(downscaleRes) : [];

  const bestSourceAvailable = () => [
    '/usr/local/lib/python3/dist-packages/vapoursynth/plugins',
    '/usr/local/lib/vapoursynth',
  ].some((d) => { try { return fs.readdirSync(d).some((f) => /bestsource/i.test(f)); } catch (_) { return false; } });

  // Build VapourSynth script (shared by scene detection and phase 2) for a given
  // source filter and pre-build its frame index.
  const vpyScript = path.join(vsDir, 'source.vpy');
  const prepareSource = async (sourceFilter) => {
    const cachePath = sourceFilter === SOURCE_BESTSOURCE ? bsCache : lwiCache;
    fs.writeFileSync(vpyScript, buildSourceVpy({
      sourceFilter, inputPath, cachePath, fpsNum, fpsDen, downscaleLines,
    }));
    dbg(`[vs] .vpy written (${sourceFilter}${doDownscale ? `, Lanczos3 -> ${downscaleRes}` : ', passthrough'})`);
    updateWorker({ status: 'Indexing' });
    const idxExit = await pm.spawnAsync(BIN.vspipe, ['--info', vpyScript], { cwd: vsDir, silent: true });
    dbg(idxExit === 0 ? `[vs] ${sourceFilter} index ready` : `[vs] WARNING: ${sourceFilter} index non-zero -- workers will retry`);
  };

  await prepareSource(SOURCE_LSMAS);

  // ── Scene detection (parallel with CRF search) ──────────────────────
  const scenesPath = path.join(workBase, 'scenes.json');
  const scOnlyArgs = [
    '-i', vpyScript,
    '--sc-only',
    '--scenes', scenesPath,
    '--sc-downscale-height', '540',
    '--min-scene-len', '24',
    '--verbose',
  ];

  jobLog(`[scene-detect] starting in background: av1an ${scOnlyArgs.join(' ')}`);
  const sceneDetectPromise = pm.spawnAsync(BIN.av1an, scOnlyArgs, {
    cwd: vsDir,
    filter: (l) => /scenecut|error|warn/i.test(l),
  });

  // ── Phase 1: CRF Search ──────────────────────────────────────────────
  jobLog('='.repeat(64));
  jobLog(`CRF SEARCH ENCODE  encoder=${encoder}  preset=${encPreset}`);
  jobLog(`  input      : ${inputPath}`);
  jobLog(`  resolution : ${stream.width || '?'}x${height || '?'}${doDownscale ? ` -> ${downscaleRes}` : ''}`);
  jobLog(`  target     : VMAF ${targetVmaf}  CRF ${minCrf}-${maxCrf}`);
  jobLog(`  max size   : ${maxEncodedPercent}% of source`);
  jobLog(`  phase 1    : ab-av1 crf-search`);
  jobLog(`  phase 2    : av1an fixed-CRF`);
  jobLog('='.repeat(64));

  const sourceSizeGb = (() => {
    try { return fs.statSync(inputPath).size / (1024 ** 3); } catch (_) { return 0; }
  })();

  updateWorker({ percentage: 0, startTime: Date.now(), status: 'CRF Search' });

  // Build ab-av1 encoder flags
  const searchEncFlags = encoder === 'aom'
    ? buildAbAv1AomFlags(encPreset, hdrAom)
    : buildAbAv1SvtFlags();

  const abEncoder = encoder === 'aom' ? 'libaom-av1' : 'libsvtav1';
  const searchVmafThreads = os.cpus().length;

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

  if (abExit !== 0 && !crfSearchFailed) {
    jobLog('[scene-detect] aborting (ab-av1 crashed)');
    pm.cleanup();
    throw new Error(`ab-av1 crashed (exit code ${abExit}) -- check logs for OOM or other fatal errors`);
  }

  if (crfSearchFailed || foundCrf == null) {
    jobLog('[scene-detect] aborting (CRF search did not succeed)');
    pm.cleanup();
    jobLog('='.repeat(64));
    jobLog('CRF SEARCH FAILED -- criteria not met');
    jobLog('='.repeat(64));
    return {
      outputFileObj: args.inputFileObj,
      outputNumber: 2,
      variables: args.variables,
    };
  }

  jobLog(`[phase 1] found CRF ${foundCrf} meeting VMAF >= ${targetVmaf}`);

  // Wait for scene detection to finish (may already be done)
  let sceneDetectDone = false;
  sceneDetectPromise.then(() => { sceneDetectDone = true; }).catch(() => { sceneDetectDone = true; });
  await new Promise((r) => setImmediate(r));

  if (!sceneDetectDone) {
    jobLog('[scene-detect] CRF search complete, waiting for scene detection...');
    updateWorker({ status: 'Scene Detection' });
  } else {
    jobLog('[scene-detect] already complete');
  }
  let sceneDetectExit = await sceneDetectPromise;

  // If lsmas scene detection failed to produce scenes (e.g. it cannot decode
  // this VC-1 stream), retry once with the ffmpeg-based BestSource source.
  // Phase 2 reuses the same vpyScript (now BestSource), keeping the job consistent.
  if (sceneDetectExit !== 0 && !sceneDetectProducedScenes(scenesPath)) {
    if (bestSourceAvailable()) {
      jobLog('[scene-detect] lsmas scene detection failed before producing scenes -- retrying with BestSource...');
      try { fs.rmSync(scenesPath, { force: true }); } catch (_) {}
      await prepareSource(SOURCE_BESTSOURCE);
      updateWorker({ status: 'Scene Detection' });
      sceneDetectExit = await pm.spawnAsync(BIN.av1an, scOnlyArgs, {
        cwd: vsDir,
        filter: (l) => /scenecut|error|warn|lsmas|split scores|VideoSource|Failed to retrieve/i.test(l),
      });
    } else {
      jobLog('[scene-detect] lsmas failed and BestSource (core.bs) is not present in this image -- update the tdarr-av1 stack.');
    }
  }

  if (sceneDetectExit !== 0) {
    pm.cleanup();
    throw new Error(`Scene detection failed (exit ${sceneDetectExit})`);
  }

  jobLog(`[scene-detect] scenes written to ${scenesPath}`);

  // ── Phase 2: av1an Chunked Encode ─────────────────────────────────────
  updateWorker({ percentage: 0, status: 'Encoding' });

  const audioSizeGb = await probeAudioSize(inputPath, args.workDir, dbg, dbg);

  // Build encoder flags for av1an (fixed CRF, no target-quality)
  const encFlags = encoder === 'aom'
    ? buildAomFlags(encPreset, hdrAom) + ` --cq-level=${foundCrf}`
    : buildSvtFlags(encPreset, hdrSvt) + ` --crf ${foundCrf}`;

  jobLog(`[phase 2] enc flags: ${encFlags}`);

  const av1anArgs = [
    '-i', vpyScript,
    '-o', outputPath,
    '--temp', av1anTemp,
    '-c', 'mkvmerge',
    '-e', encoder,
    '--sc-downscale-height', '540',
    '--scaler', 'lanczos',
    '--chunk-order', 'long-to-short',
    '--scenes', scenesPath,
    '--keep',
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

  updateWorker({ status: 'Encoding' });

  tracker = createAv1anTracker({
    workBase,
    scenesFile: scenesPath,
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
