# Grain Synth VapourSynth Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ffmpeg signalstats noise estimation in `grainSynth.js` with VapourSynth temporal frame differencing, and update both plugins to use the new interface.

**Architecture:** Generate a `.vpy` script at runtime that samples 4 regions of 50 frames across the source, computes per-frame luma temporal difference via `std.PlaneStats`, prints sigma values to stderr. Node.js parses the output and maps sigma to grain parameter via the existing curve.

**Tech Stack:** VapourSynth (lsmas, std built-ins), vspipe, Node.js `child_process.spawnSync`

**Spec:** `docs/superpowers/specs/2026-04-05-auto-grain-synth-design.md`

---

### Task 1: Rewrite `estimateNoise` in `grainSynth.js`

**Files:**
- Modify: `src/shared/grainSynth.js`

This is the core change. Replace the ffmpeg-based `estimateNoise` with a VapourSynth-based implementation.

- [ ] **Step 1: Update the function signature and constants**

Replace the entire `estimateNoise` function and update the module header. The new function takes `vspipeBin` and `lwiCache` instead of `ffmpegBin`, plus `totalFrames` for sample position calculation.

In `src/shared/grainSynth.js`, replace the `SAMPLE_FRAMES` constant and the entire `estimateNoise` function (lines 19–104) with:

```js
const SAMPLE_REGIONS = 4;
const FRAMES_PER_REGION = 50;

/**
 * Build a VapourSynth script that estimates noise sigma via temporal
 * luma frame differencing + PlaneStats across multiple sample regions.
 * Prints SIGMA:<value> per frame to stderr.
 */
const buildNoiseVpy = (inputPath, lwiCache, sampleStarts) => {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  // Build region clips — unrolled (VS Splice needs explicit clip list)
  const regionBlocks = sampleStarts.map((start, i) => [
    `r${i} = src[${start}:${start + FRAMES_PER_REGION + 1}]`,
    `d${i} = core.std.Expr([r${i}[:-1], r${i}[1:]], expr=['x y - abs'])`,
    `d${i} = core.std.PlaneStats(d${i})`,
  ].join('\n')).join('\n');

  const spliceArgs = sampleStarts.map((_, i) => `d${i}`).join(', ');

  return [
    'import vapoursynth as vs',
    'import sys',
    '',
    'core = vs.core',
    `src = core.lsmas.LWLibavSource(source='${esc(inputPath)}', cachefile='${esc(lwiCache)}')`,
    'src = core.std.ShufflePlanes(src, planes=0, colorfamily=vs.GRAY)',
    '',
    regionBlocks,
    '',
    `out = core.std.Splice([${spliceArgs}])`,
    '',
    'def _print_stats(n, f):',
    "    avg = f.props['PlaneStatsAverage']",
    '    sigma = avg * 255.0 * 1.2533 / 1.4142',
    "    print(f'SIGMA:{sigma:.4f}', file=sys.stderr, flush=True)",
    '    return f',
    '',
    'out = core.std.ModifyFrame(out, out, _print_stats)',
    'out.set_output()',
  ].join('\n') + '\n';
};

/**
 * Estimate noise sigma from the source file using VapourSynth temporal
 * frame differencing + PlaneStats. Samples 4 regions of 50 frames each
 * at 15%, 35%, 55%, 75% of the video. Returns { sigma, grainParam }.
 */
const estimateNoise = (inputPath, durationSec, totalFrames, vspipeBin, lwiCache, dbg) => {
  if (totalFrames < FRAMES_PER_REGION + 10) {
    dbg(`[grain] too few frames (${totalFrames}) for noise estimation, skipping`);
    return { sigma: 0, grainParam: 0 };
  }

  // Calculate 4 sample start positions at 15%, 35%, 55%, 75%
  const positions = [0.15, 0.35, 0.55, 0.75];
  const maxStart = totalFrames - FRAMES_PER_REGION - 1;
  const sampleStarts = positions.map((p) =>
    Math.min(Math.max(0, Math.floor(totalFrames * p)), maxStart)
  );

  const vpyDir = path.dirname(lwiCache);
  const vpyPath = path.join(vpyDir, 'noise_estimate.vpy');

  const vpyContent = buildNoiseVpy(inputPath, lwiCache, sampleStarts);
  fs.writeFileSync(vpyPath, vpyContent);
  dbg(`[grain] wrote noise estimation script: ${vpyPath}`);
  dbg(`[grain] sample positions: ${sampleStarts.join(', ')} (${FRAMES_PER_REGION} frames each)`);

  let output;
  try {
    const result = cp.spawnSync(vspipeBin, ['-p', vpyPath, '-'], {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf8',
    });
    output = (result.stderr || '') + (result.stdout || '');
    if (result.error) {
      dbg(`[grain] vspipe failed: ${result.error.message}`);
      return { sigma: 0, grainParam: 0 };
    }
    if (result.status !== 0) {
      dbg(`[grain] vspipe exited ${result.status}: ${(result.stderr || '').slice(0, 300)}`);
      return { sigma: 0, grainParam: 0 };
    }
  } catch (err) {
    dbg(`[grain] vspipe failed: ${err.message}`);
    return { sigma: 0, grainParam: 0 };
  } finally {
    try { fs.unlinkSync(vpyPath); } catch (_) {}
  }

  // Parse SIGMA values from output
  const sigmaRegex = /SIGMA:([\d.]+)/g;
  const values = [];
  let match;
  while ((match = sigmaRegex.exec(output)) !== null) {
    values.push(parseFloat(match[1]));
  }

  if (values.length === 0) {
    dbg('[grain] no SIGMA values found in vspipe output');
    return { sigma: 0, grainParam: 0 };
  }

  // Median — robust to scene changes and motion outliers
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  const sigma = values.length % 2 === 0
    ? (values[mid - 1] + values[mid]) / 2
    : values[mid];

  const grainParam = mapSigmaToGrainParam(sigma);
  dbg(`[grain] estimated sigma=${sigma.toFixed(2)} -> film-grain=${grainParam} (from ${values.length} frames)`);

  return { sigma, grainParam };
};
```

