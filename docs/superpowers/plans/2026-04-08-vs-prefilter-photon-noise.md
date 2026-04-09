# VS Prefilter + Photon Noise Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace built-in encoder grain synthesis with NLMeans VS prefilter + av1an photon noise for higher-quality grain handling.

**Architecture:** Remove `grainParam` from encoder flag builders (always disable built-in denoise). `grainSynth.js` returns NLMeans `h` and photon-noise values mapped from sigma. Plugin index files inject NLMeans into the `.vpy` script and add `--photon-noise`/`--chroma-noise` to av1an args. A calibration test script empirically derives the mapping curves.

**Tech Stack:** VapourSynth (vs-nlm-ispc plugin), av1an `--photon-noise`, Node.js, esbuild

**Spec:** `docs/superpowers/specs/2026-04-08-vs-prefilter-photon-noise-design.md`

---

### Task 1: Remove `grainParam` from encoder flag builders

**Files:**
- Modify: `src/shared/encoderFlags.js:77-169`

- [ ] **Step 1: Update `buildAomFlags` — remove `grainParam`, always disable denoise**

In `src/shared/encoderFlags.js`, change `buildAomFlags`:

```js
const buildAomFlags = (preset, threadsPerWorker, hdrAom) => {
  return [
    '--end-usage=q', `--cpu-used=${preset}`, `--threads=${threadsPerWorker}`,
    '--tune=ssim', '--enable-fwd-kf=0', '--disable-kf', '--kf-max-dist=9999',
    '--enable-qm=1', '--bit-depth=10', '--lag-in-frames=48',
    '--tile-columns=0', '--tile-rows=0', '--sb-size=dynamic',
    '--deltaq-mode=0', '--aq-mode=0', '--arnr-strength=1', '--arnr-maxframes=4',
    '--enable-chroma-deltaq=1', '--enable-dnl-denoising=0',
    '--disable-trellis-quant=0', '--quant-b-adapt=1',
    '--enable-keyframe-filtering=1', hdrAom,
  ].filter(Boolean).join(' ');
};
```

- [ ] **Step 2: Update `svtConfig` — remove `grainParam`, always disable grain**

```js
const svtConfig = (preset, lp, hdrSvt) => {
  const entries = [
    ['rc', '0'],
    ['preset', String(preset)],
    ['tune', '1'],
    ['input-depth', '10'],
    ['lookahead', '48'],
    ['keyint', '-1'],
    ['irefresh-type', '2'],
    ['enable-overlays', '1'],
    ['enable-variance-boost', '1'],
    ['variance-boost-strength', '2'],
    ['variance-octile', '6'],
    ['enable-qm', '1'],
    ['qm-min', '0'],
    ['qm-max', '15'],
    ['chroma-qm-min', '8'],
    ['chroma-qm-max', '15'],
    ['tf-strength', '1'],
    ['sharpness', '1'],
    ['tile-columns', '1'],
    ['scm', '0'],
    ['film-grain', '0'],
    ['film-grain-denoise', '0'],
  ];
  if (lp) entries.push(['lp', String(lp)]);
  return { entries, hdrSvt };
};
```

- [ ] **Step 3: Update `buildSvtFlags` signature**

```js
const buildSvtFlags = (preset, svtLp, hdrSvt) =>
  formatSvtForAv1an(svtConfig(preset, svtLp, hdrSvt));
```

- [ ] **Step 4: Update `buildAbAv1SvtFlags` — remove `grainParam`**

```js
const buildAbAv1SvtFlags = (lp) => {
  const cfg = svtConfig(0, lp, '');
  const skip = new Set(['rc', 'preset', 'input-depth', 'keyint']);
  const filtered = { entries: cfg.entries.filter(([k]) => !skip.has(k)), hdrSvt: '' };
  return [formatSvtForAbAv1(filtered), '--keyint 10s', '--scd true'].join(' ');
};
```

- [ ] **Step 5: Update `buildAbAv1AomFlags` — remove `grainParam`**

```js
const buildAbAv1AomFlags = (preset, threadsPerWorker, hdrAom) => {
  const ffmpegArgs = [
    '--enc tune=ssim',
    '--enc lag-in-frames=48',
    '--enc tile-columns=0',
    '--enc tile-rows=0',
    '--enc aq-mode=0',
    '--enc arnr-strength=1',
    '--enc arnr-max-frames=4',
  ].filter(Boolean);

  const aomParams = [
    'enable-qm=1',
    'sb-size=dynamic',
    'deltaq-mode=0',
    'enable-chroma-deltaq=1',
    'disable-trellis-quant=0',
    'quant-b-adapt=1',
    'enable-keyframe-filtering=1',
    'enable-dnl-denoising=0',
  ].filter(Boolean).join(':');

  return [...ffmpegArgs, `--enc aom-params=${aomParams}`].join(' ');
};
```

- [ ] **Step 6: Verify build succeeds**

Run: `npm run build`
Expected: Build completes (callers will break — fixed in later tasks)

- [ ] **Step 7: Commit**

```bash
git add src/shared/encoderFlags.js
git commit -m "refactor(encoderFlags): remove grainParam, always disable built-in denoise"
```

---

### Task 2: Rewrite `grainSynth.js` — NLMeans + photon noise mapping

**Files:**
- Modify: `src/shared/grainSynth.js`

