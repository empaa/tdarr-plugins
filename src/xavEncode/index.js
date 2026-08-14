// src/xavEncode/index.js
'use strict';

const details = () => ({
  name: 'AV1 Encode (xav)',
  description: [
    'Encodes video to AV1 using xav with per-scene SSIMULACRA2 target-quality search.',
    'Runs at the source resolution -- xav has no resize option, so use "AV1 Encode (xav, scaled)"',
    'when the source must be downscaled.',
    'Live progress, FPS, ETA and estimated size on the dashboard. Cancel kills the encoder.',
  ].join(' '),
  style: { borderColor: 'purple' },
  tags: 'av1,xav,svt-av1,ssimulacra2,target-quality',
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
      label: 'Target Quality (SSIMULACRA2)',
      name: 'target_quality',
      type: 'string',
      defaultValue: '74.8-75.2',
      inputUI: { type: 'text' },
      tooltip: [
        'Target SSIMULACRA2 band. Tier targets: top 74.8-75.2, mid 70.8-71.2,',
        'low 66.8-67.2. Measured across 28 encodes, 2026-08-13/14.',
        'At the top tier that is 63% of source on grain-heavy film, 47% on',
        'clean 1080p and 16% on high-motion digital.',
        'Do not raise it much further: SSIMU2 79.67 measures as VMAF 98.5, past',
        'the VMAF 95 that reads as visually lossless, and above ~76 the cost',
        'curve turns steeply non-linear because the metric scores against the',
        'SOURCE -- a high target pays to reproduce the source\'s own grain and',
        'compression artifacts. Close Encounters needed 100.5% of its source at',
        'SSIMU2 80 to buy 1.44 VMAF points over 74.',
        'Note the search lands within about +/-2 of the request, so the narrow',
        'band is a target, not a guarantee.',
      ].join(' '),
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
      defaultValue: '5-63',
      inputUI: { type: 'text' },
      tooltip: [
        'CRF floor-ceiling the target-quality search may use. Keep it WIDE:',
        'a run whose chunks all pin at a bound is a fixed-CRF encode wearing a',
        'target-quality costume, and the plugin will warn when that happens.',
        'Measured mean CRF ranges from ~8 on demanding content at the top tier to',
        '~41 on easy content at the low tier, so 10-50 is too narrow at both ends.',
      ].join(' '),
    },
    {
      label: 'Preset',
      name: 'preset',
      type: 'number',
      defaultValue: '6',
      inputUI: { type: 'text' },
      tooltip: [
        'SVT-AV1 preset. Target-quality mode accepts 0-7 only; 8+ is rejected.',
        'Use 6 on every tier: measured head-to-head at a matched target on four',
        'clips, preset 4 bought 0.9% smaller files for ~25% more encode time,',
        'and on one clip it was LARGER. The target-quality search dominates,',
        'so spending the time on a slower preset does not reach the output.',
      ].join(' '),
    },
    {
      label: 'Workers',
      name: 'workers',
      type: 'number',
      defaultValue: '2',
      inputUI: { type: 'text' },
      tooltip: 'Parallel encoder instances. Primary memory driver -- 4 workers on 1080p peaked ~20 GB.',
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
      label: 'Encoder Parameter Set',
      name: 'param_set',
      type: 'string',
      defaultValue: 'auto',
      inputUI: { type: 'dropdown', options: ['auto', 'mainline', 'hdr', 'none'] },
      tooltip: [
        'Which researched parameter set to send. auto picks by binary name:',
        'mainline gets the measured set (--tune 1, --enable-qm 1, --qm-min 0,',
        '--tf-strength 1, --sharpness 1, --tile-columns 1, --enable-variance-boost 1),',
        'and an hdr build gets preset only because its own defaults are the recipe.',
        'none sends preset alone -- that is SVT stock, measured at +18-22% bytes.',
        'Extra Encoder Params are appended after this set and win over it.',
      ].join(' '),
    },
    {
      label: 'Extra Encoder Params',
      name: 'extra_params',
      type: 'string',
      defaultValue: '',
      inputUI: { type: 'text' },
      tooltip: [
        'Extra SVT-AV1 params, e.g. "--tune 1 --enable-qm 1".',
        'Params xav rejects (--lookahead, --keyint, --input-depth, --irefresh-type,',
        '--enable-overlays, --crf, --rc, --scd) are stripped automatically and logged.',
      ].join(' '),
    },
    {
      label: 'GPU Decode',
      name: 'hwdec',
      type: 'boolean',
      defaultValue: 'false',
      inputUI: { type: 'switch' },
      tooltip: 'Pass --hwdec for GPU decoding.',
    },
    {
      label: 'Max Encoded Percent',
      name: 'max_encoded_percent',
      type: 'number',
      defaultValue: '80',
      inputUI: { type: 'text' },
      tooltip: [
        'Abort if projected output exceeds this % of source size; 100 disables the gate.',
        'Default 80: if an encode cannot save a fifth of the file it is not worth doing,',
        'and the original passes through untouched. This matters most on already-compressed',
        'WEB-DL sources, which have the least headroom.',
      ].join(' '),
    },
  ],
  outputs: [
    { number: 1, tooltip: 'Encode succeeded -- output is the encoded video+audio MKV' },
    { number: 2, tooltip: 'Not processed -- size target not met, input passed through unchanged' },
  ],
});

