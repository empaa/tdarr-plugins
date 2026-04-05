# Auto Grain Synthesis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically detect source noise and enable AV1 encoder-native grain synthesis with appropriate strength, saving bitrate on noisy sources.

**Architecture:** New shared module `grainSynth.js` handles noise estimation (ffmpeg signalstats) and sigma-to-param mapping. Existing flag builders in `encoderFlags.js` gain a grain parameter. Both plugins add a boolean toggle and call the estimation before encoding.

**Tech Stack:** Node.js, ffmpeg signalstats filter, AV1 film grain synthesis (SVT-AV1 `--film-grain`, aomenc `--denoise-noise-level`)

**Spec:** `docs/superpowers/specs/2026-04-05-auto-grain-synth-design.md`

---

### Task 1: Create `grainSynth.js` — noise estimation

**Files:**
- Create: `src/shared/grainSynth.js`

This module runs ffmpeg signalstats on a sample of frames from the middle of the source file and returns an estimated noise sigma.

- [ ] **Step 1: Create the noise estimation function**

```javascript
// src/shared/grainSynth.js
'use strict';

const cp = require('child_process');

// Control points for sigma -> --film-grain / --denoise-noise-level mapping.
// Linear interpolation between points. Tune these based on test encodes.
const GRAIN_CURVE = [
  { sigma: 2,  param: 4 },
  { sigma: 4,  param: 8 },
  { sigma: 6,  param: 15 },
  { sigma: 10, param: 25 },
  { sigma: 15, param: 50 },
];

const SIGMA_SKIP_THRESHOLD = 2;
const SAMPLE_FRAMES = 200;

/**
 * Interpolate sigma through the control-point curve.
 * Returns integer 0-50, or 0 if sigma is below threshold.
 */
const mapSigmaToGrainParam = (sigma) => {
  if (sigma < SIGMA_SKIP_THRESHOLD) return 0;
  if (sigma >= GRAIN_CURVE[GRAIN_CURVE.length - 1].sigma) {
    return GRAIN_CURVE[GRAIN_CURVE.length - 1].param;
  }
  for (let i = 0; i < GRAIN_CURVE.length - 1; i++) {
    const lo = GRAIN_CURVE[i];
    const hi = GRAIN_CURVE[i + 1];
    if (sigma >= lo.sigma && sigma < hi.sigma) {
      const t = (sigma - lo.sigma) / (hi.sigma - lo.sigma);
      return Math.round(lo.param + t * (hi.param - lo.param));
    }
  }
  return 0;
};

/**
 * Estimate noise sigma from the source file using ffmpeg signalstats.
 * Samples SAMPLE_FRAMES frames from the middle of the file.
 * Returns { sigma, grainParam }.
 */
const estimateNoise = (inputPath, durationSec, ffmpegBin, dbg) => {
  const seekSec = Math.max(0, (durationSec || 0) / 2 - 5);

  const args = [
    '-hide_banner',
    '-ss', String(Math.floor(seekSec)),
    '-i', inputPath,
    '-frames:v', String(SAMPLE_FRAMES),
    '-vf', 'signalstats',
    '-f', 'null', '-',
  ];

  dbg(`[grain] estimating noise: ffmpeg ${args.join(' ')}`);

  let stderr;
  try {
    const result = cp.spawnSync(ffmpegBin, args, {
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf8',
    });
    stderr = (result.stderr || '') + (result.stdout || '');
  } catch (err) {
    dbg(`[grain] ffmpeg signalstats failed: ${err.message}`);
    return { sigma: 0, grainParam: 0 };
  }

  // Parse YHUMED (luma temporal difference median) values from signalstats output.
  // Each frame produces a line like: [Parsed_signalstats_0 @ ...] YHUMED=4.00 ...
  const humedRegex = /YHUMED=(\d+(?:\.\d+)?)/g;
  const values = [];
  let match;
  while ((match = humedRegex.exec(stderr)) !== null) {
    values.push(parseFloat(match[1]));
  }

  if (values.length === 0) {
    dbg('[grain] no YHUMED values found in signalstats output');
    return { sigma: 0, grainParam: 0 };
  }

  // Use median of YHUMED values as sigma estimate (robust to scene changes)
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  const sigma = values.length % 2 === 0
    ? (values[mid - 1] + values[mid]) / 2
    : values[mid];

  const grainParam = mapSigmaToGrainParam(sigma);
  dbg(`[grain] estimated sigma=${sigma.toFixed(2)} -> film-grain=${grainParam} (from ${values.length} frames)`);

  return { sigma, grainParam };
};

module.exports = { estimateNoise, mapSigmaToGrainParam, GRAIN_CURVE, SIGMA_SKIP_THRESHOLD };
```

