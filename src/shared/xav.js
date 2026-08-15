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
// Max spread across the recent samples for the projection to count as settled.
const GATE_STABLE_TOLERANCE = 0.05;

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
//
// The ETA and size fields are DELIBERATELY loose. On 2026-08-13 a feature-length
// encode (Avatar, 2649 chunks) parsed at chunk 4 and never again, while the
// encode ran on to 355 -- so the dashboard froze for the whole job. Every clip
// we had ever tested was ~2 minutes, under 1000 chunks, under an hour of ETA and
// under 1000m of projected size, so nothing exercised the wider forms.
//   - ETA accepts H:MM (measured: `-00:28` at 28 minutes remaining) and H:MM:SS.
//   - size accepts k/m/g, normalised to megabytes below.
// Being permissive here costs nothing; being strict cost a whole job's progress.
const MASTER_RE = /(\d+):(\d+)\s+\[(\d+)\/(\d+)\]\s*\[[#\-]*\]\s*(\d+)%\s+(\d+)\/(\d+)\s*\(\s*([\d.]+),\s*-?(?:(\d+):)?(\d+):(\d+),\s*(\d+)k,\s*([\d.]+)([kmg])\s*\)/gi;

// Normalise xav's size field to megabytes regardless of the unit it chose.
const SIZE_UNIT_SCALE = { k: 0.001, m: 1, g: 1000 };

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
// The worker-line alternative requires a SPACE after the 4-digit chunk id.
// Without it, `[1234/2649]` -- a MASTER line once chunks-done reaches four
// digits -- looks like a worker line, so the split lands mid-master-line and
// strips the leading timestamp MASTER_RE needs. Every test source had under
// 1000 chunks and never reached it; a feature film has 2649.
const SEGMENT_SPLIT = /(?=\d{2}:\d{2}\s)|(?=\[\d{4}\s+\/)/;

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
      // Two-field ETA is H:MM (measured against a known frames/fps remainder);
      // three-field is H:MM:SS.
      const etaSeconds = master[9] !== undefined
        ? parseInt(master[9], 10) * 3600 + parseInt(master[10], 10) * 60 + parseInt(master[11], 10)
        : parseInt(master[10], 10) * 3600 + parseInt(master[11], 10) * 60;
      events.push({
        type: 'encode',
        chunksDone: parseInt(master[3], 10),
        chunksTotal: parseInt(master[4], 10),
        percent: parseInt(master[5], 10),
        frames: parseInt(master[6], 10),
        totalFrames: parseInt(master[7], 10),
        fps: parseFloat(master[8]),
        etaSeconds,
        kbps: parseInt(master[12], 10),
        megabytes: parseFloat(master[13]) * (SIZE_UNIT_SCALE[master[14].toLowerCase()] || 1),
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

// The `m` field of xav's master line is ALREADY a whole-file projection --
// kbps x TOTAL duration -- not bytes written so far. Two proofs, both from our
// own captured fixture (test/fixtures/xav-tui-sample.log):
//
//   63%  1838/2899  57605k  870.6m
//   66%  1920/2899  57515k  869.3m     <-- fell while progress rose
//  100%  2899/2899  59239k  895.3m
//
// It reads 97% of its final value at 63% progress (bytes-so-far would read
// ~63%), and it DECREASES between ticks as the running average bitrate falls.
// Bytes on disk can do neither.
//
// It is also base-10 MB: 57527 kbps x (2899/23.976)s / 8 = 869.5e6 bytes, and
// that line reads "869.5m". The old code multiplied by 1024^2, overstating a
// further 4.86%.
//
// The previous implementation scaled this by totalFrames/frames on top, so the
// estimate was inflated by exactly 1/progress -- 100x at 1%, 3.3x at 30%, which
// is precisely where the size gate first becomes eligible. At the shipped 80%
// default that aborted any encode heading for more than ~24% of source, i.e.
// nearly all of them. It went unnoticed because every test run used pct=100,
// which disables the gate outright.
const MEGABYTE = 1e6;
const projectedVideoBytes = (megabytes) => {
  if (!(megabytes > 0)) return 0;
  return Math.round(megabytes * MEGABYTE);
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

  // Require CONVERGENCE, not merely decline. The old guard accepted any
  // non-increasing run -- which a 1/progress decay satisfies from its first
  // three samples while still being several times too high, so it licensed
  // exactly the false aborts it was meant to prevent. Spread-within-tolerance
  // rejects a curve that is still moving in either direction, and accepts the
  // small two-way wobble of a converged running average.
  const values = recent.map((s) => s.projectedBytes);
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!(min > 0)) return { abort: false };
  if (max / min > 1 + GATE_STABLE_TOLERANCE) return { abort: false };

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

// Which of the two ways of feeding xav this source needs.
//
// 'native' decodes the file directly under a PTY and is the faster, resumable,
// hwdec-capable path. 'scaled' puts ffmpeg in front to downscale, because xav
// has no resize of its own, and pays for it: no hwdec, no resume.
//
// This is the whole reason the two used to be separate plugins. It is one
// comparison against a width that ffProbeData already carries, so it never
// needed to be a flow-authoring decision.
const selectEncodePath = (sourceWidth, maxResolution) => {
  const preset = RESOLUTION_PRESETS[maxResolution];
  // 'off', '', undefined, or anything unrecognised means "never scale". An
  // unknown value must not silently scale to some default resolution.
  if (!preset) return 'native';
  return shouldDownscale(sourceWidth, maxResolution) ? 'scaled' : 'native';
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
//
// That chain is best-effort and CANNOT be trusted on its own -- see
// measureVideoDuration below for why, and prefer a measurement where one is
// available.
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

// How far back from the container's end to look for the last video packet.
// Generous enough for the trailing audio/subtitle overhang seen in the wild
// (3.5 s on the Harry Potter remuxes) without scanning the whole file: on a
// 25 GiB source this reads a couple of hundred MB, against a 1.5 h encode.
const VIDEO_TAIL_WINDOW_S = 120;

// Last end time across a run of `pts_time,dts_time,duration_time` packet lines.
//
// Two things this must survive, both observed on real files:
//   - VC-1 in matroska emits NO pts at all ("N/A,9655.104000,0.041000"), so a
//     parser that reads pts and gives up returns nothing for that whole class.
//   - With B-frames the last packet in decode order is not the last one
//     displayed, so take the maximum rather than the final line.
const videoTailEndTime = (lines) => {
  let end = 0;
  (lines || []).forEach((line) => {
    const [pts, dts, dur] = String(line).split(',').map((v) => parseFloat(v));
    const at = isFinite(pts) ? pts : dts;
    if (!isFinite(at)) return;
    const stop = at + (isFinite(dur) ? dur : 0);
    if (stop > end) end = stop;
  });
  return end;
};

// The video track's real length, measured rather than read off the container.
//
// Matroska stores ONE duration for the whole segment, and ffprobe reports that
// number as every stream's `duration`. So on "Harry Potter and the Chamber of
// Secrets" -- a VC-1 remux with no statistics tags and a DTS-X track running
// 3.543 s past the picture -- all 55 streams report the identical 9658.688,
// including the video. sourceVideoDuration's whole chain returns the audio's
// length, and a flawless video-only encode measuring 9655.145 gets thrown away
// (job YlW6hqiBU, 2026-08-15: 1834 chunks, mean 75.93, 1h22m of GPU time).
//
// There is no metadata field that answers this, so seek near the end and read
// where the video actually stops. Never throws and never guesses: a 0 return
// means "no answer", and the caller keeps its metadata value. Validation
// failing open is right here -- the other checks (bytes, codec, dimensions,
// frame count) still run, and no encode should die because ffprobe hiccuped.
const measureVideoDuration = async (inputPath, pm, containerDuration, dbg) => {
  const total = Number(containerDuration) || 0;
  if (!(total > 0) || !pm || typeof pm.spawnAsync !== 'function') return 0;

  const ffprobeBin = ['/usr/local/bin/ffprobe', '/usr/bin/ffprobe']
    .find((p) => fs.existsSync(p)) || 'ffprobe';
  const start = Math.max(0, total - VIDEO_TAIL_WINDOW_S);
  const lines = [];
  try {
    await pm.spawnAsync(ffprobeBin, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time,dts_time,duration_time',
      '-of', 'csv=p=0',
      // Seek to the window rather than reading the file: the interval runs past
      // the container end on purpose so nothing is clipped by rounding.
      '-read_intervals', `${start.toFixed(3)}%+${VIDEO_TAIL_WINDOW_S + 60}`,
      inputPath,
    ], { silent: true, onLine: (l) => lines.push(l) });
  } catch (err) {
    if (typeof dbg === 'function') dbg(`video tail probe failed: ${err.message}`);
    return 0;
  }

  const end = videoTailEndTime(lines);
  if (typeof dbg === 'function') {
    dbg(`video tail: ${lines.length} packets from ${start.toFixed(3)}s -> end ${end.toFixed(3)}s`);
  }
  return end;
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

// Why a run missed its target band. `mean` is not enough to act on: a uniform
// offset (the band is unreachable, widen it), a few chunks stuck at the CRF
// floor (unencodable content, nothing to tune), and a genuinely scattered search
// all produce the same mean and call for different responses.
//
// Note detectCrfPinning only fires when EVERY chunk pins, so individual chunks
// sitting at the floor and scoring far below target are otherwise invisible.
const summariseTargetHit = (stats, targetQuality, crfRange) => {
  if (!stats || !stats.length) return null;
  const [lo, hi] = String(targetQuality).split('-').map(Number);
  if (!(lo > 0)) return null;
  const [crfLo] = String(crfRange).split('-').map(Number);

  const below = stats.filter((s) => s.score < lo);
  const above = stats.filter((s) => s.score > (hi || lo));
  const inBand = stats.length - below.length - above.length;
  const atFloor = stats.filter((s) => Math.abs(s.crf - crfLo) < 0.01);
  // Chunks that are both at the CRF floor AND still short of the target had
  // nowhere left to go -- no parameter change reaches them.
  const starved = atFloor.filter((s) => s.score < lo);

  // Sort here rather than trusting the caller -- worst-first is part of this
  // function's contract, not an accident of how the tracker happens to store it.
  const worst = stats.slice().sort((a, b) => a.score - b.score).slice(0, 3);

  return { total: stats.length, inBand, below: below.length, above: above.length,
    atFloor: atFloor.length, starved, worst };
};

// Renders summariseTargetHit for the job log. Shared so both plugins report the
// same diagnosis in the same words.
const logTargetHit = (jobLog, stats, targetQuality, crfRange) => {
  const t = summariseTargetHit(stats, targetQuality, crfRange);
  if (!t) return;
  jobLog(
    `[xav] target ${targetQuality}: ${t.inBand}/${t.total} chunks in band, `
    + `${t.below} below, ${t.above} above; ${t.atFloor} at the CRF floor`,
  );
  if (t.starved.length) {
    jobLog(
      `[xav] WARNING: ${t.starved.length} chunk(s) sat at the CRF floor and still `
      + 'missed the target -- the target is unreachable on that content, so no '
      + 'parameter change will fix it. These drag the mean down on their own.',
    );
  }
  if (t.inBand < t.total) {
    jobLog(`[xav] worst chunks: ${t.worst.map(
      (w) => `#${w.chunk} crf ${w.crf.toFixed(2)} -> ${w.score.toFixed(2)}`).join(', ')}`);
  }
};

// ---------------------------------------------------------------------------
// Authoritative chunk report
// ---------------------------------------------------------------------------

// xav's TUI is NOT a reliable source of (crf, score) pairs, and the tracker that
// scrapes it has been reporting mismatched ones all along.
//
// Measured 2026-08-15 on a 22 s 4K clip, TUI against xav's own JSON:
//   JSON chunk 0 probes : 27.50->77.638, 32.00->75.468, 32.75->74.974, 39.00->70.773
//   TUI, in time order  : [27.50 / -----] [39.00 / 77.64] [32.00 / 70.77] [32.75 / 75.47]
// The worker line shows the CRF being encoded NOW beside the score of the probe
// that just finished, so every pair is one probe stale -- and the FINAL probe's
// score, the only one that describes the delivered encode, is never displayed at
// all (chunk 0 ended at crf 32.75 score 74.974; the TUI's last word was 75.47,
// which belongs to crf 32.00). So `achieved SSIMULACRA2` and the whole
// in-band/below/above breakdown have been computed on stale numbers.
//
// xav writes the truth instead: enc.rs:2008 `write_tq_log` renders
// <input>.json, holding each chunk's final crf/score/kbs plus its full probe
// history. Since <input> is the staged file in workDir, the report lands in
// workDir and is readable for as long as the job owns it. Only written when the
// TQ search actually ran (it is gated on the vship feature and a non-empty
// chunks.json), so absence is normal on a fixed-CRF encode and must not fail.
const chunkReportPath = (inputPath) => {
  const dir = path.dirname(String(inputPath));
  const base = path.basename(String(inputPath));
  const stem = base.replace(/\.[^.]*$/, '');
  return path.join(dir, `${stem}.json`);
};

const parseChunkReport = (text) => {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (_) {
    return null;
  }
  const raw = Array.isArray(doc && doc.chunks_ssimulacra2) ? doc.chunks_ssimulacra2 : null;
  if (!raw) return null;

  const chunks = [];
  for (const c of raw) {
    const fin = c && c.final;
    if (!fin || !isFinite(Number(fin.crf)) || !isFinite(Number(fin.score))) continue;
    chunks.push({
      chunk: Number(c.id),
      crf: Number(fin.crf),
      score: Number(fin.score),
      kbs: Number(fin.kbs) || 0,
      probes: Array.isArray(c.probes) ? c.probes.length : 0,
    });
  }
  if (!chunks.length) return null;

  chunks.sort((a, b) => a.score - b.score);
  return {
    chunks,
    inRange: Number(doc.in_range) || 0,
    outRange: Number(doc.out_range) || 0,
    averageProbes: Number(doc.average_probes) || 0,
  };
};

const readChunkReport = (inputPath, dbg) => {
  const p = chunkReportPath(inputPath);
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (_) {
    if (dbg) dbg(`[xav] no chunk report at ${p} -- falling back to TUI-scraped stats`);
    return null;
  }
  const parsed = parseChunkReport(text);
  if (!parsed && dbg) dbg(`[xav] chunk report at ${p} did not parse`);
  if (parsed) parsed.path = p;
  return parsed;
};

// A high CRF on flat content is the risk this plugin could not previously see.
//
// Measured 2026-08-15, "Anyone but You" 4K HDR intro: a near-featureless pale
// sky pan encoded at crf 32.75 came back at PSNR 65.8 dB / mean |err| 0.25 of
// 1023, and SSIMULACRA2 called it 74.97 -- in band, no warning, nothing wrong by
// any number the plugin had. It was still visibly broken: the frame carried only
// 33 distinct luma codes and the encoder had snapped the gradient's contours onto
// transform-block boundaries, giving grid-aligned edge energy 21-95x baseline.
// SSIMULACRA2 barely moves on that content -- 11.5 CRF steps cost 6.9 points,
// about a third of its usual slope -- so the search runs CRF roughly twice as
// high as it should and reports a healthy score for a blocky picture.
//
// The score therefore cannot be the only thing reported. The CRF spread can at
// least show a human WHERE to look, so log it and name the highest-CRF chunks.
const summariseCrfSpread = (stats, topN = 5) => {
  if (!stats || !stats.length) return null;
  const crfs = stats.map((s) => s.crf).filter((v) => isFinite(v)).sort((a, b) => a - b);
  if (!crfs.length) return null;
  const at = (q) => crfs[Math.min(crfs.length - 1, Math.floor(q * (crfs.length - 1)))];
  const highest = stats.slice()
    .sort((a, b) => b.crf - a.crf)
    .slice(0, topN);
  return { min: crfs[0], p50: at(0.5), p90: at(0.9), max: crfs[crfs.length - 1], highest };
};

const logCrfSpread = (jobLog, stats) => {
  const s = summariseCrfSpread(stats);
  if (!s) return;
  jobLog(
    `[xav] CRF spread: min ${s.min.toFixed(2)}, median ${s.p50.toFixed(2)}, `
    + `p90 ${s.p90.toFixed(2)}, max ${s.max.toFixed(2)}`,
  );
  jobLog(`[xav] highest-CRF chunks: ${s.highest.map(
    (w) => `#${w.chunk} crf ${w.crf.toFixed(2)} -> ${w.score.toFixed(2)}`).join(', ')}`);
  jobLog(
    '[xav] note: a high CRF on flat, low-detail content (skies, fades, gradients) can '
    + 'block visibly while still scoring in band -- SSIMULACRA2 is weakly sensitive to '
    + 'grid-aligned banding. Check those chunks by eye before trusting the score alone.',
  );
};

// ffmpeg on the scaled path used to have its stderr thrown away unless it exited
// non-zero, which is exactly backwards: a decoder that complains for 170k frames
// and still exits 0 is the interesting case. Verified 2026-08-15 -- the "Anyone
// but You" DV source makes ffmpeg emit "PPS changed between slices", "Skipping
// invalid undecodable NALU" and "Multiple Dolby Vision RPUs found in one AU" and
// exit 0, so production learned nothing about any of it.
//
// Logging it raw is not an option either: those messages are per-frame, so a
// feature-length job would bury the log. Collapse to unique message + count,
// which is bounded and strictly more informative than the raw stream.
// Drop the instance address so the same complaint from two decoder instances
// collapses into one entry: "[hevc @ 0x55f1c0] foo" -> "[hevc] foo".
const normaliseFfmpegLine = (line) => String(line).trim()
  .replace(/\[(\w+) @ 0x[0-9a-f]+\]/gi, '[$1]');

// Counts as it goes rather than buffering. A 2-hour DV source emits a per-frame
// complaint, so the raw stream is ~170k lines -- holding that to summarise it at
// the end would be several MB of a worker's heap for no gain, and capping the
// buffer instead would silently undercount.
const createStderrCollector = (maxDistinct = 200) => {
  const counts = new Map();
  let partial = '';
  let dropped = 0;

  const take = (line) => {
    const key = normaliseFfmpegLine(line);
    if (!key) return;
    if (counts.has(key)) { counts.set(key, counts.get(key) + 1); return; }
    // A pathological stream of never-repeating messages must not grow forever.
    if (counts.size >= maxDistinct) { dropped++; return; }
    counts.set(key, 1);
  };

  return {
    push: (chunk) => {
      const parts = (partial + String(chunk)).split('\n');
      partial = parts.pop();
      for (const p of parts) take(p);
    },
    summary: (maxLines = 8) => {
      if (partial) { take(partial); partial = ''; }
      const rows = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxLines)
        .map(([msg, n]) => (n > 1 ? `${msg}  (x${n})` : msg));
      return { rows, distinct: counts.size, dropped };
    },
  };
};

// Thin wrapper over the collector, for callers that already hold the whole text.
const summariseFfmpegStderr = (text, maxLines = 8) => {
  const c = createStderrCollector();
  c.push(String(text || ''));
  return c.summary(maxLines).rows;
};

// Bytes xav has actually written so far, by measuring its chunk directory.
//
// Tdarr's outputFileSizeInGbytes is the ACTUAL current size, and xav's master
// line carries no bytes-written figure -- its `m` field is a whole-file
// projection. ee1bcc2 correctly stopped feeding the projection into that field
// (it made the dashboard count backwards) but left nothing in its place, so the
// field has read 0 ever since. xav does not report this number, but it does
// leave it on disk: one .obu per completed chunk under <workDir>/.<hash>/encode.
//
// Best-effort by design: the directory name is a hash we do not control, and an
// encode that has not produced a chunk yet legitimately has nothing to measure.
// Returning 0 (rather than throwing) leaves the field simply unreported.
const encodedBytesOnDisk = (workDir) => {
  if (!workDir) return 0;
  try {
    const dot = fs.readdirSync(workDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('.'))
      .map((e) => path.join(workDir, e.name, 'encode'))
      .find((p) => fs.existsSync(p));
    if (!dot) return 0;
    let total = 0;
    for (const f of fs.readdirSync(dot)) {
      try { total += fs.statSync(path.join(dot, f)).size; } catch (_) { /* mid-write */ }
    }
    return total;
  } catch (_) {
    return 0;
  }
};

const createXavTracker = (opts) => {
  const {
    updateWorker, jobLog, dbg, onSizeExceeded,
    sourceBytes, nonVideoBytes, maxEncodedPercent, workDir,
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

  // Output is arriving but nothing parses out of it: the exact failure that
  // froze the Avatar dashboard for a whole job while xav encoded 355 chunks.
  // We could not reproduce it afterwards because no test source is long enough,
  // so capture a sample of the unparsed text at the time instead of guessing at
  // the format later. Logged once, to av1-debug.log only.
  let sawEncodeEvent = false;
  let unparsedSince = 0;
  let unparsedLogged = false;
  const UNPARSED_GRACE_MS = 120000;

  const onLine = (raw) => {
    const evs = parseXavEvents(raw);
    for (const ev of evs) applyEvent(ev);

    if (evs.some((e) => e.type === 'encode')) {
      sawEncodeEvent = true;
      unparsedSince = 0;
      return;
    }
    // Only meaningful once encoding has actually started: CROP and SCD legitimately
    // produce no encode events for minutes at a time.
    if (!sawEncodeEvent || unparsedLogged || phase !== 'ENC') return;
    const now = Date.now();
    if (!unparsedSince) { unparsedSince = now; return; }
    if (now - unparsedSince < UNPARSED_GRACE_MS) return;
    unparsedLogged = true;
    const sample = stripAnsi(String(raw)).replace(/\s+/g, ' ').trim().slice(0, 400);
    jobLog('[xav] WARNING: progress output has not parsed for 2 minutes -- the dashboard '
      + 'is frozen but the encode is still running. Sample logged to av1-debug.log.');
    dbg(`[xav] UNPARSED progress sample: ${sample}`);
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

    const projectedVideo = projectedVideoBytes(state.megabytes);
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
    const estFinalGb = (projectedVideo + (nonVideoBytes || 0)) / (1024 ** 3);

    const fields = {
      percentage: Math.min(99, state.percent),
      fps: Math.round(smoothedFps * 10) / 10,
      ETA: formatEta(etaS),
      estimatedFinalFileSizeInGbytes: estFinalGb,
      estimatedFinalSize: estFinalGb,
      estSize: estFinalGb,
    };
    // Only report a current size once there is one. Sending 0 is what made the
    // field look permanently broken; omitting it lets Tdarr keep the last value.
    const writtenBytes = encodedBytesOnDisk(workDir);
    if (writtenBytes > 0) fields.outputFileSizeInGbytes = writtenBytes / (1024 ** 3);
    push(fields);

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
    // Per-chunk (crf, score) pairs. The mean alone hides why a run misses its
    // target: a uniform offset and a handful of chunks stuck at the CRF floor
    // look identical in the mean, and need opposite responses.
    getChunkStats: () => Array.from(chunkScores.keys())
      .filter((c) => chunkCrfs.has(c))
      .map((c) => ({ chunk: c, crf: chunkCrfs.get(c), score: chunkScores.get(c) }))
      .sort((a, b) => a.score - b.score),
    getState: () => state,
  };
};

// ffprobe the encoded video so validation has real numbers rather than trust.
//
// -count_packets, NOT -count_frames. Both yield one count per coded frame for
// AV1 in Matroska, but -count_frames DECODES the whole file to get there: on
// Avatar (16.8 GB, 283893 frames) it took 42m42s, about 40% of the entire job,
// while the dashboard still read "Muxing". Counting packets is a demux and costs
// seconds. Measured 2026-08-14, job yf2quTpnG.
const probeOutput = async (outputPath, pm, dbg) => {
  if (!fs.existsSync(outputPath)) return { exists: false };

  const ffprobeBin = ['/usr/local/bin/ffprobe', '/usr/bin/ffprobe']
    .find((p) => fs.existsSync(p)) || 'ffprobe';
  const bytes = fs.statSync(outputPath).size;
  const out = [];
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
  if (typeof dbg === 'function') dbg(`probe: ${JSON.stringify(probe)}`);
  return probe;
};

module.exports = {
  RESOLUTION_PRESETS,
  EMPTY_OUTPUT_FLOOR_BYTES,
  GATE_MIN_PERCENT,
  GATE_STABLE_SAMPLES,
  GATE_STABLE_TOLERANCE,
  stripAnsi,
  parseXavEvents,
  parseXavLine,
  projectedVideoBytes,
  sizeGateDecision,
  XAV_REJECTED_PARAMS,
  MAINLINE_PARAMS,
  isHdrBinary,
  resolveParamSet,
  filterEncoderParams,
  buildEncoderParams,
  buildXavArgs,
  shouldDownscale,
  selectEncodePath,
  buildScaleFilter,
  buildPipeFfmpegArgs,
  probeOutput,
  validateOutput,
  sourceVideoDuration,
  videoTailEndTime,
  measureVideoDuration,
  detectCrfPinning,
  summariseTargetHit,
  logTargetHit,
  chunkReportPath,
  parseChunkReport,
  readChunkReport,
  summariseCrfSpread,
  logCrfSpread,
  normaliseFfmpegLine,
  createStderrCollector,
  summariseFfmpegStderr,
  createXavTracker,
  formatEta,
};