- [ ] **Step 1: Replace `GRAIN_CURVE` with `DENOISE_CURVE` and `PHOTON_CURVE`**

Replace the `GRAIN_CURVE`, `SIGMA_SKIP_THRESHOLD`, and `mapSigmaToGrainParam` block (lines 8-43) with:

```js
// Control points for sigma -> NLMeans h parameter mapping.
// Derived empirically via calibration test (see calibrate-grain.sh).
// Placeholder values — will be replaced with calibration results.
const DENOISE_CURVE = [
  { sigma: 2,  h: 0.8 },
  { sigma: 4,  h: 1.2 },
  { sigma: 6,  h: 1.8 },
  { sigma: 10, h: 2.8 },
  { sigma: 15, h: 4.0 },
];

// Control points for sigma -> av1an --photon-noise value mapping.
// Derived empirically via calibration test (see calibrate-grain.sh).
// Placeholder values — will be replaced with calibration results.
const PHOTON_CURVE = [
  { sigma: 2,  param: 4 },
  { sigma: 4,  param: 8 },
  { sigma: 6,  param: 12 },
  { sigma: 10, param: 18 },
  { sigma: 15, param: 30 },
];

const SIGMA_SKIP_THRESHOLD = 2;
const CHROMA_SIGMA_RATIO = 0.5;
const SAMPLE_REGIONS = 4;
const FRAMES_PER_REGION = 50;

const interpolateCurve = (curve, sigma) => {
  if (sigma < SIGMA_SKIP_THRESHOLD) return 0;
  if (sigma >= curve[curve.length - 1].sigma) {
    return curve[curve.length - 1][Object.keys(curve[0])[1]];
  }
  const valKey = Object.keys(curve[0]).find((k) => k !== 'sigma');
  for (let i = 0; i < curve.length - 1; i++) {
    const lo = curve[i];
    const hi = curve[i + 1];
    if (sigma >= lo.sigma && sigma < hi.sigma) {
      const t = (sigma - lo.sigma) / (hi.sigma - lo.sigma);
      return lo[valKey] + t * (hi[valKey] - lo[valKey]);
    }
  }
  return 0;
};

const mapSigmaToNlmH = (sigma) => {
  const h = interpolateCurve(DENOISE_CURVE, sigma);
  return Math.round(h * 100) / 100;
};

const mapSigmaToPhotonNoise = (sigma) => {
  const pn = interpolateCurve(PHOTON_CURVE, sigma);
  return Math.round(pn);
};
```

- [ ] **Step 2: Update `estimateNoise` return value**

Change the end of `estimateNoise` (lines 177-180) from:

```js
  const grainParam = mapSigmaToGrainParam(sigma);
  dbg(`[grain] estimated sigma=${sigma.toFixed(2)} -> film-grain=${grainParam} (from ${values.length} frames)`);

  return { sigma, grainParam };
```

to:

```js
  const nlmH = mapSigmaToNlmH(sigma);
  const nlmChromaH = mapSigmaToNlmH(sigma * CHROMA_SIGMA_RATIO);
  const photonNoise = mapSigmaToPhotonNoise(sigma);
  dbg(`[grain] estimated sigma=${sigma.toFixed(2)} -> nlmH=${nlmH} nlmChromaH=${nlmChromaH} photon-noise=${photonNoise} (from ${values.length} frames)`);

  return { sigma, nlmH, nlmChromaH, photonNoise };
```

- [ ] **Step 3: Update module.exports**

Change:

```js
module.exports = { estimateNoise, mapSigmaToGrainParam, GRAIN_CURVE, SIGMA_SKIP_THRESHOLD };
```

to:

```js
module.exports = {
  estimateNoise, mapSigmaToNlmH, mapSigmaToPhotonNoise,
  DENOISE_CURVE, PHOTON_CURVE, SIGMA_SKIP_THRESHOLD, CHROMA_SIGMA_RATIO,
};
```

- [ ] **Step 4: Verify build succeeds**

Run: `npm run build`
Expected: Build completes

- [ ] **Step 5: Commit**

```bash
git add src/shared/grainSynth.js
git commit -m "refactor(grainSynth): replace encoder grain param with NLMeans h + photon noise mappings"
```

---

### Task 3: Update `av1anEncode` — NLMeans prefilter + photon noise

**Files:**
- Modify: `src/av1anEncode/index.js`

- [ ] **Step 1: Update grain synth section (lines 206-223)**

Replace the grain estimation + encoder flag block with:

```js
  let grainResult = null;
  if (grainSynthEnabled) {
    const durationSec = parseFloat(stream.duration || '0')
      || (file.ffProbeData && file.ffProbeData.format && parseFloat(file.ffProbeData.format.duration)) || 0;
    const srcFpsForGrain = (() => {
      const r = stream.r_frame_rate || stream.avg_frame_rate || '24/1';
      const parts = r.split('/').map(Number);
      return parts[1] ? parts[0] / parts[1] : parts[0];
    })();
    const totalFrames = parseInt(stream.nb_frames || '0', 10)
      || (durationSec > 0 && srcFpsForGrain > 0 ? Math.round(durationSec * srcFpsForGrain) : 0);
    const result = estimateNoise(inputPath, durationSec, totalFrames, BIN.vspipe, lwiCache, dbg);
    if (result.photonNoise > 0) {
      grainResult = result;
      jobLog(`[grain] detected sigma=${result.sigma.toFixed(2)} -> nlmH=${result.nlmH} photon-noise=${result.photonNoise}`);
    } else {
      jobLog('[grain] source is clean (sigma < 2), skipping grain synthesis');
    }
  }
```