- [ ] **Step 2: Verify the module is syntactically valid**

Run: `node -e "require('./src/shared/grainSynth.js'); console.log('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add src/shared/grainSynth.js
git commit -m "feat(grain): add grainSynth module with noise estimation and sigma mapping"
```

---

### Task 2: Update `encoderFlags.js` — add grain params to flag builders

**Files:**
- Modify: `src/shared/encoderFlags.js:77-114`

The three flag builder functions need a new optional `grainParam` argument. When non-zero, they include grain synthesis flags; when zero, they preserve current behavior.

- [ ] **Step 1: Update `buildAomFlags` to accept grain param**

In `src/shared/encoderFlags.js`, replace the `buildAomFlags` function (lines 77-88):

```javascript
const buildAomFlags = (preset, threadsPerWorker, hdrAom, grainParam) => {
  const grainFlags = grainParam > 0
    ? `--denoise-noise-level=${grainParam}`
    : '--enable-dnl-denoising=0';
  return [
    '--end-usage=q', `--cpu-used=${preset}`, `--threads=${threadsPerWorker}`,
    '--tune=ssim', '--enable-fwd-kf=0', '--disable-kf', '--kf-max-dist=9999',
    '--enable-qm=1', '--bit-depth=10', '--lag-in-frames=48',
    '--tile-columns=0', '--tile-rows=0', '--sb-size=dynamic',
    '--deltaq-mode=0', '--aq-mode=0', '--arnr-strength=1', '--arnr-maxframes=4',
    '--enable-chroma-deltaq=1', grainFlags,
    '--disable-trellis-quant=0', '--quant-b-adapt=1',
    '--enable-keyframe-filtering=1', hdrAom,
  ].filter(Boolean).join(' ');
};
```

- [ ] **Step 2: Update `buildSvtFlags` to accept grain param**

Replace the `buildSvtFlags` function (lines 90-101):

```javascript
const buildSvtFlags = (preset, svtLp, hdrSvt, grainParam) => {
  const grainFlags = grainParam > 0
    ? [`--film-grain ${grainParam}`, '--film-grain-denoise 1']
    : [];
  return [
    '--rc 0', `--preset ${preset}`, '--tune 1', '--input-depth 10',
    '--lookahead 48', '--keyint -1', '--irefresh-type 2',
    '--enable-overlays 1', '--enable-variance-boost 1',
    '--variance-boost-strength 2', '--variance-octile 6',
    '--enable-qm 1', '--qm-min 0', '--qm-max 15',
    '--chroma-qm-min 8', '--chroma-qm-max 15',
    '--tf-strength 1', '--sharpness 1', '--tile-columns 1',
    '--scm 0', `--lp ${svtLp}`, hdrSvt,
    ...grainFlags,
  ].filter(Boolean).join(' ');
};
```

- [ ] **Step 3: Update `buildAbAv1SvtFlags` to accept grain param**

Replace the `buildAbAv1SvtFlags` function (lines 103-114):

```javascript
const buildAbAv1SvtFlags = (lp, lookahead, grainParam) => {
  const grainFlags = grainParam > 0
    ? [`--svt film-grain=${grainParam}`, '--svt film-grain-denoise=1']
    : [];
  return [
    '--svt tune=1', '--svt enable-variance-boost=1',
    '--svt variance-boost-strength=2', '--svt variance-octile=6',
    '--svt enable-qm=1', '--svt qm-min=0', '--svt qm-max=15',
    '--svt chroma-qm-min=8', '--svt chroma-qm-max=15',
    '--svt irefresh-type=2', '--svt scm=0', '--svt sharpness=1',
    '--svt tf-strength=1', '--svt tile-columns=1', '--svt enable-overlays=1',
    `--svt lookahead=${lookahead}`, '--keyint 10s', '--scd true',
    `--svt lp=${lp}`,
    ...grainFlags,
  ].join(' ');
};
```