Also add `path` and `fs` requires at the top of the file (after `const cp = require('child_process');`):

```js
const path = require('path');
const fs = require('fs');
```

And update the timeout from 60s to 120s comment in the GRAIN_CURVE header:

```js
// Sigma is estimated via VapourSynth temporal frame differencing.
// Clean content reads ~0, moderate grain ~3, heavy ~6+.
```

- [ ] **Step 2: Verify the module exports are unchanged**

The exports remain the same shape:

```js
module.exports = { estimateNoise, mapSigmaToGrainParam, GRAIN_CURVE, SIGMA_SKIP_THRESHOLD };
```

No changes needed — just verify this line is still at the bottom.

- [ ] **Step 3: Build to verify no syntax errors**

Run: `npm run build`
Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/shared/grainSynth.js
git commit -m "feat(grain): replace ffmpeg noise estimation with VapourSynth"
```

---

### Task 2: Update `av1anEncode` to use new `estimateNoise` signature

**Files:**
- Modify: `src/av1anEncode/index.js:185-196`

The av1an plugin already has `BIN.vspipe`, `vsDir`, and `lwiCache`. We need to:
1. Compute `totalFrames` from stream metadata
2. Pass the new arguments to `estimateNoise`

- [ ] **Step 1: Add totalFrames calculation and update estimateNoise call**

In `src/av1anEncode/index.js`, replace the grain estimation block (lines 185–196):

```js
  let grainParam = 0;
  if (grainSynthEnabled) {
    const durationSec = parseFloat(stream.duration || '0')
      || (file.ffProbeData && file.ffProbeData.format && parseFloat(file.ffProbeData.format.duration)) || 0;
    const result = estimateNoise(inputPath, durationSec, BIN.ffmpeg, dbg);
    grainParam = result.grainParam;
    if (grainParam > 0) {
      jobLog(`[grain] detected sigma=${result.sigma.toFixed(2)} -> film-grain=${grainParam}`);
    } else {
      jobLog('[grain] source is clean (sigma < 2), skipping grain synthesis');
    }
  }
```

With:

```js
  let grainParam = 0;
  if (grainSynthEnabled) {
    const durationSec = parseFloat(stream.duration || '0')
      || (file.ffProbeData && file.ffProbeData.format && parseFloat(file.ffProbeData.format.duration)) || 0;
    const fps = (() => {
      const r = stream.r_frame_rate || stream.avg_frame_rate || '24/1';
      const parts = r.split('/').map(Number);
      return parts[1] ? parts[0] / parts[1] : parts[0];
    })();
    const totalFrames = Math.round(durationSec * fps);
    const lwiCache = path.join(vsDir, 'source.lwi');
    const result = estimateNoise(inputPath, durationSec, totalFrames, BIN.vspipe, lwiCache, dbg);
    grainParam = result.grainParam;
    if (grainParam > 0) {
      jobLog(`[grain] detected sigma=${result.sigma.toFixed(2)} -> film-grain=${grainParam}`);
    } else {
      jobLog('[grain] source is clean (sigma < 2), skipping grain synthesis');
    }
  }