- [ ] **Step 2: Check NLMeans plugin availability after noise estimation**

Add after the grain estimation block:

```js
  if (grainResult) {
    const checkScript = path.join(vsDir, 'check_nlm.vpy');
    fs.writeFileSync(checkScript, [
      'import vapoursynth as vs',
      'core = vs.core',
      'assert hasattr(core, "nlm_ispc"), "nlm_ispc plugin not found"',
      'core.std.BlankClip(length=1).set_output()',
    ].join('\n') + '\n');
    const checkExit = require('child_process').spawnSync(BIN.vspipe, ['--info', checkScript], {
      timeout: 10000, encoding: 'utf8',
    });
    try { fs.unlinkSync(checkScript); } catch (_) {}
    if (checkExit.status !== 0) {
      throw new Error('Grain synthesis requires vs-nlm-ispc plugin. Disable grain_synth or install the plugin.');
    }
    dbg('[grain] nlm_ispc plugin verified');
  }
```

- [ ] **Step 3: Update encoder flag calls — remove `grainParam`**

Change the `encFlags` block (lines 226-235) from:

```js
  let encFlags;
  if (isAutoThreads) {
    encFlags = encoder === 'aom'
      ? buildAomFlags(encPreset, 0, hdrAom, grainParam).replace(/--threads=\d+\s*/, '')
      : buildSvtFlags(encPreset, 0, hdrSvt, grainParam).replace(/--lp \d+\s*/, '');
  } else {
    encFlags = encoder === 'aom'
      ? buildAomFlags(encPreset, threadsPerWorker, hdrAom, grainParam)
      : buildSvtFlags(encPreset, svtLp, hdrSvt, grainParam);
  }
```

to:

```js
  let encFlags;
  if (isAutoThreads) {
    encFlags = encoder === 'aom'
      ? buildAomFlags(encPreset, 0, hdrAom).replace(/--threads=\d+\s*/, '')
      : buildSvtFlags(encPreset, 0, hdrSvt).replace(/--lp \d+\s*/, '');
  } else {
    encFlags = encoder === 'aom'
      ? buildAomFlags(encPreset, threadsPerWorker, hdrAom)
      : buildSvtFlags(encPreset, svtLp, hdrSvt);
  }
```

- [ ] **Step 4: Add NLMeans to `.vpy` script generation**

Change the `.vpy` generation block (lines 261-271). Insert NLMeans lines between the source load and downscale:

```js
  let vpyLines = [
    'import vapoursynth as vs',
    'core = vs.core',
    `src = core.lsmas.LWLibavSource(source='${escPy(inputPath)}', cachefile='${escPy(lwiCache)}')`,
  ];
  if (grainResult) {
    vpyLines.push(
      `src = core.nlm_ispc.NLMeans(src, d=1, a=2, s=4, h=${grainResult.nlmH}, channels="Y")`,
      `src = core.nlm_ispc.NLMeans(src, d=1, a=2, s=4, h=${grainResult.nlmChromaH}, channels="UV")`,
    );
  }
  if (doDownscale) {
    vpyLines = vpyLines.concat(buildVsDownscaleLines(downscaleRes));
  }
  vpyLines.push('src.set_output()');
  fs.writeFileSync(vpyScript, vpyLines.join('\n') + '\n');
  dbg(`[vs] .vpy written${grainResult ? ' (NLMeans denoise)' : ''}${doDownscale ? ` (Lanczos3 -> ${downscaleRes})` : ''}`);
```

- [ ] **Step 5: Add `--photon-noise` and `--chroma-noise` to av1an args**

After the existing `av1anArgs.push('-v', encFlags);` line (line 309), add:

```js
  if (grainResult) {
    av1anArgs.push('--photon-noise', String(grainResult.photonNoise), '--chroma-noise');
  }
```

- [ ] **Step 6: Update grain log line**

Change the grain log line (lines 245-247) from:

```js
  if (grainSynthEnabled) {
    jobLog(`  grain      : ${grainParam > 0 ? `enabled (film-grain=${grainParam})` : 'enabled (clean source, skipped)'}`);
  }
```

to:

```js
  if (grainSynthEnabled) {
    jobLog(`  grain      : ${grainResult ? `NLMeans h=${grainResult.nlmH} + photon-noise=${grainResult.photonNoise}` : 'enabled (clean source, skipped)'}`);
  }
```

- [ ] **Step 7: Update tooltip for grain_synth input**

Change the grain_synth tooltip (line 105) to:

```js
      tooltip: 'Detect noise, denoise with NLMeans prefilter, and add photon noise grain at playback. Saves bitrate on noisy sources with no visual penalty.',
```

- [ ] **Step 8: Verify build succeeds**

Run: `npm run build`
Expected: Build completes without errors

- [ ] **Step 9: Commit**

```bash
git add src/av1anEncode/index.js
git commit -m "feat(av1anEncode): use NLMeans prefilter + photon noise instead of encoder grain synth"
```

---

### Task 4: Update `crfSearchEncode` — NLMeans prefilter + photon noise

**Files:**
- Modify: `src/crfSearchEncode/index.js`

