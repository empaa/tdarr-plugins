// src/shared/xav.js
//
// Shared logic for xavEncode (native/PTY) and xavPipeEncode (scale/stdin).
// Both plugins build argv, track progress and validate output through here so
// they cannot drift apart.
//
// xav's flag surface (upstream src/guide.txt):
//   -e --encoder  -w --worker  -b --buff  -p --param  -s --sc  --sc-only
//   --hwdec  -r --range  -a --audio  -t --tq  -m --mode  -f --qp  -v --vship
//   -d --display  -P --alt-param
//
// Notably absent: any resize option, and any way to relocate the temp dir --
// xav hashes the input and creates `.<hash>` NEXT TO THE INPUT FILE, always.
'use strict';

const fs = require('fs');
const path = require('path');

const RESOLUTION_PRESETS = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
};

// The no-TTY artefact is ~870 bytes: xav assumes piped Y4M, reads nothing,
// writes a header, prints DONE 100.00% and exits 0.
const EMPTY_OUTPUT_FLOOR_BYTES = 1024 * 1024;
const FRAME_TOLERANCE = 1;
const DURATION_TOLERANCE_S = 0.5;

// Size gate: xav's size curve is front-loaded (at 79% of frames the output was
// already 97% of final), so an early projection reads high. Require real
// progress AND a projection that has stopped rising before aborting.
const GATE_MIN_PERCENT = 30;
const GATE_STABLE_SAMPLES = 3;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// xav renders a full-screen TUI: alternate screen buffer, absolute cursor
// addressing, per-cell colour. Stripping CSI can glue several progress
// segments into one line, so every matcher scans globally rather than
// anchoring at ^.
const stripAnsi = (s) => String(s)
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  .replace(/\x1b[()][A-Z0-9]/g, '');