const plugin = async (args) => {
  const fs = require('fs');
  const path = require('path');

  const { createProcessManager } = require('../shared/processManager');
  const { createLogger, humanSize } = require('../shared/logger');
  const { probeNonVideoSize, mergeAudioVideo } = require('../shared/audioMerge');
  const {
    buildXavArgs, filterEncoderParams, resolveParamSet, createXavTracker, sourceVideoDuration,
    validateOutput, detectCrfPinning, logTargetHit,
  } = require('../shared/xav');

  const inputs = args.inputs || {};
  const file = args.inputFileObj;
  const inputPath = file._id;

  const { jobLog, dbg } = createLogger(args.jobLog, args.workDir);

  const targetQuality = String(inputs.target_quality || '74.8-75.2');
  const tqMode = String(inputs.tq_mode || 'mean');
  const crfRange = String(inputs.crf_range || '5-63');
  const preset = Number(inputs.preset) || 6;
  const workers = Number(inputs.workers) || 2;
  const vship = Number(inputs.vship) || 1;
  const hwdec = inputs.hwdec === true || inputs.hwdec === 'true';
  const maxEncodedPercent = Number(inputs.max_encoded_percent) || 80;

  const findBin = (...paths) => paths.filter(Boolean).find((p) => fs.existsSync(p));
  const xavBin = findBin(inputs.xav_path, '/usr/local/bin/xav', '/opt/xav/xav');
  if (!xavBin) {
    throw new Error(
      'xav binary not found. Mount it at /usr/local/bin/xav (or set the xav Binary Path input). '
      + 'The stock Tdarr image does not ship xav.',
    );
  }

  // xav hashes its input and creates a `.<hash>` temp dir NEXT TO THE INPUT
  // FILE, with no option to relocate it. If the working file is still on the
  // library share this scatters temp dirs across the library, and fails
  // outright (os error 30) on a read-only mount. sanitizeFile is responsible
  // for staging into workDir; refuse rather than make a mess.
  const workDirReal = fs.realpathSync(args.workDir);
  const inputDirReal = fs.realpathSync(path.dirname(inputPath));
  if (inputDirReal !== workDirReal) {
    throw new Error(
      `xav writes its temp directory next to the input file, but the working file is at `
      + `${inputDirReal} rather than the Tdarr working directory ${workDirReal}. `
      + 'Run sanitizeFile (which always stages into workDir) before this plugin.',
    );
  }

  const outputPath = path.join(args.workDir, 'xav-output.mkv');
  const videoOnlyPath = path.join(args.workDir, 'xav-video.mkv');

  const sourceBytes = (() => {
    try { return fs.statSync(inputPath).size; } catch (_) { return 0; }
  })();

  const sourceStreams = (file.ffProbeData && file.ffProbeData.streams) || [];
  const videoStream = sourceStreams.find((s) => s.codec_type === 'video') || {};
  const sourceFrames = Number(videoStream.nb_frames) || 0;
  const sourceDuration = sourceVideoDuration(
    videoStream, (file.ffProbeData && file.ffProbeData.format) || {},
  );

  jobLog('XAV ENCODE');
  jobLog(`  binary     : ${xavBin}`);
  jobLog(`  target     : SSIMULACRA2 ${targetQuality} (${tqMode})  CRF ${crfRange}`);
  jobLog(`  preset     : ${preset}   workers ${workers}   metric workers ${vship}`);
  jobLog(`  source     : ${humanSize(sourceBytes)}  ${videoStream.width}x${videoStream.height}`);

  const paramSet = resolveParamSet(inputs.param_set, xavBin);
  jobLog(`  params     : ${paramSet.why}`);
  if (paramSet.params) jobLog(`               ${paramSet.params}`);

  const extra = filterEncoderParams(inputs.extra_params);
  for (const d of extra.dropped) {
    jobLog(`  [params] dropped ${d.param}${d.value ? ` ${d.value}` : ''} -- ${d.reason}`);
  }

  // Audio and subtitles are merged back from the staged file after the encode,
  // so their bytes are an exact constant rather than an estimate.
  const nonVideoBytes = await probeNonVideoSize(inputPath, args.workDir, dbg, dbg);
  dbg(`non-video streams: ${humanSize(nonVideoBytes)}`);

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
    workDir: args.workDir,
    onSizeExceeded: () => { sizeExceeded = true; pm.killAll(); },
  });

  const xavArgs = buildXavArgs({
    inputPath,
    outputPath: videoOnlyPath,
    workers,
    buffer: null,
    preset,
    paramSet: inputs.param_set,
    binPath: xavBin,
    extraParams: inputs.extra_params,
    targetQuality,
    crfRange,
    vship,
    tqMode,
    hwdec,
  });

  // xav REQUIRES a TTY on stdin. src/y4m.rs defines is_pipe() as
  // !stdin().is_terminal(), with no flag or env override -- given no terminal it
  // assumes piped Y4M, reads nothing, writes an ~870-byte file, prints
  // DONE 100.00% and exits 0. Tdarr spawns via Node child_process with no TTY,
  // so `script` is not optional here.
  //
  // The argv is written to a launcher script rather than interpolated into
  // `script -qec "..."`, so filenames never traverse a shell-quoting layer.
  const launcherPath = path.join(args.workDir, 'xav-run.sh');
  const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  fs.writeFileSync(
    launcherPath,
    `#!/usr/bin/env bash\nexec ${shellQuote(xavBin)} ${xavArgs.map(shellQuote).join(' ')}\n`,
    { mode: 0o755 },
  );
  dbg(`launcher: ${fs.readFileSync(launcherPath, 'utf8').trim()}`);

  updateWorker({ status: 'Starting xav' });
  tracker.startInterval();

  const exitCode = await pm.spawnAsync('/usr/bin/script', ['-qec', launcherPath, '/dev/null'], {
    cwd: args.workDir,
    env: Object.assign({}, process.env, { TERM: 'xterm-256color' }),
    silent: true,
    onLine: tracker.onLine,
    // installCancelHandler only fires if OUR process lives long enough to run a
    // handler. Tdarr cancelling a job kills the worker outright, and on
    // 2026-08-13 that left xav running at 1267% CPU holding a deleted 39.6 GB
    // file (job eUZ3g_6xN) -- the tree had been reparented to PPID 1. The
    // watchdog is a detached bash that outlives us and group-kills the encoder
    // when the worker disappears, which is the only thing that covers a kill we
    // never get to observe.
    onSpawn: (pid) => pm.startPpidWatcher(pid),
  });

  tracker.stop();
  pm.cleanup();

  if (sizeExceeded) {
    jobLog('[xav] projected output exceeded the size limit -- passing the original through');
    try { fs.unlinkSync(videoOnlyPath); } catch (_) {}
    return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };
  }

  if (exitCode !== 0) {
    throw new Error(`xav exited ${exitCode} -- see the job log for its output`);
  }

  // A target-quality run whose chunks all landed on a CRF bound measured
  // nothing: it is a fixed-CRF encode wearing a target-quality costume. Warn
  // loudly, but the encode itself is valid so do not fail it.
  const pinning = detectCrfPinning(tracker.getChunkCrfs(), crfRange);
  if (pinning.pinned) {
    jobLog(
      `[xav] WARNING: all ${pinning.total} chunks pinned at the CRF ${pinning.bound} `
      + `(${pinning.value}). The target-quality search had nowhere to go, so this is `
      + `effectively a fixed-CRF encode. Widen the CRF range or change the target.`,
    );
  }
  const scores = tracker.getChunkScores();
  if (scores.length) {
    const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
    jobLog(
      `[xav] achieved SSIMULACRA2: mean ${mean.toFixed(2)}, `
      + `worst ${Math.min(...scores).toFixed(2)} across ${scores.length} chunks`,
    );
    logTargetHit(jobLog, tracker.getChunkStats(), targetQuality, crfRange);
  }

  // xav's own MUX phase set the status to "Muxing" before exiting, so without
  // this the dashboard attributes the whole validation to muxing -- which is how
  // 42 minutes of ffprobe on Avatar looked like a stalled mux (job yf2quTpnG).
  updateWorker({ status: 'Validating output' });
  const probe = await probeOutput(videoOnlyPath, pm, dbg);
  const verdict = validateOutput(probe, { frames: sourceFrames, duration: sourceDuration }, {});
  if (!verdict.ok) {
    throw new Error(`xav output failed validation: ${verdict.problems.join('; ')}`);
  }

  updateWorker({ status: 'Merging audio' });
  const merged = await mergeAudioVideo(videoOnlyPath, inputPath, outputPath, pm, jobLog, dbg);
  if (!merged) {
    throw new Error('failed to merge audio/subtitles back into the xav output');
  }

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

// ffprobe the encoded video so validation has real numbers rather than trust.
const probeOutput = async (outputPath, pm, dbg) => {
  const fs = require('fs');
  if (!fs.existsSync(outputPath)) return { exists: false };

  const ffprobeBin = ['/usr/local/bin/ffprobe', '/usr/bin/ffprobe']
    .find((p) => fs.existsSync(p)) || 'ffprobe';
  const bytes = fs.statSync(outputPath).size;
  const out = [];
  // -count_packets, NOT -count_frames. Both yield one count per coded frame for
  // AV1 in Matroska, but -count_frames DECODES the whole file to get there: on
  // Avatar (16.8 GB, 283893 frames) it took 42m42s, about 40% of the entire job,
  // while the dashboard still read "Muxing". Counting packets is a demux and
  // costs seconds. Measured 2026-08-14, job yf2quTpnG.
  await pm.spawnAsync(ffprobeBin, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-count_packets',
    '-show_entries', 'stream=width,height,codec_name,nb_read_packets:format=duration',
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
    frames: parseInt(pick('nb_read_packets'), 10) || 0,
    duration: parseFloat(pick('duration')) || 0,
  };
  dbg(`probe: ${JSON.stringify(probe)}`);
  return probe;
};

module.exports = { details, plugin };
