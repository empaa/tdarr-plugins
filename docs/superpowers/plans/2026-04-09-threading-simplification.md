# Threading Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the manual thread strategy system and hybrid chunking, letting av1an/ab-av1 use their built-in defaults.

**Architecture:** Pure deletion — strip thread budget code from `encoderFlags.js`, remove thread-related inputs/logic from all three plugins, remove hybrid chunk method flags. No new code beyond simplifying existing expressions.

**Tech Stack:** Node.js, esbuild (build verification)

**Spec:** `docs/superpowers/specs/2026-04-09-threading-simplification-design.md`

---

### Task 1: Strip threading from `encoderFlags.js`

**Files:**
- Modify: `src/shared/encoderFlags.js`

- [ ] **Step 1: Remove thread budget system**

Delete these blocks entirely:
- `SVT_LP_CAP_BY_PRESET` constant (lines 163-171)
- `capSvtLpByPreset()` function (lines 173-176)
- `THREAD_PRESETS` constant (lines 178-183)
- `resolveThreadStrategy()` function (lines 185-190)
- `calculateThreadBudget()` function (lines 192-232)

- [ ] **Step 2: Remove `threadsPerWorker` from `buildAomFlags()`**

Change signature and remove `--threads` flag:

```js
const buildAomFlags = (preset, hdrAom) => {
  return [
    '--end-usage=q', `--cpu-used=${preset}`,
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

- [ ] **Step 3: Remove `lp` from `svtConfig()`**

Change signature and remove conditional lp entry:

```js
const svtConfig = (preset, hdrSvt) => {
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
  ];
  return { entries, hdrSvt };
};
```

- [ ] **Step 4: Update downstream functions**

`buildSvtFlags` — drop `svtLp` param:
```js
const buildSvtFlags = (preset, hdrSvt) =>
  formatSvtForAv1an(svtConfig(preset, hdrSvt));