//   00:00 CROP: [####----] 7%, 1 FPS, -00:00, 1/13
//   00:00 SCD:  [######--] 31%, 912 FPS, -00:00, 912/2899
//   00:00 MUX:  [########] 100%, 2899 FPS, -00:00, 2899/2899
const PHASE_RE = /(\d+):(\d+)\s+([A-Z]{2,6}):\s*\[[#\-]*\]\s*(\d+)%,\s*([\d.]+)\s*FPS,\s*-?(\d+):(\d+),\s*(\d+)\/(\d+)/g;

//   00:03 [22/25] [#####-----] 79% 2316/2899 (12.59, -00:00, 57527k, 869.5m)
const MASTER_RE = /(\d+):(\d+)\s+\[(\d+)\/(\d+)\]\s*\[[#\-]*\]\s*(\d+)%\s+(\d+)\/(\d+)\s*\(\s*([\d.]+),\s*-?(\d+):(\d+),\s*(\d+)k,\s*([\d.]+)m\s*\)/g;

//   [0000 / F 16.25 / 68.04] [########] 100%, 544.24,  56/ 56
//   [0000 / F 27.50 /      ] [########] 100%, 141.56,  56/ 56   (score not yet known)
const WORKER_RE = /\[(\d+)\s*\/\s*([A-Za-z]+)\s+([\d.]+)\s*\/\s*([\d.]*)\s*\]\s*\[[#\-]*\]\s*(\d+)%,\s*([\d.]+),\s*(\d+)\/\s*(\d+)/g;

const firstMatch = (re, text) => {
  re.lastIndex = 0;
  return re.exec(text);
};

// Cursor addressing means consecutive TUI updates arrive with no separator, so
// after stripping CSI a single read can read
//   ...1 FPS, -00:00, 1/1300:00 CROP: [####...
// where `1/13` runs straight into the next segment's `00:00`. Matching such
// text directly yields `1/1300`. Split on segment starts first: every segment
// begins either with a HH:MM stamp (phase and master lines) or with `[NNNN /`
// (per-worker lines).
const SEGMENT_SPLIT = /(?=\d{2}:\d{2}\s)|(?=\[\d{4}\s*\/)/;

const splitSegments = (text) => text.split(SEGMENT_SPLIT).filter((s) => s.trim());

// Returns every state visible in this chunk of output, oldest first, so a
// consumer that wants only the newest can take the last one while a consumer
// tracking phase transitions still sees each of them.
const parseXavEvents = (raw) => {
  const text = stripAnsi(raw);
  if (!text.trim()) return [];

  const events = [];
  let sawDone = false;

  for (const seg of splitSegments(text)) {
    const master = firstMatch(MASTER_RE, seg);
    if (master) {
      const workers = [];
      events.push({
        type: 'encode',
        chunksDone: parseInt(master[3], 10),
        chunksTotal: parseInt(master[4], 10),
        percent: parseInt(master[5], 10),
        frames: parseInt(master[6], 10),
        totalFrames: parseInt(master[7], 10),
        fps: parseFloat(master[8]),
        etaSeconds: parseInt(master[9], 10) * 3600 + parseInt(master[10], 10) * 60,
        kbps: parseInt(master[11], 10),
        megabytes: parseFloat(master[12]),
        workers,
      });
      continue;
    }

    const phase = firstMatch(PHASE_RE, seg);
    if (phase) {
      events.push({
        type: 'phase',
        phase: phase[3],
        percent: parseInt(phase[4], 10),
        fps: parseFloat(phase[5]),
        frames: parseInt(phase[8], 10),
        totalFrames: parseInt(phase[9], 10),
      });
      continue;
    }

    const w = firstMatch(WORKER_RE, seg);
    if (w) {
      events.push({
        type: 'workers',
        workers: [{
          chunk: parseInt(w[1], 10),
          state: w[2],
          crf: parseFloat(w[3]),
          score: w[4] === '' ? null : parseFloat(w[4]),
          percent: parseInt(w[5], 10),
          fps: parseFloat(w[6]),
          frames: parseInt(w[7], 10),
          totalFrames: parseInt(w[8], 10),
        }],
      });
      continue;
    }

    if (!sawDone && /\bDONE\b/.test(seg)) { sawDone = true; events.push({ type: 'done' }); }
  }

  return events;
};

// Convenience wrapper: the newest state in this chunk, or null.
const parseXavLine = (raw) => {
  const events = parseXavEvents(raw);
  return events.length ? events[events.length - 1] : null;
};

const PHASE_STATUS = {
  CROP: 'Detecting crop',
  SCD: 'Scene detection',
  MUX: 'Muxing',
};

// ---------------------------------------------------------------------------
// Estimation and the size gate
// ---------------------------------------------------------------------------

// Projected final video bytes from bytes-so-far scaled by frame progress.
// Biased high early (see GATE_MIN_PERCENT) and converges as chunks complete.
const projectVideoBytes = (bytesSoFar, frames, totalFrames) => {
  if (!frames || !totalFrames || bytesSoFar <= 0) return 0;
  return Math.round(bytesSoFar * (totalFrames / frames));
};

// Fires only once real progress exists AND the projection has stopped rising,
// so a front-loaded size curve cannot abort a good encode.
const sizeGateDecision = (samples, opts) => {
  const { maxEncodedPercent, sourceBytes, nonVideoBytes } = opts;
  if (!(maxEncodedPercent > 0) || maxEncodedPercent >= 100) return { abort: false };
  if (!(sourceBytes > 0)) return { abort: false };
  if (samples.length < GATE_STABLE_SAMPLES) return { abort: false };

  const recent = samples.slice(-GATE_STABLE_SAMPLES);
  if (recent[recent.length - 1].percent < GATE_MIN_PERCENT) return { abort: false };

  // Stable or falling: no sample may exceed the one before it.
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].projectedBytes > recent[i - 1].projectedBytes) return { abort: false };
  }

  const projectedTotal = recent[recent.length - 1].projectedBytes + (nonVideoBytes || 0);
  const percent = (projectedTotal / sourceBytes) * 100;
  if (percent > maxEncodedPercent) {
    return { abort: true, percent, projectedTotal };
  }
  return { abort: false, percent, projectedTotal };
};

// ---------------------------------------------------------------------------
// argv construction
// ---------------------------------------------------------------------------

// xav validates encoder params itself (upstream src/svterr.rs) and ABORTS with
// "argument parsing failed" before encoding anything if it disagrees. Handing it
// an av1an param string unfiltered produces an instant, total failure -- our
// first sweep launch died on all 40 runs in 20 seconds this way.
//
// Each entry is a param xav rejects outright, with its stated reason.
const XAV_REJECTED_PARAMS = {
  '--input-depth': 'xav only ever encodes yuv420p10le; setting depth is an error',
  '--lookahead': 'svt-av1 locks lookahead internally; xav requires it be removed',
  '--keyint': 'xav sets keyint itself -- chunk starts are keyframes',
  '--irefresh-type': "on xav's NOT_RELEVANT list",
  '--enable-overlays': 'xav rejects overlays as always dangerous with svt-av1',
  '--scm': "on xav's rejected list",
  // TQ owns rate control; passing either fights the target-quality search.
  '--crf': 'target-quality owns rate control',
  '--rc': 'target-quality owns rate control',
  // xav does its own scene detection.
  '--scd': 'xav owns scene detection',
};

// Strips params xav will reject, returning the cleaned string plus what was
// dropped so the caller can log it rather than fail mysteriously.
const filterEncoderParams = (raw) => {
  const tokens = String(raw || '').trim().split(/\s+/).filter(Boolean);
  const kept = [];
  const dropped = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (Object.prototype.hasOwnProperty.call(XAV_REJECTED_PARAMS, t)) {
      const hasValue = i + 1 < tokens.length && !tokens[i + 1].startsWith('--');
      dropped.push({ param: t, value: hasValue ? tokens[i + 1] : null, reason: XAV_REJECTED_PARAMS[t] });
      if (hasValue) i++;
      continue;
    }
    kept.push(t);
  }

  return { params: kept.join(' '), dropped };
};

// The researched parameter set for MAINLINE SVT-AV1 v4.2.0, from two sweeps over
// two sources (clean digital + 35mm film). Emitted by default because without it
// the plugin sent `-p '--preset N'` and every job ran SVT stock -- measured at
// +18-22% bytes at matched quality on clean digital, and +31% at the top tier on
// grain. `--keyint`/`--scm` are omitted deliberately: xav owns both and rejects
// them (see XAV_REJECTED_PARAMS).
//
// Per-flag evidence is in docs/encoder-recommendations.md §3. The load-bearing
// ones are --tune 1 (tune 4 was the worst arm in 6 of 6 tier/source combinations,
// up to +134%), --enable-qm 1 (+4.3 to +21.5% to disable) and --qm-min 0
// (correctly signed 6 of 6, worth ~1.2% on clean digital and ~6.8% on film).
const MAINLINE_PARAMS = [
  '--tune 1',
  '--enable-variance-boost 1',
  '--enable-qm 1',
  '--qm-min 0',
  '--tf-strength 1',
  '--sharpness 1',
  '--tile-columns 1',
].join(' ');

// The hdr fork gets NO parameter string. Its defaults already encode qm 6/10,
// variance boost, tf-strength 1, sharpness 1 and ac-bias 1.0, and its author
// states only tuning mode, CRF and preset are required -- our mainline string
// fights them. Every measurement behind MAINLINE_PARAMS was taken on mainline,
// so porting it across would be applying untested values, not proven ones.
const isHdrBinary = (binPath) => /hdr/i.test(path.basename(String(binPath || '')));

// 'auto' picks by binary name, which is how the fork is deployed
// (/opt/xav/xav-hdr). The explicit modes exist because that is a filename sniff:
// if it guesses wrong the job log says which set was applied, and this input
// overrides it.
const resolveParamSet = (mode, binPath) => {
  switch (String(mode || 'auto')) {
    case 'none': return { params: '', why: 'none (preset only, by request)' };
    case 'mainline': return { params: MAINLINE_PARAMS, why: 'mainline researched set (forced)' };
    case 'hdr': return { params: '', why: 'hdr fork defaults (forced)' };
    default:
      return isHdrBinary(binPath)
        ? { params: '', why: 'hdr fork defaults -- its own defaults are the recipe' }
        : { params: MAINLINE_PARAMS, why: 'mainline researched set' };
  }
};

const buildEncoderParams = (opts) => {
  const extra = filterEncoderParams(opts.extraParams);
  const parts = [`--preset ${opts.preset}`];
  const base = resolveParamSet(opts.paramSet, opts.binPath);
  if (base.params) parts.push(base.params);
  // extra_params last so a hand-set value wins over the default set.
  if (extra.params) parts.push(extra.params);
  return parts.join(' ');
};

// No -a is ever passed: xav stays video-only and audio/subtitles are merged
// back from the staged file afterwards.
const buildXavArgs = (opts) => {
  const args = [];
  if (opts.inputPath) args.push(opts.inputPath);
  args.push(opts.outputPath);
  args.push('-e', opts.encoder || 'svt-av1');
  args.push('-w', String(opts.workers));
  // Omit -b entirely unless asked: xav's own default buffering is what the
  // bake-off measured, and -b 4 took peak RSS from ~19.8 GB past 25 GB.
  if (opts.buffer != null && opts.buffer !== '' && Number(opts.buffer) > 0) {
    args.push('-b', String(opts.buffer));
  }
  args.push('-p', buildEncoderParams(opts));
  if (opts.targetQuality) {
    args.push('-t', String(opts.targetQuality));
    args.push('-f', String(opts.crfRange));
    args.push('-v', String(opts.vship));
    if (opts.tqMode) args.push('-m', String(opts.tqMode));
  }
  if (opts.hwdec) args.push('--hwdec');
  return args;
};

const shouldDownscale = (sourceWidth, resolution) => {
  const preset = RESOLUTION_PRESETS[resolution];
  if (!preset) return false;
  return sourceWidth > preset.width;
};

const buildScaleFilter = (resolution) => {
  const preset = RESOLUTION_PRESETS[resolution];
  if (!preset) return null;
  return `scale=${preset.width}:-2:flags=lanczos`;
};

// ffmpeg side of the pipe path: decode, scale, emit Y4M on stdout.
const buildPipeFfmpegArgs = (opts) => {
  const args = ['-hide_banner', '-loglevel', 'error', '-i', opts.inputPath];
  const vf = buildScaleFilter(opts.resolution);
  if (vf) args.push('-vf', vf);
  args.push('-an', '-sn', '-dn', '-f', 'yuv4mpegpipe', '-strict', '-1', 'pipe:1');
  return args;
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Dimensions are deliberately NOT compared to the source: xav autocrops, so
// 1920x1080 legitimately becomes e.g. 1920x1040.
// What validateOutput must compare against. The output under validation is
// VIDEO-ONLY (audio and subtitles are merged back afterwards), so comparing it
// to format.duration -- the container duration, i.e. the longest stream -- fails
// a perfectly good encode whenever a subtitle or audio track outruns the video.
// Seen live: a clip whose subtitle track ran 1.22 s past the last video frame
// failed with "duration 25.11s differs from source 26.33s".
//
// Matroska usually reports no per-stream duration and carries it in the
// tags.DURATION string instead, so try: stream duration, then that tag, then the
// container as a last resort.
const parseDurationTag = (tag) => {
  const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(String(tag || '').trim());
  if (!m) return 0;
  return (Number(m[1]) * 3600) + (Number(m[2]) * 60) + Number(m[3]);
};

const sourceVideoDuration = (videoStream, format) => {
  const v = videoStream || {};
  const direct = Number(v.duration);
  if (direct > 0) return direct;
  const tagged = parseDurationTag((v.tags || {}).DURATION);
  if (tagged > 0) return tagged;
  return Number((format || {}).duration) || 0;
};

const validateOutput = (probe, source, opts) => {
  const o = opts || {};
  const floor = o.floorBytes || EMPTY_OUTPUT_FLOOR_BYTES;
  const problems = [];

  if (!probe || !probe.exists) {
    return { ok: false, problems: ['output file was not created'] };
  }
  if (probe.bytes < floor) {
    problems.push(
      probe.bytes < 4096
        ? `output is ${probe.bytes} bytes -- this is xav's no-TTY signature: without a `
          + 'terminal on stdin it assumes piped Y4M, reads nothing, writes a header and '
          + 'exits 0. The encode never ran.'
        : `output is ${probe.bytes} bytes, below the ${floor}-byte floor`,
    );
  }
  if (!(probe.width > 0) || !(probe.height > 0)) {
    problems.push(`output has non-positive dimensions (${probe.width}x${probe.height})`);
  }
  if (probe.codec && probe.codec !== 'av1') {
    problems.push(`output codec is ${probe.codec}, expected av1`);
  }
  if (source && source.frames > 0 && probe.frames > 0) {
    const delta = Math.abs(probe.frames - source.frames);
    if (delta > (o.frameTolerance != null ? o.frameTolerance : FRAME_TOLERANCE)) {
      problems.push(`frame count ${probe.frames} differs from source ${source.frames} by ${delta}`);
    }
  }
  if (source && source.duration > 0 && probe.duration > 0) {
    const delta = Math.abs(probe.duration - source.duration);
    if (delta > (o.durationTolerance != null ? o.durationTolerance : DURATION_TOLERANCE_S)) {
      problems.push(
        `duration ${probe.duration.toFixed(2)}s differs from source `
        + `${source.duration.toFixed(2)}s by ${delta.toFixed(2)}s`,
      );
    }
  }

  return { ok: problems.length === 0, problems };
};

// A target-quality run whose chunks all landed on a -f bound measured nothing:
// it is a fixed-CRF encode wearing a target-quality costume. Warn, do not fail.
const detectCrfPinning = (chunkCrfs, crfRange) => {
  if (!chunkCrfs || chunkCrfs.length === 0) return { pinned: false };
  const [lo, hi] = String(crfRange).split('-').map(parseFloat);
  if (!isFinite(lo) || !isFinite(hi)) return { pinned: false };

  const atFloor = chunkCrfs.filter((c) => Math.abs(c - lo) < 0.01).length;
  const atCeiling = chunkCrfs.filter((c) => Math.abs(c - hi) < 0.01).length;
  if (atFloor === chunkCrfs.length) {
    return { pinned: true, bound: 'floor', value: lo, count: atFloor, total: chunkCrfs.length };
  }
  if (atCeiling === chunkCrfs.length) {
    return { pinned: true, bound: 'ceiling', value: hi, count: atCeiling, total: chunkCrfs.length };
  }
  return { pinned: false, atFloor, atCeiling, total: chunkCrfs.length };
};

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 5000;
const LOG_INTERVAL_MS = 10 * 60 * 1000;

const formatEta = (seconds) => {
  if (!(seconds > 0)) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

const createXavTracker = (opts) => {
  const {
    updateWorker, jobLog, dbg, onSizeExceeded,
    sourceBytes, nonVideoBytes, maxEncodedPercent,
  } = opts;

  let interval = null;
  let phase = '';
  let smoothedFps = 0;
  let state = null;
  let lastProgressLogMs = 0;
  let aborted = false;
  const samples = [];
  const chunkCrfs = new Map();
  const chunkScores = new Map();

  const push = (fields) => { try { updateWorker(fields); } catch (_) {} };

  const onLine = (raw) => {
    for (const ev of parseXavEvents(raw)) applyEvent(ev);
  };

  const applyEvent = (ev) => {
    if (ev.type === 'phase') {
      if (ev.phase !== phase) {
        phase = ev.phase;
        const status = PHASE_STATUS[ev.phase] || ev.phase;
        push({ status });
        dbg(`[xav] phase -> ${ev.phase}`);
      }
      if (ev.phase === 'MUX') push({ percentage: 99 });
      return;
    }

    if (ev.type === 'workers' || ev.type === 'encode') {
      for (const w of ev.workers || []) {
        if (isFinite(w.crf)) chunkCrfs.set(w.chunk, w.crf);
        if (w.score != null) chunkScores.set(w.chunk, w.score);
      }
    }

    if (ev.type !== 'encode') return;

    if (phase !== 'ENC') {
      phase = 'ENC';
      push({ status: 'Encoding' });
    }
    state = ev;
    if (ev.fps > 0) {
      smoothedFps = smoothedFps === 0 ? ev.fps : smoothedFps * 0.7 + ev.fps * 0.3;
    }
  };

  const tick = () => {
    if (aborted) return;
    if (process.connected === false) {
      dbg('[xav] IPC disconnected -- job cancelled');
      return;
    }
    if (!state) return;

    const bytesSoFar = Math.round(state.megabytes * 1024 * 1024);
    const projectedVideo = projectVideoBytes(bytesSoFar, state.frames, state.totalFrames);
    samples.push({ percent: state.percent, projectedBytes: projectedVideo });

    const decision = sizeGateDecision(samples, {
      maxEncodedPercent, sourceBytes, nonVideoBytes,
    });
    if (decision.abort) {
      aborted = true;
      jobLog(
        `[xav] ABORT: projected output ${decision.percent.toFixed(1)}% of source `
        + `exceeds the ${maxEncodedPercent}% limit -- killing encode`,
      );
      onSizeExceeded();
      return;
    }

    const remaining = Math.max(0, state.totalFrames - state.frames);
    const etaS = smoothedFps > 0 ? Math.round(remaining / smoothedFps) : state.etaSeconds;
    const actualGb = bytesSoFar / (1024 ** 3);
    const estFinalGb = (projectedVideo + (nonVideoBytes || 0)) / (1024 ** 3);

    push({
      percentage: Math.min(99, state.percent),
      fps: Math.round(smoothedFps * 10) / 10,
      ETA: formatEta(etaS),
      outputFileSizeInGbytes: actualGb,
      estimatedFinalFileSizeInGbytes: estFinalGb,
      estimatedFinalSize: estFinalGb,
      estSize: estFinalGb,
    });

    const now = Date.now();
    if (now - lastProgressLogMs >= LOG_INTERVAL_MS) {
      lastProgressLogMs = now;
      jobLog(
        `[xav] ${state.percent}%  ${state.chunksDone}/${state.chunksTotal} chunks`
        + `  ${smoothedFps.toFixed(1)} fps`
        + (etaS > 0 ? `  ETA ${formatEta(etaS)}` : '')
        + `  est ${estFinalGb.toFixed(2)} GB`,
      );
    }
  };

  return {
    onLine,
    startInterval: () => { interval = setInterval(tick, POLL_INTERVAL_MS); },
    stop: () => { if (interval) { clearInterval(interval); interval = null; } },
    wasAborted: () => aborted,
    getChunkCrfs: () => Array.from(chunkCrfs.values()),
    getChunkScores: () => Array.from(chunkScores.values()),
    getState: () => state,
  };
};

module.exports = {
  RESOLUTION_PRESETS,
  EMPTY_OUTPUT_FLOOR_BYTES,
  GATE_MIN_PERCENT,
  GATE_STABLE_SAMPLES,
  stripAnsi,
  parseXavEvents,
  parseXavLine,
  projectVideoBytes,
  sizeGateDecision,
  XAV_REJECTED_PARAMS,
  MAINLINE_PARAMS,
  isHdrBinary,
  resolveParamSet,
  filterEncoderParams,
  buildEncoderParams,
  buildXavArgs,
  shouldDownscale,
  buildScaleFilter,
  buildPipeFfmpegArgs,
  validateOutput,
  sourceVideoDuration,
  detectCrfPinning,
  createXavTracker,
  formatEta,
};