```

Note: `vsDir` is created later (line 203–206). We need to move the `vsDir` creation **above** the grain estimation block. Move these lines:

```js
  const workBase = path.join(args.workDir, 'av1an-work');
  const vsDir = path.join(workBase, 'vs');
  const av1anTemp = path.join(workBase, 'work');
  const outputPath = path.join(args.workDir, 'av1-output.mkv');
  fs.mkdirSync(vsDir, { recursive: true });
  fs.mkdirSync(av1anTemp, { recursive: true });
```

To just **before** the `let grainParam = 0;` line (after the thread budget calculation block, around line 184).

- [ ] **Step 2: Build to verify no syntax errors**

Run: `npm run build`
Expected: Build succeeds with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/av1anEncode/index.js
git commit -m "feat(grain): update av1anEncode to use VapourSynth noise estimation"
```

---

### Task 3: Update `abAv1Encode` to use new `estimateNoise` signature

**Files:**
- Modify: `src/abAv1Encode/index.js:139-189`

The ab-av1 plugin needs `vspipe` binary resolution and a `vsDir` + `lwiCache` path.

- [ ] **Step 1: Add vspipe binary resolution**

In `src/abAv1Encode/index.js`, after the `BIN_FFMPEG` block (line 142), add:

```js
  const BIN_VSPIPE = ['/usr/local/bin/vspipe', '/usr/bin/vspipe'].find((p) => fs.existsSync(p));
  if (!BIN_VSPIPE) throw new Error('Required binary not found: vspipe (checked /usr/local/bin, /usr/bin)');
```

- [ ] **Step 2: Add vsDir creation and update estimateNoise call**

Replace the grain estimation block (lines 178–189):

```js
  let grainParam = 0;
  if (grainSynthEnabled) {
    const durationSec = parseFloat(stream.duration || '0')
      || (file.ffProbeData && file.ffProbeData.format && parseFloat(file.ffProbeData.format.duration)) || 0;
    const result = estimateNoise(inputPath, durationSec, BIN_FFMPEG, dbg);
    grainParam = result.grainParam;
    if (grainParam > 0) {
      jobLog(`[grain] detected sigma=${result.sigma.toFixed(2)} -> film-grain=${grainParam}`);
    } else {
      jobLog('[grain] source is clean (sigma < 2), skipping grain synthesis');
    }
  }
```

With:

```js
  let grainParam = 0;
  if (grainSynthEnabled) {
    const durationSec = parseFloat(stream.duration || '0')
      || (file.ffProbeData && file.ffProbeData.format && parseFloat(file.ffProbeData.format.duration)) || 0;
    const fps = (() => {
      const r = stream.r_frame_rate || stream.avg_frame_rate || '24/1';
      const parts = r.split('/').map(Number);
      return parts[1] ? parts[0] / parts[1] : parts[0];
    })();
    const totalFrames = Math.round(durationSec * fps);
    const vsDir = path.join(args.workDir, 'vs-grain');
    fs.mkdirSync(vsDir, { recursive: true });
    const lwiCache = path.join(vsDir, 'source.lwi');
    const result = estimateNoise(inputPath, durationSec, totalFrames, BIN_VSPIPE, lwiCache, dbg);
    grainParam = result.grainParam;
    if (grainParam > 0) {
      jobLog(`[grain] detected sigma=${result.sigma.toFixed(2)} -> film-grain=${grainParam}`);
    } else {
      jobLog('[grain] source is clean (sigma < 2), skipping grain synthesis');
    }
  }
```

- [ ] **Step 3: Build to verify no syntax errors**

Run: `npm run build`
Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/abAv1Encode/index.js
git commit -m "feat(grain): update abAv1Encode to use VapourSynth noise estimation"
```

---

### Task 4: Build, deploy, and test against tdarr test server

**Files:**
- No file changes — testing and validation

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: Build succeeds, both plugins bundled to `dist/`.

- [ ] **Step 2: Deploy to test instance**

Run: `npm run deploy`
Expected: Plugins copied to `../tdarr-av1/test/tdarr_config/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/`.

- [ ] **Step 3: Run smoke tests**

Run: `npm run test:smoke`
Expected: Both plugins detected and validated in Tdarr.

- [ ] **Step 4: Run e2e test with grain synth enabled**

Trigger an encode job in the tdarr test server with `grain_synth: true`. Check the job log for:
- `[grain] wrote noise estimation script:` — VS script was generated
- `[grain] sample positions:` — 4 sample positions listed
- `[grain] estimated sigma=X.XX -> film-grain=Y` — sigma was calculated and mapped
- No vspipe errors

Check `av1-debug.log` in the work directory for detailed output.

- [ ] **Step 5: Commit any fixes if needed**

If smoke/e2e tests reveal issues, fix and commit incrementally.