- [ ] **Step 1: Update grain estimation (lines 256-274)**

Replace with:

```js
  let grainResult = null;
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
    if (result.photonNoise > 0) {
      grainResult = result;
      jobLog(`[grain] detected sigma=${result.sigma.toFixed(2)} -> nlmH=${result.nlmH} photon-noise=${result.photonNoise}`);
    } else {
      jobLog('[grain] source is clean (sigma < 2), skipping grain synthesis');
    }
  }
```

- [ ] **Step 2: Check NLMeans plugin availability**

Add after grain estimation (same pattern as av1anEncode Task 3 Step 2):

```js
  if (grainResult) {
    const checkScript = path.join(vsDir, 'check_nlm.vpy');
    fs.writeFileSync(checkScript, [
      'import vapoursynth as vs',
      'core = vs.core',
      'assert hasattr(core, "nlm_ispc"), "nlm_ispc plugin not found"',
      'core.std.BlankClip(length=1).set_output()',
    ].join('\n') + '\n');
    const checkExit = require('child_process').spawnSync(BIN.vspipe, ['--info', checkScript], {
      timeout: 10000, encoding: 'utf8',
    });
    try { fs.unlinkSync(checkScript); } catch (_) {}
    if (checkExit.status !== 0) {
      throw new Error('Grain synthesis requires vs-nlm-ispc plugin. Disable grain_synth or install the plugin.');
    }
    dbg('[grain] nlm_ispc plugin verified');
  }
```

- [ ] **Step 3: Add NLMeans to `.vpy` script (lines 235-244)**

