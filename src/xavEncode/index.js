// src/xavEncode/index.js
'use strict';

const details = () => ({
  name: 'AV1 Encode (xav)',
  description: [
    'Encodes video to AV1 using xav (github.com/emrakyz/xav) with per-scene SSIMULACRA2',
    'target-quality search.',
    'Set "Max Resolution" to downscale anything above it: xav has no resize of its own, so',
    'those sources are decoded and scaled by ffmpeg and piped in, while everything at or',
    'below the cap takes the faster native path. The choice is made per file from the source',
    'width -- no branching needed in the flow.',
    'Live progress, FPS, ETA and estimated size on the dashboard. Cancel kills the encoder.',
  ].join(' '),
  style: { borderColor: 'purple' },
  tags: 'av1,xav,svt-av1,ssimulacra2,target-quality,downscale',
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
      label: 'Max Resolution',
      name: 'max_resolution',
      type: 'string',
      defaultValue: 'off',
      inputUI: { type: 'dropdown', options: ['off', '720p', '1080p', '1440p'] },
      tooltip: [
        'Sources WIDER than this are downscaled to it; sources at or below it are encoded',
        'at their own resolution. "off" never scales.',
        'The two are genuinely different pipelines -- scaling puts ffmpeg in front of xav',
        'over a pipe, which costs GPU decode and resume support (see those tooltips) -- but',
        'which one a file needs is decided here from its width, not in the flow.',
      ].join(' '),
    },
    {
      label: 'Target Quality (SSIMULACRA2)',
      name: 'target_quality',
      type: 'string',
      defaultValue: '74.8-75.2',
      inputUI: { type: 'text' },
      tooltip: [
        'Target SSIMULACRA2 band. Tier ladder in use: top 74.8-75.2, mid 70.8-71.2,',
        'low 66.8-67.2 -- pair each with the matching CRF Range ceiling (30/40/50).',
        'At the top tier that is 63% of source on grain-heavy film, 47% on',
        'clean 1080p and 16% on high-motion digital.',
        'IMPORTANT: the score is not a quality guarantee on flat, low-detail content',
        '(skies, fades, gradients, logos over black). There the metric saturates --',
        'measured 0.6 points per CRF step against a normal 1.0-1.4 -- so the search',
        'runs to the CRF ceiling and still reports an in-band score for a picture with',
        'visible grid-aligned blocking. On "Anyone but You" a blocked frame scored 76.93',
        'at PSNR 65.8 dB. The ceiling, not this target, is what sets quality on that',
        'content, which is why it is tiered too.',
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
      label: 'If Target Quality Did Not Run (scaled only)',
      name: 'tq_unavailable_action',
      type: 'string',
      defaultValue: 'fail',
      inputUI: { type: 'dropdown', options: ['fail', 'accept'] },
      tooltip: [
        'Only consulted when a file is downscaled, because only the piped path could',
        'plausibly lose the target-quality search. If no chunk reports a measured score the',
        'encode landed at some unverified CRF: "fail" throws so Tdarr keeps the original,',
        '"accept" keeps the output with a warning.',
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
      defaultValue: '5-30',
      inputUI: { type: 'text' },
      tooltip: [
        'CRF floor-ceiling the target-quality search may use. Tier ladder in use:',
        'top 5-30, mid 10-40, low 10-50, matching the target ladder above.',
        'The CEILING is the important half, and it is deliberately tight -- an earlier',
        'default of 5-63 was wrong. On flat content SSIMULACRA2 saturates, so the search',
        'climbs to whatever ceiling it is given and reports a healthy score; at CRF 45-50',
        'that content comes back with visible grid-aligned blocking, measured 3.7x the',
        'unencoded reference at 50 against 1.4x at 33.',
        'Capping it is close to free because the chunks it catches are long, flat and',
        'byte-cheap: measured on two unrelated films (4K HDR downscaled via the hdr fork,',
        'and a grain-heavy 1080p remux on mainline), 50 -> 30 cost +0.6% total size while',
        'putting +17.5% into the affected regions. 11-15% of chunks pin at the ceiling and',
        'they are ~5% of the bytes.',
        'The ceiling is tiered rather than fixed because the metric cannot distinguish',
        'those chunks at all -- with one ceiling for every tier they would be encoded',
        'identically regardless of target, so the ceiling is the only lever the tier',
        'system has on them.',
        'The floor matters less but keep it at 5 on the top tier: demanding content',
        'reached CRF 5.25 there (job M6el8sA4t). A floor that is too high shows up as',
        'chunks pinned at the floor still missing the target, which the log warns about.',
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
      tooltip: [
        'Pass --hwdec for GPU decoding. Ignored (with a log line) on any file that gets',
        'downscaled: xav rejects --hwdec outright when its frames arrive over a pipe.',
      ].join(' '),
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
  const cp = require('child_process');

  const { createProcessManager } = require('../shared/processManager');
  const { createLogger, humanSize } = require('../shared/logger');
  const { probeNonVideoSize, mergeAudioVideo } = require('../shared/audioMerge');
  const { stageIntoWorkDir, unstage } = require('../shared/staging');
  const {
    buildXavArgs, buildPipeFfmpegArgs, filterEncoderParams, resolveParamSet, createXavTracker,
    sourceVideoDuration, validateOutput, detectCrfPinning, logTargetHit, probeOutput,
    measureVideoDuration,
    selectEncodePath, RESOLUTION_PRESETS,
    readChunkReport, logCrfSpread, createStderrCollector,
  } = require('../shared/xav');

  const inputs = args.inputs || {};
  const file = args.inputFileObj;

  const { jobLog, dbg } = createLogger(args.jobLog, args.workDir);

  const maxResolution = String(inputs.max_resolution || 'off');
  const targetQuality = String(inputs.target_quality || '74.8-75.2');
  const tqUnavailableAction = String(inputs.tq_unavailable_action || 'fail');
  const tqMode = String(inputs.tq_mode || 'mean');
  const crfRange = String(inputs.crf_range || '5-30');
  const preset = Number(inputs.preset) || 6;
  const workers = Number(inputs.workers) || 2;
  const vship = Number(inputs.vship) || 1;
  const hwdecRequested = inputs.hwdec === true || inputs.hwdec === 'true';
  const maxEncodedPercent = Number(inputs.max_encoded_percent) || 80;

  const sourceStreams = (file.ffProbeData && file.ffProbeData.streams) || [];
  const videoStream = sourceStreams.find((s) => s.codec_type === 'video') || {};
  const sourceWidth = Number(videoStream.width) || 0;
  const sourceFrames = Number(videoStream.nb_frames) || 0;
  const sourceDuration = sourceVideoDuration(
    videoStream, (file.ffProbeData && file.ffProbeData.format) || {},
  );

  // The whole reason these used to be two plugins, decided here in one line.
  const mode = selectEncodePath(sourceWidth, maxResolution);
  const scaled = mode === 'scaled';
  const targetWidth = scaled ? RESOLUTION_PRESETS[maxResolution].width : sourceWidth;

  const findBin = (...paths) => paths.filter(Boolean).find((p) => fs.existsSync(p));
  const xavBin = findBin(inputs.xav_path, '/usr/local/bin/xav', '/opt/xav/xav');
  if (!xavBin) {
    throw new Error(
      'xav binary not found. Mount it at /usr/local/bin/xav (or set the xav Binary Path input). '
      + 'The stock Tdarr image does not ship xav.',
    );
  }
  const ffmpegBin = findBin('/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg');
  if (scaled && !ffmpegBin) throw new Error('ffmpeg not found, required to downscale');

  // xav creates its `.<hash>` temp directory next to its input with no way to
  // relocate it, so the working file has to be local before it runs. This
  // applies on BOTH paths: even when frames arrive over a pipe, the source file
  // is still passed as <INPUT> for scene detection, crop detection and the frame
  // count. Staging is this plugin's job -- it is the one with the constraint.
  const staging = stageIntoWorkDir(file._id, args.workDir, jobLog);
  const inputPath = staging.path;

  const outputPath = path.join(args.workDir, 'xav-output.mkv');
  const videoOnlyPath = path.join(args.workDir, 'xav-video.mkv');

  const sourceBytes = (() => {
    try { return fs.statSync(inputPath).size; } catch (_) { return 0; }
  })();

  // hwdec is a hard error inside xav when combined with a pipe, so a file that
  // happens to need scaling must not inherit it from a global setting.
  const hwdec = hwdecRequested && !scaled;
  if (hwdecRequested && scaled) {
    jobLog('[xav] GPU Decode is on but this file is being downscaled -- xav rejects --hwdec on piped input, so it is ignored for this file.');
  }

  jobLog(`XAV ENCODE (${scaled ? 'scaled' : 'native'})`);
  jobLog(`  binary     : ${xavBin}`);
  jobLog(
    `  path       : ${mode} -- source ${sourceWidth}px, max resolution ${maxResolution}`
    + (scaled ? ` -> scaling to ${targetWidth}px` : ' -> encoding at source resolution'),
  );
  jobLog(`  target     : SSIMULACRA2 ${targetQuality} (${tqMode})  CRF ${crfRange}`);
  jobLog(`  preset     : ${preset}   workers ${workers}   metric workers ${vship}`);
  jobLog(`  source     : ${humanSize(sourceBytes)}  ${sourceWidth}x${videoStream.height}`);

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

  // ---- the one genuine fork: how xav gets its frames --------------------

  // Native. xav REQUIRES a TTY on stdin. src/y4m.rs defines is_pipe() as
  // !stdin().is_terminal(), with no flag or env override -- given no terminal it
  // assumes piped Y4M, reads nothing, writes an ~870-byte file, prints
  // DONE 100.00% and exits 0. Tdarr spawns via Node child_process with no TTY,
  // so `script` is not optional here.
  //
  // The argv is written to a launcher script rather than interpolated into
  // `script -qec "..."`, so filenames never traverse a shell-quoting layer.
  const runNative = async () => {
    const launcherPath = path.join(args.workDir, 'xav-run.sh');
    const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
    fs.writeFileSync(
      launcherPath,
      `#!/usr/bin/env bash\nexec ${shellQuote(xavBin)} ${xavArgs.map(shellQuote).join(' ')}\n`,
      { mode: 0o755 },
    );
    // Job log, not just av1-debug.log -- same reason as the scaled path: workDir
    // is gone by the time anyone needs to know what was run.
    jobLog(`[xav] xav: ${xavBin} ${xavArgs.join(' ')}`);
    dbg(`launcher: ${fs.readFileSync(launcherPath, 'utf8').trim()}`);

    return pm.spawnAsync('/usr/bin/script', ['-qec', launcherPath, '/dev/null'], {
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
  };

  // Scaled. No `script` on this path: `script` would give the child a PTY on
  // stdin, which is exactly what xav's is_pipe() tests -- it would then ignore
  // the pipe and try to decode a file that was never passed.
  //
  // Target quality does work on piped input, confirmed in xav's source rather
  // than assumed: enc_all() hands pipe_reader straight to enc_tq() with no
  // pipe-specific branch, and probes re-encode the fully-decoded in-memory chunk
  // buffer, so no random access into the source is needed. The no-score check
  // after the run remains as a guard in case that changes.
  //
  // Pipe resume is vspipe-only upstream (it appends `-s N` to the producer argv,
  // meaningless for ffmpeg), so a scaled job is not resumable and restarts from
  // zero.
  const runPiped = async () => {
    const ffmpegArgs = buildPipeFfmpegArgs({ inputPath, resolution: maxResolution });
    // The resolved argv belongs in the JOB LOG, not only in av1-debug.log.
    // av1-debug.log lives in workDir and dies with it, so by the time anyone asks
    // "what exactly did we run on that file?" the answer is gone -- which is
    // precisely the question that came up diagnosing the 4K blocking on
    // 2026-08-15. It is two lines per job.
    jobLog(`[xav] ffmpeg: ${ffmpegBin} ${ffmpegArgs.join(' ')}`);
    jobLog(`[xav] xav:    ${xavBin} ${xavArgs.join(' ')}`);

    return new Promise((resolve) => {
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

      // Both halves of the pipe need guarding, not just xav: killing only the
      // encoder leaves ffmpeg decoding into a pipe nobody reads. adopt() covers
      // cleanup on paths where we are still alive to run it; the ppid watchdog
      // covers the path where Tdarr kills the worker outright, which orphaned a
      // feature-length encode in production on 2026-08-13 (job eUZ3g_6xN).
      pm.startPpidWatcher(xav.pid);
      pm.startPpidWatcher(ff.pid);

      // xav exits as soon as it has every frame it needs and closes stdin behind
      // it, while ffmpeg usually still has a buffered write in flight. That
      // write lands on a closed pipe as EPIPE -- a normal end-of-stream race,
      // not a failure. Node turns an unhandled 'error' on a stream into an
      // uncaught exception, so without these handlers the WORKER DIES, and it
      // dies *after* a complete encode: verified 2026-08-14 on a 4K clip whose
      // xav-video.mkv held all 1090 frames when the process was killed.
      // Both ends need a handler; the error surfaces on whichever side Node
      // notices first.
      const onPipeError = (which) => (e) => {
        const code = e && e.code;
        if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
          dbg(`[pipe] ${which} closed at end of stream (${code}) -- expected`);
          return;
        }
        jobLog(`[pipe] ${which} error: ${e.message}`);
      };
      xav.stdin.on('error', onPipeError('xav stdin'));
      ff.stdout.on('error', onPipeError('ffmpeg stdout'));

      ff.stdout.pipe(xav.stdin);

      const ffErr = createStderrCollector();
      ff.stderr.on('data', (d) => ffErr.push(d.toString()));
      // ffmpeg dying leaves xav waiting on a pipe that will never deliver.
      ff.on('close', (code) => {
        // Report what the decoder said REGARDLESS of exit status. The old code
        // only logged on a non-zero exit, which is backwards: an ffmpeg that
        // complains about every frame and still exits 0 is the case worth
        // hearing about, and it is the case that actually happens -- the "Anyone
        // but You" DV source produces "PPS changed between slices", "Skipping
        // invalid undecodable NALU" and "Multiple Dolby Vision RPUs found in one
        // AU" on a clean exit (measured 2026-08-15). Production had been
        // discarding all of it.
        const { rows, distinct, dropped } = ffErr.summary();
        if (rows.length) {
          jobLog(
            `[ffmpeg] exited ${code} with ${distinct} distinct message(s)`
            + (dropped ? ` (+${dropped} beyond the cap)` : '') + ':',
          );
          for (const r of rows) jobLog(`[ffmpeg]   ${r}`);
        }
        if (code !== 0) {
          jobLog(`[ffmpeg] non-zero exit ${code} -- closing xav's stdin`);
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
      xav.on('close', (code, signal) => {
        // Once the consumer is gone ffmpeg is decoding 4K frames into nothing.
        // pm.cleanup() would get it eventually, but not before it has burned
        // however long the rest of the file takes.
        try { if (ff.exitCode === null && !ff.killed) ff.kill('SIGTERM'); } catch (_) {}
        resolve(code !== null ? code : (signal ? 1 : 0));
      });
    });
  };

  // -----------------------------------------------------------------------

  updateWorker({ status: scaled ? 'Starting xav (scaled)' : 'Starting xav' });
  tracker.startInterval();

  const exitCode = await (scaled ? runPiped() : runNative());

  tracker.stop();
  pm.cleanup();

  // Only ever removes a file this plugin created; a hardlink drops a link and
  // leaves the library alone, a copy frees the transcode cache.
  const dropStaged = () => { if (staging.staged) unstage(inputPath, dbg); };

  if (sizeExceeded) {
    jobLog('[xav] projected output exceeded the size limit -- passing the original through');
    try { fs.unlinkSync(videoOnlyPath); } catch (_) {}
    dropStaged();
    return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };
  }

  if (exitCode !== 0) {
    // Where it died, in one parsed line. The dump above is bounded (see
    // SILENT_HEAD/TAIL_LINES in shared/processManager) and its tail is raw TUI
    // redraws, which read as noise; this is the same information as a fact.
    // Job H1Hsr3m2av died with nothing on record but "Segmentation fault", and
    // "chunk 516/965" is the first thing anyone asks afterwards.
    const last = tracker.getState();
    if (last) {
      jobLog(
        `[xav] died at chunk ${last.chunksDone}/${last.chunksTotal}`
        + `  frame ${last.frames}/${last.totalFrames} (${last.percent}%)`,
      );
    } else {
      jobLog('[xav] died before it reported any progress');
    }
    // 128+N is a signal, and a segfault mid-encode says nothing about the flow
    // being misconfigured -- name it so the next reader does not go looking for
    // a plugin bug that is not there.
    const signalled = exitCode > 128 && exitCode < 160;
    throw new Error(
      `xav exited ${exitCode}${signalled ? ` (killed by signal ${exitCode - 128})` : ''}`
      + `${scaled ? ' on the scaled path' : ''} -- see the job log for its output`,
    );
  }

  // Prefer xav's own report over the TUI the tracker scrapes. The TUI pairs the
  // CRF being encoded with the PREVIOUS probe's score, so every scraped pair is
  // one probe stale and the delivered chunk's score is never shown at all
  // (measured 2026-08-15 -- see readChunkReport in shared/xav.js). The tracker
  // stays as the fallback: it is all we have on a fixed-CRF run, and it is what
  // drives the live dashboard either way.
  const report = readChunkReport(inputPath, dbg);
  const stats = report ? report.chunks : tracker.getChunkStats();
  const scores = stats.map((s) => s.score);
  const crfs = stats.map((s) => s.crf);
  if (report) {
    jobLog(
      `[xav] chunk report: ${report.chunks.length} chunks from xav's own JSON `
      + `(${report.averageProbes.toFixed(1)} probes/chunk, `
      + `${report.inRange} in range, ${report.outRange} out)`,
    );
  } else if (scores.length) {
    jobLog(
      '[xav] NOTE: no chunk report from xav -- per-chunk scores below are scraped from '
      + 'its progress display and are one probe stale. Treat them as approximate.',
    );
  }

  // A chunk that finished but never reported is a silent unknown: it landed at
  // some CRF nobody measured. The all-or-nothing check below cannot see this,
  // and on the production run that missed it 40 of 1457 chunks were unaccounted
  // for (job Zn5dE_yQq, 2026-08-15).
  const lastState = tracker.getState();
  const chunksTotal = lastState && Number(lastState.chunksTotal);
  if (scores.length && chunksTotal > 0 && scores.length < chunksTotal) {
    jobLog(
      `[xav] WARNING: only ${scores.length} of ${chunksTotal} chunks reported a score `
      + `-- ${chunksTotal - scores.length} landed at an unverified CRF.`,
    );
  }

  // Did target quality actually run? Only the piped path could plausibly lose
  // it, so only the piped path is allowed to fail the job over it.
  if (scaled && scores.length === 0) {
    const message = 'no chunk reported a measured SSIMULACRA2 score, so the target-quality '
      + `search did not run on piped input (requested ${targetQuality}). The encode landed `
      + 'at an unverified CRF and its quality is unknown.';
    if (tqUnavailableAction === 'fail') {
      throw new Error(
        `${message} Failing so Tdarr keeps the original. Set "If Target Quality Did Not Run" `
        + 'to "accept" to keep this output anyway, or raise Max Resolution so this file is '
        + 'encoded natively.',
      );
    }
    jobLog(`[xav] WARNING: ${message} Keeping it because the plugin is set to accept.`);
  }

  if (scores.length) {
    const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
    jobLog(
      `[xav] achieved SSIMULACRA2: mean ${mean.toFixed(2)}, `
      + `worst ${Math.min(...scores).toFixed(2)} across ${scores.length} chunks`,
    );
    logTargetHit(jobLog, stats, targetQuality, crfRange);
    // The score alone is not a quality verdict on flat content -- see
    // summariseCrfSpread in shared/xav.js for the measurement behind that.
    logCrfSpread(jobLog, stats);

    // A target-quality run whose chunks all landed on a CRF bound measured
    // nothing: it is a fixed-CRF encode wearing a target-quality costume. Warn
    // loudly, but the encode itself is valid so do not fail it.
    const pinning = detectCrfPinning(crfs, crfRange);
    if (pinning.pinned) {
      jobLog(
        `[xav] WARNING: all ${pinning.total} chunks pinned at the CRF ${pinning.bound} `
        + `(${pinning.value}). The target-quality search had nowhere to go, so this is `
        + 'effectively a fixed-CRF encode.'
        + (pinning.bound === 'ceiling'
          // Ceilings are deliberately tight now (see the CRF Range tooltip), so a
          // ceiling pin is only a problem if EVERY chunk hit it -- that means the
          // whole file was easier than the tier assumes, not that the cap is wrong.
          ? ' Every chunk hitting the CEILING means this file is easier than its tier '
            + 'assumes -- move it to a lower tier rather than raising the ceiling, which '
            + 'is what protects flat content from blocking.'
          : ' Lower the CRF floor or raise the target.'),
      );
    }
  }

  // xav's own MUX phase set the status to "Muxing" before exiting, so without
  // this the dashboard attributes the whole validation to muxing -- which is how
  // 42 minutes of ffprobe on Avatar looked like a stalled mux (job yf2quTpnG).
  updateWorker({ status: 'Validating output' });
  const probe = await probeOutput(videoOnlyPath, pm, dbg);
  // What we are about to validate is VIDEO-ONLY, so it has to be compared with
  // the source's VIDEO length. Container metadata does not carry that on
  // matroska -- measure it, and keep the metadata answer only as a fallback.
  const measuredDuration = await measureVideoDuration(inputPath, pm, sourceDuration, dbg);
  const compareDuration = measuredDuration || sourceDuration;
  if (measuredDuration && Math.abs(measuredDuration - sourceDuration) > 0.5) {
    jobLog(
      `[xav] source video ends at ${measuredDuration.toFixed(2)}s, `
      + `${(sourceDuration - measuredDuration).toFixed(2)}s before the container's `
      + `${sourceDuration.toFixed(2)}s -- another track outruns the picture. `
      + 'Validating against the measured video length.',
    );
  }
  // Frame count must match on both paths; the scale filter changes dimensions,
  // not count.
  const verdict = validateOutput(probe, { frames: sourceFrames, duration: compareDuration }, {});
  if (!verdict.ok) {
    throw new Error(`xav output failed validation: ${verdict.problems.join('; ')}`);
  }
  if (scaled && probe.width > targetWidth) {
    throw new Error(
      `output is ${probe.width}px wide, wider than the ${maxResolution} target `
      + `(${targetWidth}px) -- the scale filter did not apply`,
    );
  }

  updateWorker({ status: 'Merging audio' });
  const merged = await mergeAudioVideo(videoOnlyPath, inputPath, outputPath, pm, jobLog, dbg);
  if (!merged) {
    throw new Error('failed to merge audio/subtitles back into the xav output');
  }
  dropStaged();

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

module.exports = { details, plugin };
