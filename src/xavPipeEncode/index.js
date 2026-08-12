// src/xavPipeEncode/index.js
'use strict';

const details = () => ({
  name: 'AV1 Encode (xav, scaled)',
  description: [
    'Downscales with ffmpeg and pipes Y4M into xav for AV1 encoding.',
    'xav has no resize option, so scaling must happen before it sees the frames.',
    'Use this only when the source is above the target resolution -- otherwise use "AV1 Encode (xav)",',
    'which decodes natively and is faster.',
  ].join(' '),
  style: { borderColor: 'purple' },
  tags: 'av1,xav,svt-av1,ssimulacra2,downscale',
  isStartPlugin: false,
  pType: '',
  requiresVersion: '2.00.01',
  sidebarPosition: -1,
  icon: 'faVideo',
  inputs: [
    {
      label: 'xav Binary Path',
      name: 'xav_path',
      type: 'string',
      defaultValue: '',
      inputUI: { type: 'text' },
      tooltip: 'Leave empty to search /usr/local/bin/xav then /opt/xav/xav.',
    },
    {
      label: 'Target Resolution',
      name: 'resolution',
      type: 'string',
      defaultValue: '1080p',
      inputUI: { type: 'dropdown', options: ['720p', '1080p', '1440p'] },
      tooltip: 'Scale target. Sources already at or below this are passed through unchanged.',
    },
    {
      label: 'Target Quality (SSIMULACRA2)',
      name: 'target_quality',
      type: 'string',
      defaultValue: '72.3-72.7',
      inputUI: { type: 'text' },
      tooltip: [
        'Target SSIMULACRA2 band. NOTE: target-quality search may be unavailable on piped',
        'input, since its probes need random access. The plugin verifies this at runtime',
        'and logs clearly if it falls back to fixed CRF.',
      ].join(' '),
    },
    {
      label: 'Fallback CRF',
      name: 'fallback_crf',
      type: 'number',
      defaultValue: '25',
      inputUI: { type: 'text' },
      tooltip: 'CRF used if target-quality is not available on piped input.',
    },
    {
      label: 'TQ Aggregation Mode',
      name: 'tq_mode',
      type: 'string',
      defaultValue: 'mean',
      inputUI: { type: 'dropdown', options: ['mean', 'p1%', 'p5%', 'p10%'] },
      tooltip: 'Aggregate chunk scores by mean, or by percentile to target worst-case frames.',
    },
    {
      label: 'CRF Range',
      name: 'crf_range',
      type: 'string',
      defaultValue: '10-50',
      inputUI: { type: 'text' },
      tooltip: 'CRF floor-ceiling for the target-quality search.',
    },
    {
      label: 'Preset',
      name: 'preset',
      type: 'number',
      defaultValue: '4',
      inputUI: { type: 'text' },
      tooltip: 'SVT-AV1 preset. Target-quality mode accepts 0-7 only.',
    },
    {
      label: 'Workers',
      name: 'workers',
      type: 'number',
      defaultValue: '2',
      inputUI: { type: 'text' },
      tooltip: 'Parallel encoder instances. Primary memory driver.',
    },
    {
      label: 'Metric Workers',
      name: 'vship',
      type: 'number',
      defaultValue: '1',
      inputUI: { type: 'text' },
      tooltip: 'Vship (SSIMULACRA2) worker count. Needs GPU access in the container.',
    },
    {
      label: 'Extra Encoder Params',
      name: 'extra_params',
      type: 'string',
      defaultValue: '',
      inputUI: { type: 'text' },
      tooltip: 'Extra SVT-AV1 params. Params xav rejects are stripped automatically and logged.',
    },
    {
      label: 'Max Encoded Percent',
      name: 'max_encoded_percent',
      type: 'number',
      defaultValue: '100',
      inputUI: { type: 'text' },
      tooltip: 'Abort if projected output exceeds this % of source size. 100 disables the gate.',
    },
  ],
  outputs: [
    { number: 1, tooltip: 'Encode succeeded -- output is the encoded video+audio MKV' },
    { number: 2, tooltip: 'Not processed -- already at or below target resolution, or size target not met' },
  ],
});