- [ ] **Step 4: Verify the module loads**

Run: `node -e "require('./src/shared/encoderFlags.js'); console.log('OK')"`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add src/shared/encoderFlags.js
git commit -m "feat(grain): add grainParam to flag builders in encoderFlags"
```

---

### Task 3: Integrate grain synth into `av1anEncode`

**Files:**
- Modify: `src/av1anEncode/index.js`

Add the grain synthesis toggle input, call noise estimation, and pass the result through to the flag builders.

- [ ] **Step 1: Add the Grain Synthesis input to the `details()` inputs array**

Add this input after the existing `thread_overrides` input (after line 90, before `],` on line 91):

```javascript
    {
      label: 'Grain Synthesis',
      name: 'grain_synth',
      type: 'boolean',
      defaultValue: 'false',
      inputUI: { type: 'switch' },
      tooltip: 'Automatically detect noise, denoise during encoding, and synthesize matching grain at playback. Saves bitrate on noisy sources with no visual penalty.',
    },
```

- [ ] **Step 2: Add the import and input parsing**

Add the `grainSynth` import in the plugin function. After the existing require block (line 108), add:

```javascript
  const { estimateNoise } = require('../shared/grainSynth');
```

After the `threadOverridesError` parsing (after line 127), add:

```javascript
  const grainSynthEnabled = inputs.grain_synth === true || inputs.grain_synth === 'true';
```

- [ ] **Step 3: Add noise estimation call and pass grainParam to flag builders**

After the `is4kHdr` thread budget calculation (after line 172), add the noise estimation:

```javascript
  let grainParam = 0;
  if (grainSynthEnabled) {
    const durationSec = parseFloat(stream.duration || '0')
      || (file.ffProbeData && file.ffProbeData.format && parseFloat(file.ffProbeData.format.duration)) || 0;
    const result = estimateNoise(inputPath, durationSec, BIN.ffmpeg, dbg);
    grainParam = result.grainParam;
    if (grainParam > 0) {
      jobLog(`[grain] detected noise sigma=${result.sigma.toFixed(2)} -> film-grain=${grainParam}`);
    } else {
      jobLog('[grain] source is clean (sigma < 2), skipping grain synthesis');
    }
  }
```

Update the `encFlags` construction (currently line 174-176) to pass `grainParam`:

```javascript
  const encFlags = encoder === 'aom'
    ? buildAomFlags(encPreset, threadsPerWorker, hdrAom, grainParam)
    : buildSvtFlags(encPreset, svtLp, hdrSvt, grainParam);
```

- [ ] **Step 4: Add grain info to the log header**

After the existing log line for `enc flags` (line 192), add:

```javascript
  if (grainSynthEnabled) {
    jobLog(`  grain      : ${grainParam > 0 ? `enabled (film-grain=${grainParam})` : 'enabled (clean source, skipped)'}`);
  }
```

- [ ] **Step 5: Verify the module loads**

Run: `node -e "require('./src/av1anEncode/index.js'); console.log('OK')"`
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add src/av1anEncode/index.js
git commit -m "feat(grain): integrate grain synthesis into av1anEncode plugin"
```

---

### Task 4: Integrate grain synth into `abAv1Encode`

**Files:**
- Modify: `src/abAv1Encode/index.js`

Same pattern as Task 3 but for the ab-av1 plugin.

- [ ] **Step 1: Add the Grain Synthesis input to the `details()` inputs array**

Add this input after the existing `thread_overrides` input (after line 90, before `],` on line 91):

```javascript
    {
      label: 'Grain Synthesis',
      name: 'grain_synth',
      type: 'boolean',
      defaultValue: 'false',
      inputUI: { type: 'switch' },
      tooltip: 'Automatically detect noise, denoise during encoding, and synthesize matching grain at playback. Saves bitrate on noisy sources with no visual penalty.',
    },
```

- [ ] **Step 2: Add the import and input parsing**

After the existing require block (line 107), add:

```javascript
  const { estimateNoise } = require('../shared/grainSynth');
```

After the `threadOverridesError` parsing (after line 126), add:

