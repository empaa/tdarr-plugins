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

  const { createProcessManager } = require('../shared/processManager');
  const { createLogger, humanSize } = require('../shared/logger');
  const { detectHdrMeta, buildAomFlags, buildSvtFlags } = require('../shared/encoderFlags');
  const { shouldDownscale, buildVsDownscaleLines, buildAv1anVmafResArgs } = require('../shared/downscale');
  const { probeAudioSize, mergeAudioVideo } = require('../shared/audioMerge');
  const { createAv1anTracker } = require('../shared/progressTracker');
  const {
    buildSourceVpy, av1anReachedChunking, isSourceDecodeErrorLine, shouldRetryWithMezzanine,
  } = require('../shared/vsSource');
  const { buildMezzanineArgs } = require('../shared/mezzanine');

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
  const streams = (file.ffProbeData && file.ffProbeData.streams) || [];
  const stream = streams.find((s) => s.codec_type === 'video') || {};
  const height = stream.height || 0;
  const sourceWidth = stream.width || 0;

  const doDownscale = downscaleEnabled && shouldDownscale(sourceWidth, downscaleRes);
  if (downscaleEnabled && !doDownscale) {
    jobLog(`Downscale skipped: source ${sourceWidth}px is already at or below ${downscaleRes} target`);
  }

  const { hdrAom, hdrSvt } = detectHdrMeta(stream);

  const workBase = path.join(args.workDir, 'av1an-work');
  const vsDir = path.join(workBase, 'vs');
  const av1anTemp = path.join(workBase, 'work');
  const outputPath = path.join(args.workDir, 'av1-output.mkv');
  fs.mkdirSync(vsDir, { recursive: true });
  fs.mkdirSync(av1anTemp, { recursive: true });

  const lwiCache = path.join(vsDir, 'source.lwi');

  const encFlags = encoder === 'aom'
    ? buildAomFlags(encPreset, hdrAom)
    : buildSvtFlags(encPreset, hdrSvt);

  jobLog('='.repeat(64));
  jobLog(`AV1AN ENCODE  encoder=${encoder}  preset=${encPreset}`);
  jobLog(`  input      : ${inputPath}`);
  jobLog(`  resolution : ${stream.width || '?'}x${height || '?'}${doDownscale ? ` -> ${downscaleRes}` : ''}`);
  jobLog(`  target     : VMAF ${targetVmaf}  QP-range ${qpRange}`);
  jobLog(`  max size   : ${maxEncodedPercent}% of source`);
  jobLog(`  enc flags  : ${encFlags}`);
  jobLog('='.repeat(64));

  const sourceSizeGb = (() => {
    try { return fs.statSync(inputPath).size / (1024 ** 3); } catch (_) { return 0; }
  })();

  updateWorker({ percentage: 0, startTime: Date.now(), status: 'Processing' });

  const audioSizeGb = await probeAudioSize(inputPath, args.workDir, dbg, dbg);

  const vpyScript = path.join(vsDir, 'source.vpy');
  const mezzPath = path.join(workBase, 'source.mezzanine.mkv');

  const downscaleLines = doDownscale ? buildVsDownscaleLines(downscaleRes) : [];

  // The video source lsmas reads. Starts as the original; on a decode failure it
  // is re-pointed at a lossless mezzanine (see the retry below).
  let sourcePath = inputPath;

  // Write source.vpy for the current sourcePath and pre-build its lsmas frame
  // index so av1an's parallel workers don't race to build it.
  const prepareSource = async () => {
    try { fs.rmSync(lwiCache, { force: true }); } catch (_) {}
    fs.writeFileSync(vpyScript, buildSourceVpy({ inputPath: sourcePath, cachePath: lwiCache, downscaleLines }));
    dbg(`[vs] .vpy written (lsmas${doDownscale ? `, Lanczos3 -> ${downscaleRes}` : ', passthrough'})`);
    updateWorker({ status: 'Indexing' });
    const idxExit = await pm.spawnAsync(BIN.vspipe, ['--info', vpyScript], { cwd: vsDir, silent: true });
    dbg(idxExit === 0 ? '[vs] lsmas index ready' : '[vs] WARNING: lsmas index non-zero -- workers will retry');
  };

  const av1anArgs = [
    '-i', vpyScript,
    '-o', outputPath,
    '--temp', av1anTemp,
    '-c', 'mkvmerge',
    '-e', encoder,
    '--sc-downscale-height', '540',
    '--scaler', 'lanczos',
    '--qp-range', qpRange,
    '--target-quality', String(targetVmaf),
    '--vmaf-path', vmafModel,
    '--probes', '6',
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
  // Set when lsmas reports a frame-delivery failure during an attempt. lsmas can
  // fail at any point, not just before chunking, so this -- not chunks.json --
  // is the reliable source-failure signal once an encode is under way.
  let sawSourceDecodeError = false;

  pm.installCancelHandler(() => {
    if (tracker) tracker.stop();
  });

  // Keep lsmas decode errors + the split panic visible in the job log (they were
  // previously filtered out, hiding the real source-failure reason).
  const AV1AN_KEEP = /scenecut|error|warn|panic|crash|failed|lsmas|split scores|VideoSource|Failed to retrieve|failed to output/i;

  const runAv1anAttempt = async () => {
    updateWorker({ status: 'Scene Detection' });
    sawSourceDecodeError = false;
    tracker = createAv1anTracker({
      workBase,
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
    const exit = await pm.spawnAsync(BIN.av1an, av1anArgs, {
      cwd: vsDir,
      onLine: (l) => { if (isSourceDecodeErrorLine(l)) sawSourceDecodeError = true; },
      filter: (l) => AV1AN_KEEP.test(l),
      onSpawn: (pid) => pm.startPpidWatcher(pid),
    });
    tracker.stop();
    return exit;
  };

  // Total frame count for mezzanine transcode progress (best-effort).
  const totalFrames = (() => {
    const n = Number(stream.nb_frames);
    if (n > 0) return n;
    const fmt = (file.ffProbeData && file.ffProbeData.format) || {};
    const dur = Number(stream.duration || fmt.duration || 0);
    const fr = /^(\d+)\/(\d+)$/.exec(String(stream.r_frame_rate || ''));
    return dur > 0 && fr && +fr[2] > 0 ? Math.round(dur * (+fr[1] / +fr[2])) : 0;
  })();

  // One linear ffmpeg pass: re-wrap the video losslessly to FFV1 so lsmas can
  // decode+seek it. Reports frame progress to the dashboard.
  const runMezzanine = () => pm.spawnAsync(BIN.ffmpeg, buildMezzanineArgs({ inputPath, outputPath: mezzPath }), {
    cwd: workBase,
    onLine: (l) => {
      const m = /frame=\s*(\d+)/.exec(l);
      if (m && totalFrames > 0) {
        const pct = Math.min(99, Math.round((+m[1] / totalFrames) * 100));
        updateWorker({ percentage: pct, status: `Transcoding source (lossless) ${pct}%` });
      }
    },
    filter: (l) => /error|fatal|invalid|no such|unable/i.test(l),
  });

  await prepareSource();
  let av1anExit = await runAv1anAttempt();

  // Source-decode failure. Two signatures, either of which warrants the retry:
  //   * lsmas reported a frame-delivery failure. This can happen mid-encode on a
  //     partially decodable stream -- the 2026-08-01 VC-1 remux indexed and
  //     scene-detected into 914 chunks, then died on chunk 913 frame 196 with
  //     "lsmas: failed to output a video frame".
  //   * no chunks.json: av1an died at/before scene-splitting, i.e. lsmas starved
  //     scene detection -> split/mod.rs panic.
  // Re-wrap the video losslessly to an FFV1 mezzanine that lsmas can decode and
  // seek cheaply, then retry once. (Direct BestSource decoded VC-1 but its
  // per-chunk seeking made a full-length encode take 200h+, so it was removed.)
  if (shouldRetryWithMezzanine({
    exitCode: av1anExit,
    sizeExceeded,
    sawSourceDecodeError,
    reachedChunking: av1anReachedChunking(av1anTemp),
  })) {
    jobLog('='.repeat(64));
    jobLog(sawSourceDecodeError
      ? '[av1an] lsmas failed to deliver a frame -- source is not reliably decodable (e.g. VC-1).'
      : '[av1an] lsmas failed before chunking -- likely an undecodable source (e.g. VC-1).');
    jobLog('[av1an] building a lossless mezzanine (ffmpeg FFV1) and retrying via lsmas...');
    jobLog('='.repeat(64));
    updateWorker({ status: 'Transcoding source (lossless)' });
    const mezzExit = await runMezzanine();
    if (mezzExit !== 0 || !fs.existsSync(mezzPath) || fs.statSync(mezzPath).size === 0) {
      pm.cleanup();
      try { fs.rmSync(mezzPath, { force: true }); } catch (_) {}
      throw new Error('mezzanine transcode failed -- source could not be decoded for encoding');
    }
    jobLog(`[av1an] mezzanine ready (${humanSize(fs.statSync(mezzPath).size)}); re-running encode via lsmas`);
    try { fs.rmSync(av1anTemp, { recursive: true, force: true }); } catch (_) {}
    fs.mkdirSync(av1anTemp, { recursive: true });
    sourcePath = mezzPath;
    await prepareSource();
    av1anExit = await runAv1anAttempt();
  }

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
  // Drop the (potentially large) lossless mezzanine if one was built.
  try { fs.rmSync(mezzPath, { force: true }); } catch (_) {}

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