Note: in `crfSearchEncode`, the `.vpy` is built BEFORE grain estimation (it's used for scene detection). We need to move `.vpy` generation AFTER grain estimation, or rebuild it. The cleanest approach: build the `.vpy` after grain estimation.

Move the `.vpy` generation block to after the grain estimation + NLMeans check. The new `.vpy` block:

```js
  let vpyLines = [
    'import vapoursynth as vs',
    'core = vs.core',
    `src = core.lsmas.LWLibavSource(source='${escPy(inputPath)}', cachefile='${escPy(lwiCache)}')`,
  ];
  if (grainResult) {
    vpyLines.push(
      `src = core.nlm_ispc.NLMeans(src, d=1, a=2, s=4, h=${grainResult.nlmH}, channels="Y")`,
      `src = core.nlm_ispc.NLMeans(src, d=1, a=2, s=4, h=${grainResult.nlmChromaH}, channels="UV")`,
    );
  }
  if (doDownscale) {
    vpyLines = vpyLines.concat(buildVsDownscaleLines(downscaleRes));
  }
  vpyLines.push('src.set_output()');
  fs.writeFileSync(vpyScript, vpyLines.join('\n') + '\n');
  dbg(`[vs] .vpy written${grainResult ? ' (NLMeans denoise)' : ''}${doDownscale ? ` (Lanczos3 -> ${downscaleRes})` : ''}`);
```

**Important:** The scene detection uses `vpyScript` and starts before the `.vpy` is rebuilt. We need a simple passthrough `.vpy` for scene detection (written before grain estimation), then rewrite it with NLMeans after. Write a minimal scene-detect `.vpy` first:

```js
  // Write initial .vpy for scene detection (no denoise needed for scene cuts)
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
```

Then after grain estimation + NLMeans check, rewrite the `.vpy` if needed:

```js
  // Rewrite .vpy with NLMeans denoise for phase 2 encoding
  if (grainResult) {
    vpyLines = [
      'import vapoursynth as vs',
      'core = vs.core',
      `src = core.lsmas.LWLibavSource(source='${escPy(inputPath)}', cachefile='${escPy(lwiCache)}')`,
      `src = core.nlm_ispc.NLMeans(src, d=1, a=2, s=4, h=${grainResult.nlmH}, channels="Y")`,
      `src = core.nlm_ispc.NLMeans(src, d=1, a=2, s=4, h=${grainResult.nlmChromaH}, channels="UV")`,
    ];
    if (doDownscale) {
      vpyLines = vpyLines.concat(buildVsDownscaleLines(downscaleRes));
    }
    vpyLines.push('src.set_output()');
    fs.writeFileSync(vpyScript, vpyLines.join('\n') + '\n');
    dbg('[vs] .vpy rewritten with NLMeans denoise for phase 2');
  }
```

- [ ] **Step 4: Update CRF search encoder flags — remove `grainParam`**

Change lines 315-323 from:

```js
  let searchEncFlags;
  if (encoder === 'aom') {
    const tpw = isAutoThreads ? availableThreads : searchBudget.threadsPerWorker;
    searchEncFlags = buildAbAv1AomFlags(encPreset, tpw, hdrAom, grainParam);
  } else {
    searchEncFlags = isAutoThreads
      ? buildAbAv1SvtFlags(0, grainParam).replace(/--svt lp=\d+\s*/, '')
      : buildAbAv1SvtFlags(searchBudget.svtLp, grainParam);
  }
```

to:

```js
  let searchEncFlags;
  if (encoder === 'aom') {
    const tpw = isAutoThreads ? availableThreads : searchBudget.threadsPerWorker;
    searchEncFlags = buildAbAv1AomFlags(encPreset, tpw, hdrAom);
  } else {
    searchEncFlags = isAutoThreads
      ? buildAbAv1SvtFlags(0).replace(/--svt lp=\d+\s*/, '')
      : buildAbAv1SvtFlags(searchBudget.svtLp);
  }
```

- [ ] **Step 5: Update phase 2 encoder flags — remove `grainParam`**

Change the phase 2 encoder flags block (lines 444-459) from:

```js
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
```

to:

```js
  let encFlags;
  if (encoder === 'aom') {
    const crfFlag = `--cq-level=${foundCrf}`;
    if (isAutoThreads) {
      encFlags = buildAomFlags(encPreset, 0, hdrAom).replace(/--threads=\d+\s*/, '') + ' ' + crfFlag;
    } else {
      encFlags = buildAomFlags(encPreset, encodeBudget.threadsPerWorker, hdrAom) + ' ' + crfFlag;
    }
  } else {
    const crfFlag = `--crf ${foundCrf}`;
    if (isAutoThreads) {
      encFlags = buildSvtFlags(encPreset, 0, hdrSvt).replace(/--lp \d+\s*/, '') + ' ' + crfFlag;
    } else {
      encFlags = buildSvtFlags(encPreset, encodeBudget.svtLp, hdrSvt) + ' ' + crfFlag;
    }
  }
```

- [ ] **Step 6: Add `--photon-noise` and `--chroma-noise` to av1an args**

After the existing `av1anArgs.push('-v', encFlags);` line (line 485), add:

```js
  if (grainResult) {
    av1anArgs.push('--photon-noise', String(grainResult.photonNoise), '--chroma-noise');
  }
```

- [ ] **Step 7: Update grain log line**

Change lines 303-305 from:

```js
  if (grainSynthEnabled) {
    jobLog(`  grain      : ${grainParam > 0 ? `enabled (film-grain=${grainParam})` : 'enabled (clean source, skipped)'}`);
  }
```

to:

```js
  if (grainSynthEnabled) {
    jobLog(`  grain      : ${grainResult ? `NLMeans h=${grainResult.nlmH} + photon-noise=${grainResult.photonNoise}` : 'enabled (clean source, skipped)'}`);
  }
```

- [ ] **Step 8: Update tooltip**

Change the grain_synth tooltip (line 113) to:

```js
      tooltip: 'Detect noise, denoise with NLMeans prefilter, and add photon noise grain at playback. Saves bitrate on noisy sources with no visual penalty.',
```

- [ ] **Step 9: Verify build succeeds**

Run: `npm run build`
Expected: Build completes without errors

- [ ] **Step 10: Commit**

```bash
git add src/crfSearchEncode/index.js
git commit -m "feat(crfSearchEncode): use NLMeans prefilter + photon noise instead of encoder grain synth"
```

---

### Task 5: Remove grain synthesis from `abAv1Encode`

**Files:**
- Modify: `src/abAv1Encode/index.js`
- Modify: `src/abAv1Encode/e2e-tests.json`

- [ ] **Step 1: Remove `grain_synth` input from details**

Remove this entire input block (lines 91-98):

```js
    {
      label: 'Grain Synthesis',
      name: 'grain_synth',
      type: 'boolean',
      defaultValue: 'false',
      inputUI: { type: 'switch' },
      tooltip: 'Automatically detect noise, denoise during encoding, and synthesize matching grain at playback. Saves bitrate on noisy sources with no visual penalty.',
    },
```

- [ ] **Step 2: Remove grain synth imports and code from plugin function**

Remove the `grainSynth` import (line 116):

```js
  const { estimateNoise } = require('../shared/grainSynth');
```

Remove `grainSynthEnabled` (line 137):

```js
  const grainSynthEnabled = inputs.grain_synth === true || inputs.grain_synth === 'true';
```

Remove the entire grain estimation block (lines 191-207):

```js
  let grainParam = 0;
  if (grainSynthEnabled) {
    ...
  }
```

- [ ] **Step 3: Update flag builder calls — remove `grainParam`**

Change lines 209-211 from:

```js
  const svtFlags = isAutoThreads
    ? buildAbAv1SvtFlags(0, grainParam).replace(/--svt lp=\d+\s*/, '')
    : buildAbAv1SvtFlags(svtLp, grainParam);
```

to:

```js
  const svtFlags = isAutoThreads
    ? buildAbAv1SvtFlags(0).replace(/--svt lp=\d+\s*/, '')
    : buildAbAv1SvtFlags(svtLp);
```

- [ ] **Step 4: Remove grain log lines**

Remove lines 224-226:

```js
  if (grainSynthEnabled) {
    jobLog(`  grain      : ${grainParam > 0 ? `enabled (film-grain=${grainParam})` : 'enabled (clean source, skipped)'}`);
  }
```

- [ ] **Step 5: Update e2e tests — remove grain_synth tests**

Replace `src/abAv1Encode/e2e-tests.json` with:

```json
[
  {
    "name": "default",
    "inputs": {
      "target_vmaf": "93",
      "preset": "6",
      "thread_strategy": "auto"
    }
  }
]
```

- [ ] **Step 6: Verify build succeeds**

Run: `npm run build`
Expected: Build completes without errors

- [ ] **Step 7: Commit**

```bash
git add src/abAv1Encode/index.js src/abAv1Encode/e2e-tests.json
git commit -m "feat(abAv1Encode): remove grain synthesis support (use crfSearchEncode instead)"
```

---

### Task 6: Update e2e tests for av1anEncode and crfSearchEncode

**Files:**
- Modify: `src/av1anEncode/e2e-tests.json`
- Modify: `src/crfSearchEncode/e2e-tests.json`

- [ ] **Step 1: Update av1anEncode e2e tests**

The test names/structure stay the same — the grain_synth toggle still exists, it just uses the new pipeline internally. No test file changes needed unless we want to rename. Keep as-is.

- [ ] **Step 2: Verify crfSearchEncode e2e tests**

Read `src/crfSearchEncode/e2e-tests.json` — the grain_synth toggle still exists. Keep as-is.

- [ ] **Step 3: Verify full build + deploy**

Run: `npm run build`
Expected: All three plugins build successfully

- [ ] **Step 4: Commit (if any changes)**

```bash
git add src/av1anEncode/e2e-tests.json src/crfSearchEncode/e2e-tests.json
git commit -m "chore: update e2e test names for new grain pipeline"
```

---

### Task 7: Build calibration test script

**Files:**
- Create: `test/calibrate-grain.sh`

This script runs inside the Docker container to empirically derive `DENOISE_CURVE` and `PHOTON_CURVE` control points.

- [ ] **Step 1: Create the calibration script**

Create `test/calibrate-grain.sh`:

```bash
#!/usr/bin/env bash
# Calibrate NLMeans h and photon-noise mappings for grainSynth.js
# Run inside the tdarr Docker container:
#   docker exec -it tdarr-interactive-node bash /path/to/calibrate-grain.sh
#
# Generates test clips with known noise, finds optimal NLMeans h per sigma,
# and finds the photon-noise value that recreates similar apparent noise.
# Outputs control points for DENOISE_CURVE and PHOTON_CURVE.

set -euo pipefail

WORKDIR="${1:-/tmp/grain-calibration}"
mkdir -p "$WORKDIR"

VSPIPE="$(command -v vspipe)"
AV1AN="$(command -v av1an)"
FFMPEG="$(command -v ffmpeg)"

# Test sigma values
SIGMAS=(2 3 4 6 8 10 15)

# NLMeans h values to test per sigma
H_VALUES=(0.4 0.6 0.8 1.0 1.2 1.4 1.6 1.8 2.0 2.4 2.8 3.2 3.6 4.0 4.5 5.0)

# Photon-noise values to test
PN_VALUES=(2 4 6 8 10 12 14 16 18 20 25 30 35 40)

# Duration of test clips in frames (5 seconds at 24fps)
TEST_FRAMES=120

echo "=== Grain Calibration ==="
echo "Work dir: $WORKDIR"
echo "Sigmas: ${SIGMAS[*]}"
echo ""

# ── Phase 1: Generate clean reference + noisy clips ──────────────────

echo "--- Phase 1: Generating test clips ---"

# Generate a clean 1080p reference clip with some spatial detail
CLEAN_VPY="$WORKDIR/clean.vpy"
CLEAN_Y4M="$WORKDIR/clean.y4m"
cat > "$CLEAN_VPY" << 'PYVPY'
import vapoursynth as vs
core = vs.core
# Use ColorBars for spatial detail, convert to YUV420P8
clip = core.std.BlankClip(width=1920, height=1080, format=vs.YUV420P8, length=120, color=[128,128,128])
# Add some spatial variation via noise at very low level for texture
import random
clip.set_output()
PYVPY

# Actually, better: use a gradient pattern for measurable detail
cat > "$CLEAN_VPY" << 'PYVPY'
import vapoursynth as vs
core = vs.core
clip = core.std.BlankClip(width=1920, height=1080, format=vs.YUV420P8, length=120)
# Create horizontal gradient for spatial detail
clip = core.std.Expr(clip, expr=["x 1920 / 255 *", "", ""])
clip.set_output()
PYVPY

"$VSPIPE" -c y4m "$CLEAN_VPY" "$CLEAN_Y4M"
echo "Clean reference: $CLEAN_Y4M"

for SIGMA in "${SIGMAS[@]}"; do
  echo "Generating noisy clip sigma=$SIGMA..."
  NOISY_VPY="$WORKDIR/noisy_s${SIGMA}.vpy"
  NOISY_Y4M="$WORKDIR/noisy_s${SIGMA}.y4m"

  cat > "$NOISY_VPY" << PYVPY
import vapoursynth as vs
core = vs.core
clip = core.std.BlankClip(width=1920, height=1080, format=vs.YUV420P8, length=120)
clip = core.std.Expr(clip, expr=["x 1920 / 255 *", "", ""])
# Add Gaussian noise using std.MakeDiff + noise generation
# AddGrain from grain plugin or use Expr with frame-dependent random
# Fallback: use core.grain.Add if available
try:
    clip = core.grain.Add(clip, var=${SIGMA}.0, uvar=${SIGMA}.0/2)
except:
    pass
clip.set_output()
PYVPY

  "$VSPIPE" -c y4m "$NOISY_VPY" "$NOISY_Y4M" 2>/dev/null || echo "  WARNING: noisy clip generation failed for sigma=$SIGMA"
done

# ── Phase 2: Find optimal NLMeans h per sigma ────────────────────────

echo ""
echo "--- Phase 2: Calibrating NLMeans h ---"
echo "sigma,h,psnr" > "$WORKDIR/denoise_results.csv"

for SIGMA in "${SIGMAS[@]}"; do
  NOISY_Y4M="$WORKDIR/noisy_s${SIGMA}.y4m"
  [ -f "$NOISY_Y4M" ] || continue

  BEST_H=""
  BEST_PSNR=0

  for H in "${H_VALUES[@]}"; do
    DENOISED_Y4M="$WORKDIR/denoised_s${SIGMA}_h${H}.y4m"
    DENOISE_VPY="$WORKDIR/denoise_s${SIGMA}_h${H}.vpy"

    cat > "$DENOISE_VPY" << PYVPY
import vapoursynth as vs
core = vs.core
clip = core.lsmas.LWLibavSource(source='${NOISY_Y4M}')
clip = core.nlm_ispc.NLMeans(clip, d=1, a=2, s=4, h=${H}, channels="Y")
clip = core.nlm_ispc.NLMeans(clip, d=1, a=2, s=4, h=$(echo "$H * 0.5" | bc), channels="UV")
clip.set_output()
PYVPY

    "$VSPIPE" -c y4m "$DENOISE_VPY" "$DENOISED_Y4M" 2>/dev/null || continue

    # Measure PSNR vs clean reference
    PSNR=$("$FFMPEG" -i "$CLEAN_Y4M" -i "$DENOISED_Y4M" \
      -lavfi "psnr=stats_file=-" -f null - 2>&1 | \
      grep -oP 'average:\K[\d.]+' || echo "0")

    echo "$SIGMA,$H,$PSNR" >> "$WORKDIR/denoise_results.csv"

    if [ "$(echo "$PSNR > $BEST_PSNR" | bc -l)" = "1" ]; then
      BEST_PSNR="$PSNR"
      BEST_H="$H"
    fi

    rm -f "$DENOISED_Y4M" "$DENOISE_VPY"
  done

  echo "  sigma=$SIGMA -> optimal h=$BEST_H (PSNR=$BEST_PSNR)"
done

# ── Phase 3: Find photon-noise value matching original sigma ─────────

echo ""
echo "--- Phase 3: Calibrating photon-noise ---"
echo "sigma,photon_noise,output_sigma" > "$WORKDIR/photon_results.csv"

for SIGMA in "${SIGMAS[@]}"; do
  NOISY_Y4M="$WORKDIR/noisy_s${SIGMA}.y4m"
  [ -f "$NOISY_Y4M" ] || continue

  # Use the optimal h from phase 2 to denoise
  BEST_H=$(grep "^$SIGMA," "$WORKDIR/denoise_results.csv" | sort -t, -k3 -rn | head -1 | cut -d, -f2)
  [ -z "$BEST_H" ] && continue

  DENOISED_VPY="$WORKDIR/best_denoise_s${SIGMA}.vpy"
  DENOISED_Y4M="$WORKDIR/best_denoised_s${SIGMA}.y4m"

  cat > "$DENOISED_VPY" << PYVPY
import vapoursynth as vs
core = vs.core
clip = core.lsmas.LWLibavSource(source='${NOISY_Y4M}')
clip = core.nlm_ispc.NLMeans(clip, d=1, a=2, s=4, h=${BEST_H}, channels="Y")
clip = core.nlm_ispc.NLMeans(clip, d=1, a=2, s=4, h=$(echo "$BEST_H * 0.5" | bc), channels="UV")
clip.set_output()
PYVPY

  "$VSPIPE" -c y4m "$DENOISED_VPY" "$DENOISED_Y4M" 2>/dev/null || continue

  BEST_PN=""
  BEST_DIFF=999

  for PN in "${PN_VALUES[@]}"; do
    ENCODED="$WORKDIR/encoded_s${SIGMA}_pn${PN}.mkv"
    ENCODE_WORK="$WORKDIR/av1an_s${SIGMA}_pn${PN}"
    mkdir -p "$ENCODE_WORK"

    # Quick single-worker encode with photon noise
    "$AV1AN" -i "$DENOISED_Y4M" -o "$ENCODED" \
      --temp "$ENCODE_WORK" \
      -e svt-av1 \
      -v "--crf 30 --preset 8 --film-grain 0 --film-grain-denoise 0" \
      --photon-noise "$PN" --chroma-noise \
      --workers 1 \
      2>/dev/null || continue

    # Decode and measure apparent noise sigma
    DECODED_Y4M="$WORKDIR/decoded_s${SIGMA}_pn${PN}.y4m"
    "$FFMPEG" -i "$ENCODED" -pix_fmt yuv420p "$DECODED_Y4M" -y 2>/dev/null || continue

    # Use our noise estimation VPY to measure output sigma
    MEASURE_VPY="$WORKDIR/measure_s${SIGMA}_pn${PN}.vpy"
    cat > "$MEASURE_VPY" << PYVPY
import vapoursynth as vs
import sys
core = vs.core
clip = core.lsmas.LWLibavSource(source='${DECODED_Y4M}')
luma = core.std.ShufflePlanes(clip, planes=0, colorfamily=vs.GRAY)
d = core.std.Expr([luma[:-1], luma[1:]], expr=['x y - abs'])
d = core.std.PlaneStats(d)
def emit(n, f):
    avg = f.props["PlaneStatsAverage"]
    sigma = avg * 255.0 * 1.2533 / 1.4142
    sys.stderr.write("SIGMA:{:.6f}\n".format(sigma))
    sys.stderr.flush()
    return f
out = core.std.ModifyFrame(d, d, emit)
out.set_output()
PYVPY

    OUTPUT_SIGMA=$("$VSPIPE" -p "$MEASURE_VPY" -- 2>&1 | \
      grep -oP 'SIGMA:\K[\d.]+' | \
      awk '{ sum += $1; n++ } END { if (n>0) print sum/n; else print 0 }')

    DIFF=$(echo "($OUTPUT_SIGMA - $SIGMA)" | bc -l | tr -d '-')

    echo "$SIGMA,$PN,$OUTPUT_SIGMA" >> "$WORKDIR/photon_results.csv"

    if [ "$(echo "$DIFF < $BEST_DIFF" | bc -l)" = "1" ]; then
      BEST_DIFF="$DIFF"
      BEST_PN="$PN"
    fi

    rm -f "$ENCODED" "$DECODED_Y4M" "$MEASURE_VPY"
    rm -rf "$ENCODE_WORK"
  done

  echo "  sigma=$SIGMA -> photon-noise=$BEST_PN (diff=$BEST_DIFF)"
  rm -f "$DENOISED_Y4M" "$DENOISED_VPY"
done

# ── Summary ──────────────────────────────────────────────────────────

echo ""
echo "=== RESULTS ==="
echo ""
echo "DENOISE_CURVE (paste into grainSynth.js):"
echo "const DENOISE_CURVE = ["
for SIGMA in "${SIGMAS[@]}"; do
  BEST_H=$(grep "^$SIGMA," "$WORKDIR/denoise_results.csv" | sort -t, -k3 -rn | head -1 | cut -d, -f2)
  [ -z "$BEST_H" ] && continue
  echo "  { sigma: $SIGMA, h: $BEST_H },"
done
echo "];"
echo ""
echo "PHOTON_CURVE (paste into grainSynth.js):"
echo "const PHOTON_CURVE = ["
for SIGMA in "${SIGMAS[@]}"; do
  BEST_PN=$(grep "^$SIGMA," "$WORKDIR/photon_results.csv" | \
    awk -F, -v s="$SIGMA" '{ diff = ($3 - s)^2; print diff, $2 }' | \
    sort -n | head -1 | awk '{print $2}')
  [ -z "$BEST_PN" ] && continue
  echo "  { sigma: $SIGMA, param: $BEST_PN },"
done
echo "];"

echo ""
echo "Raw data in: $WORKDIR/denoise_results.csv and $WORKDIR/photon_results.csv"
echo "Done."
```

- [ ] **Step 2: Make executable**

```bash
chmod +x test/calibrate-grain.sh
```

- [ ] **Step 3: Commit**

```bash
git add test/calibrate-grain.sh
git commit -m "feat: add grain calibration script for NLMeans h + photon-noise curve derivation"
```

---

### Task 8: Build, deploy, and smoke test

**Files:** None (verification only)

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: All plugins build without errors

- [ ] **Step 2: Deploy to test instance**

Run: `npm run deploy`
Expected: Bundled plugins copied to test instance

- [ ] **Step 3: Run a quick encode with grain_synth enabled on av1anEncode**

Use the Tdarr UI to queue a short test file with `grain_synth: true` on the `av1anEncode` plugin. Check the job log for:
- `[grain] detected sigma=...` — noise estimation ran
- `[grain] nlm_ispc plugin verified` — plugin availability check passed
- `.vpy written (NLMeans denoise)` — NLMeans injected into VS script
- `--photon-noise N --chroma-noise` visible in the av1an command line
- No `--denoise-noise-level` or `--film-grain` in encoder flags
- `--enable-dnl-denoising=0` present in aom flags
- `--film-grain 0 --film-grain-denoise 0` present in SVT flags

- [ ] **Step 4: Run a quick encode with grain_synth disabled**

Verify no NLMeans in the `.vpy`, no `--photon-noise` in args, encoder flags still have denoise disabled.

- [ ] **Step 5: Commit any fixes found during smoke test**

- [ ] **Step 6: Push to dev**

```bash
git push origin dev
```

---

### Task 9: Run calibration and update curves

**Files:**
- Modify: `src/shared/grainSynth.js` (update `DENOISE_CURVE` and `PHOTON_CURVE`)

- [ ] **Step 1: Run calibration script in Docker**

```bash
docker exec -it tdarr-interactive-node bash /path/to/test/calibrate-grain.sh /tmp/grain-cal
```

Expected: Script outputs `DENOISE_CURVE` and `PHOTON_CURVE` arrays

- [ ] **Step 2: Update `grainSynth.js` with calibrated values**

Replace the placeholder `DENOISE_CURVE` and `PHOTON_CURVE` arrays with the calibration output.

- [ ] **Step 3: Rebuild and deploy**

Run: `npm run deploy`

- [ ] **Step 4: Re-test with calibrated values**

Queue another test encode, verify the NLMeans `h` and `photon-noise` values in the log look reasonable.

- [ ] **Step 5: Commit**

```bash
git add src/shared/grainSynth.js
git commit -m "tune(grainSynth): update DENOISE_CURVE and PHOTON_CURVE with calibrated values"
```

- [ ] **Step 6: Push to dev**

```bash
git push origin dev
```