```javascript
  const grainSynthEnabled = inputs.grain_synth === true || inputs.grain_synth === 'true';
```

Add ffmpeg binary lookup. After the `BIN_AB_AV1` line (line 128), add:

```javascript
  const BIN_FFMPEG = ['/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find((p) => fs.existsSync(p));
  if (!BIN_FFMPEG) throw new Error('Required binary not found: ffmpeg (checked /usr/local/bin, /usr/bin)');
```

- [ ] **Step 3: Add noise estimation call**

After the thread budget calculation (after line 163), add:

```javascript
  let grainParam = 0;
  if (grainSynthEnabled) {
    const durationSec = parseFloat(stream.duration || '0')
      || (file.ffProbeData && file.ffProbeData.format && parseFloat(file.ffProbeData.format.duration)) || 0;
    const result = estimateNoise(inputPath, durationSec, BIN_FFMPEG, dbg);
    grainParam = result.grainParam;
    if (grainParam > 0) {
      jobLog(`[grain] detected noise sigma=${result.sigma.toFixed(2)} -> film-grain=${grainParam}`);
    } else {
      jobLog('[grain] source is clean (sigma < 2), skipping grain synthesis');
    }
  }
```

- [ ] **Step 4: Pass grainParam to the flag builder**

Update the `svtFlags` construction (currently line 173) to pass `grainParam`:

```javascript
  const svtFlags = buildAbAv1SvtFlags(svtLp, lookahead, grainParam);
```

- [ ] **Step 5: Add grain info to the log header**

After the existing log line for `svt flags` (line 189), add:

```javascript
  if (grainSynthEnabled) {
    jobLog(`  grain      : ${grainParam > 0 ? `enabled (film-grain=${grainParam})` : 'enabled (clean source, skipped)'}`);
  }
```

- [ ] **Step 6: Verify the module loads**

Run: `node -e "require('./src/abAv1Encode/index.js'); console.log('OK')"`
Expected: `OK`

- [ ] **Step 7: Commit**

```bash
git add src/abAv1Encode/index.js
git commit -m "feat(grain): integrate grain synthesis into abAv1Encode plugin"
```

---

### Task 5: Build, deploy, and verify

**Files:**
- No new files — build and deploy steps

- [ ] **Step 1: Build the plugins**

Run: `npm run build`
Expected: Clean build with no errors. Two bundled plugins in `dist/`.

- [ ] **Step 2: Deploy to test instance**

Run: `npm run deploy`
Expected: Bundled plugins copied to `../tdarr-av1/test/tdarr_config/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/`

- [ ] **Step 3: Verify the Grain Synthesis toggle appears in Tdarr UI**

Open the Tdarr web UI, create or edit a flow using either av1anEncode or abAv1Encode. Verify:
- "Grain Synthesis" toggle appears after "Thread Overrides"
- Default is off
- Tooltip text is visible on hover

- [ ] **Step 4: Test with grain synthesis disabled (regression check)**

Run an encode with Grain Synthesis toggled OFF. Verify:
- Encode completes successfully
- No grain-related flags appear in the logged encoder command
- aomenc still shows `--enable-dnl-denoising=0`
- Output quality/size matches previous behavior

- [ ] **Step 5: Test with grain synthesis enabled on noisy content**

Run an encode with Grain Synthesis toggled ON against a source with visible grain. Verify:
- Noise estimation runs and logs sigma + film-grain value
- Encoder flags include grain parameters (`--film-grain` or `--denoise-noise-level`)
- SVT-AV1 flags include `--film-grain-denoise 1`
- Encode completes successfully
- Output file size is smaller than without grain synthesis at same VMAF target
- Playback shows natural-looking grain (not plasticky)

- [ ] **Step 6: Test with grain synthesis enabled on clean content**

Run an encode with Grain Synthesis toggled ON against a clean digital source. Verify:
- Noise estimation logs "source is clean, skipping grain synthesis"
- No grain flags added to encoder command
- Encode behaves identically to grain synthesis disabled

- [ ] **Step 7: Final commit if any loose changes remain**

No new files expected at this point — dist/ is gitignored. Only commit if there are actual changes (e.g., a tweak discovered during testing). Stage specific files by name.