```

`buildAbAv1SvtFlags` — drop `lp` param:
```js
const buildAbAv1SvtFlags = () => {
  const cfg = svtConfig(0, '');
  const skip = new Set(['rc', 'preset', 'input-depth', 'keyint']);
  const filtered = { entries: cfg.entries.filter(([k]) => !skip.has(k)), hdrSvt: '' };
  return [formatSvtForAbAv1(filtered), '--keyint 10s', '--scd true'].join(' ');
};
```

`buildAbAv1AomFlags` — drop `threadsPerWorker` param (was already unused):
```js
const buildAbAv1AomFlags = (preset, hdrAom) => {
```

- [ ] **Step 5: Update `module.exports`**

```js
module.exports = {
  detectHdrMeta,
  buildAomFlags,
  buildSvtFlags,
  buildAbAv1SvtFlags,
  buildAbAv1AomFlags,
};
```

- [ ] **Step 6: Build to verify**

Run: `npm run build`
Expected: Build succeeds (will show import warnings for plugins not yet updated — that's fine, they're next)

- [ ] **Step 7: Commit**

```bash
git add src/shared/encoderFlags.js
git commit -m "refactor: strip thread budget system from encoderFlags"
```

---

### Task 2: Simplify `av1anEncode` plugin

**Files:**
- Modify: `src/av1anEncode/index.js`
- Modify: `src/av1anEncode/e2e-tests.json`

- [ ] **Step 1: Remove thread_strategy and thread_overrides inputs**

Delete these two input objects from the `details()` inputs array (lines 76-90):

```js
    {
      label: 'Thread Strategy',
      name: 'thread_strategy',
      ...
    },
    {
      label: 'Thread Overrides (JSON)',
      name: 'thread_overrides',
      ...
    },
```

- [ ] **Step 2: Simplify imports**

Change line 105 from:
```js
  const { detectHdrMeta, buildAomFlags, buildSvtFlags, calculateThreadBudget } = require('../shared/encoderFlags');
```
to:
```js
  const { detectHdrMeta, buildAomFlags, buildSvtFlags } = require('../shared/encoderFlags');
```

Remove the `os` import (line 101):
```js
  const os   = require('os');
```

- [ ] **Step 3: Delete thread budget code**

Delete all of these (lines 119-127, 159, 168-175):
```js
  const threadStrategy    = String(inputs.thread_strategy || 'safe');
  let threadOverrides = {};
  let threadOverridesError = null;
  const rawOverrides = String(inputs.thread_overrides || '').trim();
  if (rawOverrides) {
    try { threadOverrides = JSON.parse(rawOverrides); } catch (e) {
      threadOverridesError = e.message;
    }
  }
```

```js
  const availableThreads = os.cpus().length;
```

```js
  const isAutoThreads = threadStrategy === 'auto';
  const is4kHdr = height >= 2160 && stream.color_transfer === 'smpte2084';
  const { maxWorkers, threadsPerWorker, svtLp, vmafThreads } = isAutoThreads
    ? { maxWorkers: null, threadsPerWorker: null, svtLp: null, vmafThreads: null }
    : calculateThreadBudget(
      availableThreads, encoder, is4kHdr,
      { strategy: threadStrategy, ...threadOverrides, encPreset },
    );
```

Also delete the threadOverridesError warning (lines 143-145):
```js
  if (threadOverridesError) {
    jobLog(`WARNING: invalid thread_overrides JSON, falling back to aggressive: ${threadOverridesError}`);
  }
```

- [ ] **Step 4: Simplify encoder flag building**

Replace the isAutoThreads branching (lines 187-195):
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

With:
```js
  const encFlags = encoder === 'aom'
    ? buildAomFlags(encPreset, hdrAom)
    : buildSvtFlags(encPreset, hdrSvt);
```

- [ ] **Step 5: Simplify av1an args and log lines**

Delete the threads log line (line 203):
```js
  jobLog(`  threads    : cpu=${availableThreads}  workers=...`);
```

In the av1an args array, remove these three lines:
```js
    '--chunk-method', 'hybrid',
    '--ignore-frame-mismatch',
    ...(isAutoThreads ? [] : ['--workers', String(maxWorkers)]),
```
and:
```js
    ...(isAutoThreads ? [] : ['--vmaf-threads', String(vmafThreads)]),
```

- [ ] **Step 6: Remove thread_strategy from e2e tests**

Update `src/av1anEncode/e2e-tests.json` — remove `"thread_strategy": "auto"` from both test objects:

```json
[
  {
    "name": "aom default",
    "inputs": {
      "encoder": "aom",
      "target_vmaf": "93",
      "preset": "6",
      "max_encoded_percent": "100"
    }
  },
  {
    "name": "svt-av1 default",
    "inputs": {
      "encoder": "svt-av1",
      "target_vmaf": "93",
      "preset": "6",
      "max_encoded_percent": "100"
    }
  }
]
```

- [ ] **Step 7: Build to verify**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 8: Commit**

```bash
git add src/av1anEncode/index.js src/av1anEncode/e2e-tests.json
git commit -m "refactor(av1anEncode): remove thread strategy and hybrid chunking"
```

---

### Task 3: Simplify `abAv1Encode` plugin

**Files:**
- Modify: `src/abAv1Encode/index.js`
- Modify: `src/abAv1Encode/e2e-tests.json`

- [ ] **Step 1: Remove thread_strategy and thread_overrides inputs**

Delete the two input objects from details() (lines 76-90).

- [ ] **Step 2: Simplify imports**

Change line 105 from:
```js
  const { detectHdrMeta, buildAbAv1SvtFlags, calculateThreadBudget } = require('../shared/encoderFlags');
```
to:
```js
  const { detectHdrMeta, buildAbAv1SvtFlags } = require('../shared/encoderFlags');
```

Keep the `os` import — still needed for vmaf n_threads.

- [ ] **Step 3: Delete thread budget code**

Delete all of these:
```js
  const threadStrategy    = String(inputs.thread_strategy || 'safe');
  let threadOverrides = {};
  let threadOverridesError = null;
  const rawOverrides = String(inputs.thread_overrides || '').trim();
  if (rawOverrides) {
    try { threadOverrides = JSON.parse(rawOverrides); } catch (e) {
      threadOverridesError = e.message;
    }
  }
```

```js
  if (threadOverridesError) {
    jobLog(`WARNING: invalid thread_overrides JSON, falling back to aggressive: ${threadOverridesError}`);
  }
```

```js
  const isAutoThreads = threadStrategy === 'auto';
  const is4kHdr = height >= 2160 && stream.color_transfer === 'smpte2084';
  const { svtLp, vmafThreads } = isAutoThreads
    ? { svtLp: null, vmafThreads: null }
    : calculateThreadBudget(
      availableThreads, 'svt-av1', is4kHdr,
      { strategy: threadStrategy, ...threadOverrides, singleProcess: true, encPreset },
    );
```

- [ ] **Step 4: Simplify SVT flags and vmaf threads**

Replace the isAutoThreads branching for svtFlags (lines 180-182):
```js
  const svtFlags = isAutoThreads
    ? buildAbAv1SvtFlags(0).replace(/--svt lp=\d+\s*/, '')
    : buildAbAv1SvtFlags(svtLp);
```
With:
```js
  const svtFlags = buildAbAv1SvtFlags();
```

For the vmaf `--vmaf` arg (line 207), replace `vmafThreads` with `os.cpus().length`:
```js
    '--vmaf', `n_threads=${os.cpus().length}:model=path=${vmafModel}`,
```

- [ ] **Step 5: Simplify log lines**

Delete the threads log line (line 193):
```js
  jobLog(`  threads    : cpu=${availableThreads}  lp=${isAutoThreads ? 'auto' : svtLp}  strategy=${threadStrategy}`);
```

Remove `availableThreads` variable (line 171) — no longer used since vmaf now uses `os.cpus().length` directly.

- [ ] **Step 6: Remove thread_strategy from e2e tests**

Update `src/abAv1Encode/e2e-tests.json`:

```json
[
  {
    "name": "default",
    "inputs": {
      "target_vmaf": "93",
      "preset": "6"
    }
  }
]
```

- [ ] **Step 7: Build to verify**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 8: Commit**

```bash
git add src/abAv1Encode/index.js src/abAv1Encode/e2e-tests.json
git commit -m "refactor(abAv1Encode): remove thread strategy"
```

---

### Task 4: Simplify `crfSearchEncode` plugin

**Files:**
- Modify: `src/crfSearchEncode/index.js`
- Modify: `src/crfSearchEncode/e2e-tests.json`

- [ ] **Step 1: Remove thread_strategy and thread_overrides inputs**

Delete the two input objects from details() (lines 83-98).

- [ ] **Step 2: Simplify imports**

Change lines 113-116 from:
```js
  const {
    detectHdrMeta, buildAomFlags, buildSvtFlags,
    buildAbAv1SvtFlags, buildAbAv1AomFlags, calculateThreadBudget,
  } = require('../shared/encoderFlags');
```
to:
```js
  const {
    detectHdrMeta, buildAomFlags, buildSvtFlags,
    buildAbAv1SvtFlags, buildAbAv1AomFlags,
  } = require('../shared/encoderFlags');
```

Keep the `os` import — still needed for vmaf n_threads.

- [ ] **Step 3: Delete thread budget code**

Delete all of these:
```js
  const threadStrategy    = String(inputs.thread_strategy || 'safe');
  let threadOverrides = {};
  let threadOverridesError = null;
  const rawOverrides = String(inputs.thread_overrides || '').trim();
  if (rawOverrides) {
    try { threadOverrides = JSON.parse(rawOverrides); } catch (e) {
      threadOverridesError = e.message;
    }
  }
```

```js
  if (threadOverridesError) {
    jobLog(`WARNING: invalid thread_overrides JSON, falling back to aggressive: ${threadOverridesError}`);
  }
```

```js
  const isAutoThreads = threadStrategy === 'auto';
  const is4kHdr = height >= 2160 && stream.color_transfer === 'smpte2084';

  // Phase 1 thread budget: single-process for CRF search
  const searchBudget = isAutoThreads
    ? { svtLp: null, vmafThreads: null }
    : calculateThreadBudget(
      availableThreads, encoder === 'aom' ? 'aom' : 'svt-av1', is4kHdr,
      { strategy: threadStrategy, ...threadOverrides, singleProcess: true, encPreset },
    );

  // Phase 2 thread budget: multi-worker for av1an encode
  const encodeBudget = isAutoThreads
    ? { maxWorkers: null, threadsPerWorker: null, svtLp: null, vmafThreads: null }
    : calculateThreadBudget(
      availableThreads, encoder, is4kHdr,
      { strategy: threadStrategy, ...threadOverrides, encPreset },
    );
```

- [ ] **Step 4: Simplify log lines**

Delete the threads log line and simplify phase log lines. Replace:
```js
  jobLog(`  threads    : cpu=${availableThreads}  strategy=${threadStrategy}`);
  jobLog(`  phase 1    : ab-av1 crf-search (single-process, lp=${isAutoThreads ? 'auto' : searchBudget.svtLp})`);
  jobLog(`  phase 2    : av1an fixed-CRF (workers=${isAutoThreads ? 'auto' : encodeBudget.maxWorkers}, threads/worker=${isAutoThreads ? 'auto' : encodeBudget.threadsPerWorker})`);
```
With:
```js
  jobLog(`  phase 1    : ab-av1 crf-search`);
  jobLog(`  phase 2    : av1an fixed-CRF`);
```

- [ ] **Step 5: Simplify phase 1 (CRF search) encoder flags**

Replace lines 230-238:
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
With:
```js
  const searchEncFlags = encoder === 'aom'
    ? buildAbAv1AomFlags(encPreset, hdrAom)
    : buildAbAv1SvtFlags();
```

Replace line 241:
```js
  const searchVmafThreads = isAutoThreads ? availableThreads : searchBudget.vmafThreads;
```
With:
```js
  const searchVmafThreads = os.cpus().length;
```

- [ ] **Step 6: Simplify phase 2 (av1an encode) encoder flags**

Replace lines 361-376:
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
With:
```js
  const encFlags = encoder === 'aom'
    ? buildAomFlags(encPreset, hdrAom) + ` --cq-level=${foundCrf}`
    : buildSvtFlags(encPreset, hdrSvt) + ` --crf ${foundCrf}`;
```

- [ ] **Step 7: Simplify av1an args**

In the av1an args array (lines 380-395), remove:
```js
    '--chunk-method', 'hybrid',
    '--ignore-frame-mismatch',
    ...(isAutoThreads ? [] : ['--workers', String(encodeBudget.maxWorkers)]),
```

Remove `availableThreads` variable — no longer used since `searchVmafThreads` now uses `os.cpus().length` directly.

- [ ] **Step 8: Remove thread_strategy from e2e tests**

Update `src/crfSearchEncode/e2e-tests.json`:

```json
[
  {
    "name": "aom cpu-used 8",
    "inputs": {
      "encoder": "aom",
      "target_vmaf": "93",
      "preset": "8",
      "max_encoded_percent": "100"
    }
  },
  {
    "name": "svt-av1 cpu-used 8",
    "inputs": {
      "encoder": "svt-av1",
      "target_vmaf": "93",
      "preset": "8",
      "max_encoded_percent": "100"
    }
  }
]
```

- [ ] **Step 9: Build to verify**

Run: `npm run build`
Expected: Build succeeds

- [ ] **Step 10: Commit**

```bash
git add src/crfSearchEncode/index.js src/crfSearchEncode/e2e-tests.json
git commit -m "refactor(crfSearchEncode): remove thread strategy and hybrid chunking"
```

---

### Task 5: Final build verification and push

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: Clean build, no warnings

- [ ] **Step 2: Verify no leftover references**

Run: `grep -r "thread_strategy\|threadStrategy\|calculateThreadBudget\|THREAD_PRESETS\|isAutoThreads\|threadOverrides\|chunk-method.*hybrid\|ignore-frame-mismatch" src/`
Expected: No matches

- [ ] **Step 3: Push to dev**

```bash
git push origin dev
```