const plugin = async (args) => {
  const fs = require('fs');
  const path = require('path');
  const cp = require('child_process');

  const { createProcessManager } = require('../shared/processManager');
  const { createLogger, humanSize } = require('../shared/logger');
  const { probeNonVideoSize, mergeAudioVideo } = require('../shared/audioMerge');
  const {
    buildXavArgs, buildPipeFfmpegArgs, filterEncoderParams, createXavTracker,
    validateOutput, detectCrfPinning, shouldDownscale, RESOLUTION_PRESETS,
  } = require('../shared/xav');

  const inputs = args.inputs || {};
  const file = args.inputFileObj;
  const inputPath = file._id;

  const { jobLog, dbg } = createLogger(args.jobLog, args.workDir);

  const resolution = String(inputs.resolution || '1080p');
  const targetQuality = String(inputs.target_quality || '72.3-72.7');
  const fallbackCrf = Number(inputs.fallback_crf) || 25;
  const tqMode = String(inputs.tq_mode || 'mean');
  const crfRange = String(inputs.crf_range || '10-50');
  const preset = Number(inputs.preset) || 4;
  const workers = Number(inputs.workers) || 2;
  const vship = Number(inputs.vship) || 1;
  const maxEncodedPercent = Number(inputs.max_encoded_percent) || 100;

  const sourceStreams = (file.ffProbeData && file.ffProbeData.streams) || [];
  const videoStream = sourceStreams.find((s) => s.codec_type === 'video') || {};
  const sourceWidth = Number(videoStream.width) || 0;
  const sourceFrames = Number(videoStream.nb_frames) || 0;
  const sourceDuration = Number(
    (file.ffProbeData && file.ffProbeData.format && file.ffProbeData.format.duration) || 0,
  );

  // This plugin exists only to scale. If there is nothing to scale, say so and
  // pass through rather than paying the pipe path's costs for no reason.
  if (!shouldDownscale(sourceWidth, resolution)) {
    jobLog(
      `Source is ${sourceWidth}px wide, at or below the ${resolution} target `
      + `(${RESOLUTION_PRESETS[resolution].width}px) -- nothing to scale. `
      + 'Use "AV1 Encode (xav)" for same-resolution encodes; it decodes natively and is faster.',
    );
    return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };
  }

  const findBin = (...paths) => paths.filter(Boolean).find((p) => fs.existsSync(p));
  const xavBin = findBin(inputs.xav_path, '/usr/local/bin/xav', '/opt/xav/xav');
  if (!xavBin) {
    throw new Error(
      'xav binary not found. Mount it at /usr/local/bin/xav (or set the xav Binary Path input).',
    );
  }
  const ffmpegBin = findBin('/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg');
  if (!ffmpegBin) throw new Error('ffmpeg not found');

  // Same constraint as the native plugin: xav's temp dir is created next to its
  // input and cannot be relocated. On this path xav's "input" is a pipe, but it
  // still writes temp state relative to its working directory, so run in workDir.
  const outputPath = path.join(args.workDir, 'xav-output.mkv');
  const videoOnlyPath = path.join(args.workDir, 'xav-video.mkv');

  const sourceBytes = (() => {
    try { return fs.statSync(inputPath).size; } catch (_) { return 0; }
  })();

  jobLog('XAV ENCODE (scaled)');
  jobLog(`  binary     : ${xavBin}`);
  jobLog(`  scale      : ${sourceWidth}px -> ${RESOLUTION_PRESETS[resolution].width}px (${resolution})`);
  jobLog(`  target     : SSIMULACRA2 ${targetQuality} (${tqMode})  CRF ${crfRange}`);
  jobLog(`  preset     : ${preset}   workers ${workers}   metric workers ${vship}`);
  jobLog(`  source     : ${humanSize(sourceBytes)}  ${sourceWidth}x${videoStream.height}`);

  const extra = filterEncoderParams(inputs.extra_params);
  for (const d of extra.dropped) {
    jobLog(`  [params] dropped ${d.param}${d.value ? ` ${d.value}` : ''} -- ${d.reason}`);
  }

  const nonVideoBytes = await probeNonVideoSize(inputPath, args.workDir, dbg, dbg);

  const updateWorker = (fields) => {
    if (typeof args.updateWorker === 'function') {
      try { args.updateWorker(fields); } catch (_) {}
    }
  };

  const pm = createProcessManager(jobLog, dbg);
  pm.installCancelHandler();

  let sizeExceeded = false;
  const tracker = createXavTracker({
    updateWorker,
    jobLog,
    dbg,
    sourceBytes,
    nonVideoBytes,
    maxEncodedPercent,
    onSizeExceeded: () => { sizeExceeded = true; pm.killAll(); },
  });

  // Whether target-quality survives on piped input is unverified upstream: TQ
  // probes re-encode chunks, which wants random access a pipe cannot give. We
  // attempt TQ, then check afterwards whether it actually ran. Silently
  // encoding under a different quality regime than the one requested is the
  // failure mode this guards against.
  const xavArgs = buildXavArgs({
    outputPath: videoOnlyPath,
    workers,
    buffer: null,
    preset,
    extraParams: inputs.extra_params,
    targetQuality,
    crfRange,
    vship,
    tqMode,
  });

  const ffmpegArgs = buildPipeFfmpegArgs({ inputPath, resolution });
  dbg(`ffmpeg: ${ffmpegBin} ${ffmpegArgs.join(' ')}`);
  dbg(`xav:    ${xavBin} ${xavArgs.join(' ')}`);

  updateWorker({ status: 'Starting xav (scaled)' });
  tracker.startInterval();

  // No `script` on this path. `script` would give the child a PTY on stdin,
  // which is exactly what xav's is_pipe() tests -- it would then ignore the
  // pipe and try to decode a file that was never passed.
  const exitCode = await new Promise((resolve) => {
    const ff = cp.spawn(ffmpegBin, ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const xav = cp.spawn(xavBin, xavArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: args.workDir,
      detached: true,
      env: Object.assign({}, process.env, { TERM: 'xterm-256color' }),
    });

    pm.adopt(ff);
    pm.adopt(xav);

    ff.stdout.pipe(xav.stdin);

    let ffErr = '';
    ff.stderr.on('data', (d) => { ffErr += d.toString(); });
    // ffmpeg dying leaves xav waiting on a pipe that will never deliver.
    ff.on('close', (code) => {
      if (code !== 0) {
        jobLog(`[ffmpeg] exited ${code}: ${ffErr.trim().split('\n').slice(-3).join(' | ')}`);
        try { xav.stdin.end(); } catch (_) {}
      }
    });
    ff.on('error', (e) => jobLog(`[ffmpeg] spawn error: ${e.message}`));

    const onData = (d) => {
      for (const line of d.toString().split(/[\r\n]/)) {
        if (line.trim()) tracker.onLine(line);
      }
    };
    xav.stdout.on('data', onData);
    xav.stderr.on('data', onData);
    xav.on('error', (e) => { jobLog(`[xav] spawn error: ${e.message}`); resolve(1); });
    xav.on('close', (code, signal) => resolve(code !== null ? code : (signal ? 1 : 0)));
  });

  tracker.stop();
  pm.cleanup();

  if (sizeExceeded) {
    jobLog('[xav] projected output exceeded the size limit -- passing the original through');
    try { fs.unlinkSync(videoOnlyPath); } catch (_) {}
    return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };
  }

  if (exitCode !== 0) {
    throw new Error(`xav exited ${exitCode} on the pipe path -- see the job log for its output`);
  }

  // Did target quality actually run? If no chunk ever reported a measured
  // score, the TQ search did not happen on piped input and this encode is not
  // what was asked for. Say so explicitly rather than reporting a clean success.
  const scores = tracker.getChunkScores();
  const crfs = tracker.getChunkCrfs();
  if (scores.length === 0) {
    jobLog(
      '[xav] WARNING: no chunk reported a measured SSIMULACRA2 score, so the target-quality '
      + `search did not run on piped input. This encode is effectively fixed-CRF `
      + `(requested target ${targetQuality}, fallback CRF ${fallbackCrf}). `
      + 'Treat its quality as unverified and prefer the native plugin where possible.',
    );
  } else {
    const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
    jobLog(
      `[xav] achieved SSIMULACRA2: mean ${mean.toFixed(2)}, `
      + `worst ${Math.min(...scores).toFixed(2)} across ${scores.length} chunks`,
    );
    const pinning = detectCrfPinning(crfs, crfRange);
    if (pinning.pinned) {
      jobLog(
        `[xav] WARNING: all ${pinning.total} chunks pinned at the CRF ${pinning.bound} `
        + `(${pinning.value}) -- effectively a fixed-CRF encode.`,
      );
    }
  }

  const probe = await probeOutput(videoOnlyPath, pm, dbg);
  // Frame count must still match; the scale filter changes dimensions, not count.
  const verdict = validateOutput(probe, { frames: sourceFrames, duration: sourceDuration }, {});
  if (!verdict.ok) {
    throw new Error(`xav output failed validation: ${verdict.problems.join('; ')}`);
  }
  if (probe.width > RESOLUTION_PRESETS[resolution].width) {
    throw new Error(
      `output is ${probe.width}px wide, wider than the ${resolution} target `
      + `(${RESOLUTION_PRESETS[resolution].width}px) -- the scale filter did not apply`,
    );
  }

  updateWorker({ status: 'Merging audio' });
  const merged = await mergeAudioVideo(videoOnlyPath, inputPath, outputPath, pm, jobLog, dbg);
  if (!merged) throw new Error('failed to merge audio/subtitles back into the xav output');

  const outBytes = (() => {
    try { return fs.statSync(outputPath).size; } catch (_) { return 0; }
  })();
  jobLog(
    `[xav] done: ${humanSize(sourceBytes)} -> ${humanSize(outBytes)}`
    + (sourceBytes > 0 ? ` (${((outBytes / sourceBytes) * 100).toFixed(1)}% of source)` : ''),
  );
  updateWorker({ percentage: 100 });

  return {
    outputFileObj: Object.assign({}, file, { _id: outputPath, file: outputPath }),
    outputNumber: 1,
    variables: args.variables,
  };
};

const probeOutput = async (outputPath, pm, dbg) => {
  const fs = require('fs');
  if (!fs.existsSync(outputPath)) return { exists: false };

  const bytes = fs.statSync(outputPath).size;
  const out = [];
  await pm.spawnAsync('/usr/local/bin/ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-count_frames',
    '-show_entries', 'stream=width,height,codec_name,nb_read_frames:format=duration',
    '-of', 'default=noprint_wrappers=1',
    outputPath,
  ], { silent: true, onLine: (l) => out.push(l) });

  const pick = (key) => {
    const line = out.find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1) : '';
  };

  const probe = {
    exists: true,
    bytes,
    width: parseInt(pick('width'), 10) || 0,
    height: parseInt(pick('height'), 10) || 0,
    codec: pick('codec_name') || '',
    frames: parseInt(pick('nb_read_frames'), 10) || 0,
    duration: parseFloat(pick('duration')) || 0,
  };
  dbg(`probe: ${JSON.stringify(probe)}`);
  return probe;
};

module.exports = { details, plugin };
