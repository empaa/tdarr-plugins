# Thread & Worker Budget Optimization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users choose a thread/worker strategy (safe/balanced/aggressive/max/custom) and benchmark configs against real encodes via docker exec.

**Architecture:** Extend `calculateThreadBudget` with preset profiles and override support. Add two new plugin inputs to both plugins. Build a standalone benchmark script that runs av1an/ab-av1 inside the Tdarr container via `docker exec` and collects wall-clock, FPS, CPU%, and memory metrics via `docker stats`.

**Tech Stack:** Node.js, child_process (spawn), Docker CLI

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/shared/encoderFlags.js` | Preset profiles, refactored `calculateThreadBudget`, `resolveThreadStrategy` helper |
| `src/av1anEncode/index.js` | New inputs (`thread_strategy`, `thread_overrides`), pass strategy to thread budget |
| `src/abAv1Encode/index.js` | Same new inputs, map overrides to `lp` |
| `test/benchmark.js` | Benchmark runner — grid generation, docker exec orchestration, metrics, table output |
| `package.json` | Add `benchmark` script |

---

### Task 1: Add Preset Profiles and Strategy Support to encoderFlags.js

**Files:**
- Modify: `src/shared/encoderFlags.js:116-134`

- [ ] **Step 1: Write the preset profiles object**

Add above `calculateThreadBudget` (after line 114):

```js
const THREAD_PRESETS = {
  safe:        { aomTpwRatio: 4, aomTpwMin: 4, svtTpwRatio: 6, svtTpwMin: 4, svtTpwMax: 6, svtLpMax: 6,  vmafThreadDiv: 8, halve4kHdr: true },
  balanced:    { aomTpwRatio: 8, aomTpwMin: 2, svtTpwRatio: 5, svtTpwMin: 4, svtTpwMax: 8, svtLpMax: 12, vmafThreadDiv: 4, halve4kHdr: false },
  aggressive:  { aomTpwRatio: 8, aomTpwMin: 2, svtTpwRatio: 5, svtTpwMin: 3, svtTpwMax: 6, svtLpMax: 20, vmafThreadDiv: 3, halve4kHdr: false },
  max:         { aomTpwRatio: 10, aomTpwMin: 1, svtTpwRatio: 4, svtTpwMin: 2, svtTpwMax: 4, svtLpMax: 28, vmafThreadDiv: 2, halve4kHdr: false },
};
```

- [ ] **Step 2: Refactor calculateThreadBudget to accept options**

Replace `calculateThreadBudget` (lines 116-134) with:

```js
const resolveThreadStrategy = (strategyName, overrides) => {
  const base = strategyName === 'custom'
    ? THREAD_PRESETS.aggressive
    : (THREAD_PRESETS[strategyName] || THREAD_PRESETS.safe);
  return { preset: base, overrides: overrides || {} };
};

const calculateThreadBudget = (availableThreads, encoder, is4kHdr, options) => {
  const opts = options || {};
  const strategyName = opts.strategy || 'safe';
  const { preset, overrides } = resolveThreadStrategy(strategyName, opts);

  let threadsPerWorker, maxWorkers;

  if (encoder === 'aom') {
    threadsPerWorker = Math.max(preset.aomTpwMin, Math.floor(availableThreads / preset.aomTpwRatio));
    maxWorkers = Math.max(1, Math.floor(availableThreads / threadsPerWorker));
  } else {
    threadsPerWorker = Math.min(preset.svtTpwMax, Math.max(preset.svtTpwMin, Math.floor(availableThreads / preset.svtTpwRatio)));
    maxWorkers = Math.max(1, Math.floor(availableThreads / threadsPerWorker));
  }

  if (is4kHdr && preset.halve4kHdr) {
    maxWorkers = Math.max(1, Math.floor(maxWorkers / 2));
  }

  const svtLp = Math.min(preset.svtLpMax, threadsPerWorker);
  let vmafThreads = Math.max(2, Math.floor(availableThreads / preset.vmafThreadDiv));

  // Apply explicit overrides
  if (overrides.workers != null) maxWorkers = overrides.workers;
  if (overrides.threadsPerWorker != null) threadsPerWorker = overrides.threadsPerWorker;
  if (overrides.vmafThreads != null) vmafThreads = overrides.vmafThreads;

  return { maxWorkers, threadsPerWorker, svtLp, vmafThreads, strategy: strategyName };
};
```

- [ ] **Step 3: Export THREAD_PRESETS**

Update the `module.exports` block at line 136:

```js
module.exports = {
  detectHdrMeta,
  buildAomFlags,
  buildSvtFlags,
  buildAbAv1SvtFlags,
  calculateThreadBudget,
  THREAD_PRESETS,
};
```

- [ ] **Step 4: Verify build still works**

Run: `npm run build`
Expected: Clean build, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/encoderFlags.js
git commit -m "feat: add thread strategy presets and override support to calculateThreadBudget"
```

---

### Task 2: Add Thread Strategy Inputs to av1anEncode

**Files:**
- Modify: `src/av1anEncode/index.js:18-75` (inputs array), `src/av1anEncode/index.js:89-134` (plugin body)

- [ ] **Step 1: Add new inputs to the inputs array**

After the `downscale_resolution` input (after line 73, before the closing `]` on line 75), add:

```js
    {
      label: 'Thread Strategy',
      name: 'thread_strategy',
      type: 'string',
      defaultValue: 'safe',
      inputUI: { type: 'dropdown', options: ['safe', 'balanced', 'aggressive', 'max', 'custom'] },
      tooltip: 'Controls thread/worker budget. safe=current conservative defaults. balanced=~70% CPU. aggressive=~90% CPU. max=saturate all cores. custom=use thread_overrides JSON.',
    },
    {
      label: 'Thread Overrides (JSON)',
      name: 'thread_overrides',
      type: 'string',
      defaultValue: '',
      inputUI: { type: 'text' },
      tooltip: 'Only used when Thread Strategy is "custom". JSON: {"workers":16,"threadsPerWorker":2,"vmafThreads":12}. Omitted keys fall back to aggressive preset.',
    },
```

- [ ] **Step 2: Parse the new inputs in the plugin body**

After `const downscaleRes` (line 101), add:

```js
  const threadStrategy    = String(inputs.thread_strategy || 'safe');
  const threadOverrides   = (() => {
    const raw = String(inputs.thread_overrides || '').trim();
    if (!raw) return {};
    try { return JSON.parse(raw); } catch (e) {
      jobLog(`WARNING: invalid thread_overrides JSON, falling back to aggressive: ${e.message}`);
      return {};
    }
  })();
```

Note: `jobLog` is not available yet at this point (it's created on line 116). Move the parse to after `jobLog` is created, or use a deferred approach. Better: parse the raw string now, log the warning later:

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

Then after `const { jobLog, dbg } = createLogger(...)` (line 116), add:

```js
  if (threadOverridesError) {
    jobLog(`WARNING: invalid thread_overrides JSON, falling back to aggressive: ${threadOverridesError}`);
  }
```

- [ ] **Step 3: Update the calculateThreadBudget call**

Replace line 134:
```js
  const { maxWorkers, threadsPerWorker, svtLp } = calculateThreadBudget(availableThreads, encoder, is4kHdr);
```

With:
```js
  const { maxWorkers, threadsPerWorker, svtLp, vmafThreads } = calculateThreadBudget(
    availableThreads, encoder, is4kHdr,
    { strategy: threadStrategy, ...threadOverrides },
  );
```

- [ ] **Step 4: Use vmafThreads from budget instead of hardcoded 4**

Replace `'--vmaf-threads', '4'` on line 202 with:
```js
    '--vmaf-threads', String(vmafThreads),
```

- [ ] **Step 5: Update the log line to show strategy**

Replace line 153:
```js
  jobLog(`  threads    : cpu=${availableThreads}  workers=${maxWorkers}  threads/worker=${threadsPerWorker}`);
```

With:
```js
  jobLog(`  threads    : cpu=${availableThreads}  workers=${maxWorkers}  threads/worker=${threadsPerWorker}  vmaf-threads=${vmafThreads}  strategy=${threadStrategy}`);
```

- [ ] **Step 6: Verify build**

Run: `npm run build`
Expected: Clean build, no errors.

- [ ] **Step 7: Commit**

```bash
git add src/av1anEncode/index.js
git commit -m "feat(av1an): add thread_strategy and thread_overrides plugin inputs"
```

---

### Task 3: Add Thread Strategy Inputs to abAv1Encode

**Files:**
- Modify: `src/abAv1Encode/index.js:18-75` (inputs array), `src/abAv1Encode/index.js:82-132` (plugin body)

- [ ] **Step 1: Add new inputs to the inputs array**

After the `downscale_resolution` input (after line 73, before the closing `]` on line 75), add:

```js
    {
      label: 'Thread Strategy',
      name: 'thread_strategy',
      type: 'string',
      defaultValue: 'safe',
      inputUI: { type: 'dropdown', options: ['safe', 'balanced', 'aggressive', 'max', 'custom'] },
      tooltip: 'Controls SVT-AV1 thread parallelism (lp). safe=current defaults. balanced=~70% CPU. aggressive=~90% CPU. max=saturate all cores. custom=use thread_overrides JSON.',
    },
    {
      label: 'Thread Overrides (JSON)',
      name: 'thread_overrides',
      type: 'string',
      defaultValue: '',
      inputUI: { type: 'text' },
      tooltip: 'Only used when Thread Strategy is "custom". JSON: {"threadsPerWorker":20}. Sets SVT-AV1 lp value. "workers" and "vmafThreads" are ignored for ab-av1.',
    },
```

- [ ] **Step 2: Parse the new inputs**

After `const downscaleRes` (line 100), add:

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

After `const { jobLog, dbg } = createLogger(...)` (line 107), add:

```js
  if (threadOverridesError) {
    jobLog(`WARNING: invalid thread_overrides JSON, falling back to aggressive: ${threadOverridesError}`);
  }
```

- [ ] **Step 3: Calculate thread budget for lp override**

After `detectHdrMeta(stream)` (line 122), add:

```js
  const is4kHdr = height >= 2160 && stream.color_transfer === 'smpte2084';
  const { svtLp } = calculateThreadBudget(
    availableThreads, 'svt-av1', is4kHdr,
    { strategy: threadStrategy, ...threadOverrides },
  );
```

- [ ] **Step 4: Update buildAbAv1SvtFlags call to use svtLp**

Replace line 132:
```js
  const svtFlags = buildAbAv1SvtFlags(availableThreads, lookahead);
```

With:
```js
  const svtFlags = buildAbAv1SvtFlags(svtLp, lookahead);
```

This works because `buildAbAv1SvtFlags` uses its first arg as `--svt lp=${Math.min(6, cpu)}` — but that `Math.min(6, ...)` cap needs to be removed now since `svtLp` already incorporates the preset's cap. Update `buildAbAv1SvtFlags` in `encoderFlags.js` line 112:

Replace:
```js
    `--svt lp=${Math.min(6, cpu)}`,
```

With:
```js
    `--svt lp=${cpu}`,
```

And rename the parameter for clarity — in `buildAbAv1SvtFlags` (line 103):

Replace:
```js
const buildAbAv1SvtFlags = (cpu, lookahead) => {
```

With:
```js
const buildAbAv1SvtFlags = (lp, lookahead) => {
```

And update line 112 accordingly:
```js
    `--svt lp=${lp}`,
```

- [ ] **Step 5: Update the import to include calculateThreadBudget**

Replace line 89:
```js
  const { detectHdrMeta, buildAbAv1SvtFlags } = require('../shared/encoderFlags');
```

With:
```js
  const { detectHdrMeta, buildAbAv1SvtFlags, calculateThreadBudget } = require('../shared/encoderFlags');
```

- [ ] **Step 6: Update the log line to show strategy**

Replace line 147:
```js
  jobLog(`  threads    : ${availableThreads}`);
```

With:
```js
  jobLog(`  threads    : cpu=${availableThreads}  lp=${svtLp}  strategy=${threadStrategy}`);
```

- [ ] **Step 7: Verify build**

Run: `npm run build`
Expected: Clean build, no errors.

- [ ] **Step 8: Commit**

```bash
git add src/abAv1Encode/index.js src/shared/encoderFlags.js
git commit -m "feat(ab-av1): add thread_strategy and thread_overrides plugin inputs"
```

---

### Task 4: Add E2E Test Scenarios for New Presets

**Files:**
- Modify: `src/av1anEncode/e2e-tests.json`
- Modify: `src/abAv1Encode/e2e-tests.json`

- [ ] **Step 1: Add balanced preset test to av1anEncode**

Replace the contents of `src/av1anEncode/e2e-tests.json`:

```json
[
  {
    "name": "svt-av1 default",
    "inputs": {
      "encoder": "svt-av1",
      "target_vmaf": "93",
      "preset": "8",
      "max_encoded_percent": "100",
      "downscale_enabled": "true",
      "downscale_resolution": "720p"
    }
  },
  {
    "name": "svt-av1 balanced strategy",
    "inputs": {
      "encoder": "svt-av1",
      "target_vmaf": "93",
      "preset": "8",
      "max_encoded_percent": "100",
      "downscale_enabled": "true",
      "downscale_resolution": "720p",
      "thread_strategy": "balanced"
    }
  }
]
```

- [ ] **Step 2: Add balanced preset test to abAv1Encode**

Replace the contents of `src/abAv1Encode/e2e-tests.json`:

```json
[
  {
    "name": "default",
    "inputs": {
      "target_vmaf": "93",
      "preset": "8"
    }
  },
  {
    "name": "balanced strategy",
    "inputs": {
      "target_vmaf": "93",
      "preset": "8",
      "thread_strategy": "balanced"
    }
  }
]
```

- [ ] **Step 3: Verify smoke tests pass**

Run: `npm run test:smoke`
Expected: All plugins pass metadata validation (new inputs have correct structure).

- [ ] **Step 4: Commit**

```bash
git add src/av1anEncode/e2e-tests.json src/abAv1Encode/e2e-tests.json
git commit -m "test: add e2e scenarios for balanced thread strategy"
```

---

### Task 5: Build the Benchmark Runner

**Files:**
- Create: `test/benchmark.js`
- Modify: `package.json`

- [ ] **Step 1: Create the benchmark script skeleton**

Create `test/benchmark.js`:

```js
#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CONTAINER = process.env.TDARR_CONTAINER || 'tdarr-node';
const SAMPLES_DIR = path.join(__dirname, 'samples');
const BENCH_TEMP = '/tmp/bench';

const PRESETS = ['safe', 'balanced', 'aggressive', 'max'];

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const gridMode = args.includes('--grid');
const presetFilter = (() => {
  const idx = args.indexOf('--preset');
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
})();
const sampleFilter = (() => {
  const idx = args.indexOf('--sample');
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
})();
const encoderArg = (() => {
  const idx = args.indexOf('--encoder');
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : 'aom';
})();
const presetNum = (() => {
  const idx = args.indexOf('--cpu-used');
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : '3';
})();

// ---------------------------------------------------------------------------
// Thread budget calculation (mirrors encoderFlags.js)
// ---------------------------------------------------------------------------
const THREAD_PRESETS = {
  safe:        { aomTpwRatio: 4, aomTpwMin: 4, svtTpwRatio: 6, svtTpwMin: 4, svtTpwMax: 6, svtLpMax: 6,  vmafThreadDiv: 8, halve4kHdr: true },
  balanced:    { aomTpwRatio: 8, aomTpwMin: 2, svtTpwRatio: 5, svtTpwMin: 4, svtTpwMax: 8, svtLpMax: 12, vmafThreadDiv: 4, halve4kHdr: false },
  aggressive:  { aomTpwRatio: 8, aomTpwMin: 2, svtTpwRatio: 5, svtTpwMin: 3, svtTpwMax: 6, svtLpMax: 20, vmafThreadDiv: 3, halve4kHdr: false },
  max:         { aomTpwRatio: 10, aomTpwMin: 1, svtTpwRatio: 4, svtTpwMin: 2, svtTpwMax: 4, svtLpMax: 28, vmafThreadDiv: 2, halve4kHdr: false },
};

function calcBudget(threads, encoder, preset) {
  const p = preset;
  let tpw, workers;
  if (encoder === 'aom') {
    tpw = Math.max(p.aomTpwMin, Math.floor(threads / p.aomTpwRatio));
    workers = Math.max(1, Math.floor(threads / tpw));
  } else {
    tpw = Math.min(p.svtTpwMax, Math.max(p.svtTpwMin, Math.floor(threads / p.svtTpwRatio)));
    workers = Math.max(1, Math.floor(threads / tpw));
  }
  const svtLp = Math.min(p.svtLpMax, tpw);
  const vmafThreads = Math.max(2, Math.floor(threads / p.vmafThreadDiv));
  return { workers, tpw, svtLp, vmafThreads };
}

// ---------------------------------------------------------------------------
// Grid generation
// ---------------------------------------------------------------------------
function generateGrid(threads) {
  const workerOptions = [2, 4, 6, 8, 10, 12, 16, 20, 24].filter((w) => w <= threads);
  const tpwOptions = [1, 2, 3, 4, 6, 8].filter((t) => t <= threads);
  const vmafOptions = [4, 8, 12, 16];
  const combos = [];
  for (const w of workerOptions) {
    for (const t of tpwOptions) {
      if (w * t <= threads * 1.25) {
        combos.push({ workers: w, tpw: t, svtLp: t, vmafThreads: Math.min(16, Math.floor(threads / 2)), label: `${w}w×${t}t` });
      }
    }
  }
  return combos;
}

// ---------------------------------------------------------------------------
// Docker helpers
// ---------------------------------------------------------------------------
function dockerExec(cmd, { timeout = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', ['exec', CONTAINER, 'bash', '-c', cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`docker exec timed out after ${timeout}ms`));
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    proc.on('error', reject);
  });
}

function startDockerStats() {
  const samples = [];
  const proc = spawn('docker', ['stats', CONTAINER, '--no-trunc', '--format', '{{.CPUPerc}}\t{{.MemUsage}}'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout.on('data', (d) => {
    for (const line of d.toString().split('\n').filter(Boolean)) {
      const parts = line.split('\t');
      if (parts.length >= 2) {
        const cpu = parseFloat(parts[0]);
        const memStr = parts[1].split('/')[0].trim();
        const mem = parseMemGiB(memStr);
        if (!isNaN(cpu) && !isNaN(mem)) {
          samples.push({ cpu, mem, ts: Date.now() });
        }
      }
    }
  });

  return {
    stop() {
      proc.kill('SIGTERM');
      if (samples.length === 0) return { avgCpu: 0, peakCpu: 0, peakMem: 0 };
      const avgCpu = samples.reduce((s, x) => s + x.cpu, 0) / samples.length;
      const peakCpu = Math.max(...samples.map((x) => x.cpu));
      const peakMem = Math.max(...samples.map((x) => x.mem));
      return { avgCpu, peakCpu, peakMem };
    },
  };
}

function parseMemGiB(str) {
  const match = str.match(/([\d.]+)\s*(GiB|MiB|KiB|B)/i);
  if (!match) return NaN;
  const val = parseFloat(match[1]);
  switch (match[2].toLowerCase()) {
    case 'gib': return val;
    case 'mib': return val / 1024;
    case 'kib': return val / (1024 * 1024);
    default: return val / (1024 * 1024 * 1024);
  }
}

// ---------------------------------------------------------------------------
// Benchmark runners
// ---------------------------------------------------------------------------
async function benchAv1an(samplePath, config, encoder, cpuUsed) {
  const containerSample = `/samples/${path.basename(samplePath)}`;
  const tempDir = `${BENCH_TEMP}/${config.label || 'run'}`;

  const vpyScript = [
    'import vapoursynth as vs',
    'core = vs.core',
    `core.lsmas.LWLibavSource(source=\\"${containerSample}\\").set_output()`,
  ].join('\\n');

  const encFlags = encoder === 'aom'
    ? `--end-usage=q --cpu-used=${cpuUsed} --threads=${config.tpw} --tune=ssim --bit-depth=10 --lag-in-frames=48 --tile-columns=0 --tile-rows=0 --sb-size=dynamic --aq-mode=0 --enable-qm=1`
    : `--rc 0 --preset ${cpuUsed} --lp ${config.svtLp} --tile-columns 1 --input-depth 10 --lookahead 48 --keyint -1 --enable-variance-boost 1 --variance-boost-strength 2 --variance-octile 6 --enable-overlays 1`;

  const cmd = [
    `mkdir -p ${tempDir}`,
    `printf '${vpyScript}\\n' > ${tempDir}/bench.vpy`,
    `av1an -i ${tempDir}/bench.vpy -o ${tempDir}/out.mkv --temp ${tempDir}/work`,
    `-c mkvmerge -e ${encoder === 'aom' ? 'aom' : 'svt-av1'}`,
    `--workers ${config.workers} --vmaf-threads ${config.vmafThreads}`,
    `--vmaf-path /usr/local/share/vmaf/vmaf_v0.6.1.json`,
    `--sc-downscale-height 540 --chunk-order long-to-short`,
    `--target-quality 93 --qp-range 10-50 --probes 6`,
    `--verbose --resume`,
    `-v "${encFlags}"`,
  ].join(' ');

  const stats = startDockerStats();
  const startMs = Date.now();

  const result = await dockerExec(cmd, { timeout: 1800000 });

  const elapsed = Date.now() - startMs;
  const { avgCpu, peakCpu, peakMem } = stats.stop();

  const fpsMatch = result.stdout.match(/(\d+\.?\d*)\s*fps/gi);
  const fps = fpsMatch
    ? fpsMatch.map((m) => parseFloat(m)).reduce((a, b) => a + b, 0) / fpsMatch.length
    : 0;

  return {
    label: config.label,
    workers: config.workers,
    threads: config.tpw,
    vmafThreads: config.vmafThreads,
    fps: fps.toFixed(1),
    avgCpu: avgCpu.toFixed(0),
    peakMem: peakMem.toFixed(1),
    time: formatMs(elapsed),
    exitCode: result.code,
    oom: peakMem > 0 && result.code !== 0 && peakMem > 50,
  };
}

async function benchAbAv1(samplePath, config, cpuUsed) {
  const containerSample = `/samples/${path.basename(samplePath)}`;
  const tempDir = `${BENCH_TEMP}/ab-${config.label || 'run'}`;

  const cmd = [
    `mkdir -p ${tempDir} &&`,
    `ab-av1 auto-encode`,
    `-i ${containerSample} -o ${tempDir}/out.mkv`,
    `--encoder libsvtav1 --preset ${cpuUsed}`,
    `--min-vmaf 93 --min-crf 10 --max-crf 50`,
    `--vmaf "n_threads=4:model=path=/usr/local/share/vmaf/vmaf_v0.6.1.json"`,
    `--svt "lp=${config.svtLp}"`,
    `--svt tune=1 --svt enable-variance-boost=1`,
    `--svt variance-boost-strength=2 --svt variance-octile=6`,
    `--svt tile-columns=1 --svt enable-overlays=1`,
    `--verbose`,
  ].join(' ');

  const stats = startDockerStats();
  const startMs = Date.now();

  const result = await dockerExec(cmd, { timeout: 1800000 });

  const elapsed = Date.now() - startMs;
  const { avgCpu, peakCpu, peakMem } = stats.stop();

  const fpsMatch = result.stderr.match(/(\d+\.?\d*)\s*fps/gi);
  const fps = fpsMatch
    ? fpsMatch.map((m) => parseFloat(m)).reduce((a, b) => a + b, 0) / fpsMatch.length
    : 0;

  return {
    label: config.label,
    workers: '-',
    threads: config.svtLp,
    vmafThreads: '-',
    fps: fps.toFixed(1),
    avgCpu: avgCpu.toFixed(0),
    peakMem: peakMem.toFixed(1),
    time: formatMs(elapsed),
    exitCode: result.code,
    oom: peakMem > 0 && result.code !== 0 && peakMem > 50,
  };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------
function formatMs(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function printTable(results) {
  const headers = ['Config', 'Workers', 'Threads', 'VMAF-T', 'FPS', 'CPU %', 'Time', 'Peak RAM', 'Status'];
  const rows = results.map((r) => [
    r.label,
    String(r.workers),
    String(r.threads),
    String(r.vmafThreads),
    r.fps,
    `${r.avgCpu}%`,
    r.time,
    `${r.peakMem} GiB`,
    r.oom ? 'OOM' : r.exitCode === 0 ? 'OK' : `exit ${r.exitCode}`,
  ]);

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length))
  );

  const sep = widths.map((w) => '-'.repeat(w + 2)).join('+');
  const fmt = (cells) => cells.map((c, i) => ` ${c.padEnd(widths[i])} `).join('|');

  console.log(sep);
  console.log(fmt(headers));
  console.log(sep);
  rows.forEach((r) => console.log(fmt(r)));
  console.log(sep);

  const best = results.filter((r) => !r.oom && r.exitCode === 0)
    .sort((a, b) => parseFloat(b.fps) - parseFloat(a.fps))[0];
  if (best) {
    console.log(`\nRecommended: ${best.label}`);
    if (best.workers !== '-') {
      console.log(`Paste into plugin: {"workers":${best.workers},"threadsPerWorker":${best.threads},"vmafThreads":${best.vmafThreads}}`);
    } else {
      console.log(`Paste into plugin: {"threadsPerWorker":${best.threads}}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const threads = os.cpus().length;
  console.log(`System: ${threads} threads`);
  console.log(`Container: ${CONTAINER}`);
  console.log(`Encoder: ${encoderArg}, cpu-used/preset: ${presetNum}`);

  // Verify container is running
  const check = await dockerExec('echo ok');
  if (check.code !== 0) {
    console.error(`ERROR: cannot reach container "${CONTAINER}". Is it running?`);
    process.exit(1);
  }

  // Find sample files
  const samples = fs.readdirSync(SAMPLES_DIR)
    .filter((f) => /\.(mkv|mp4|ts)$/i.test(f))
    .filter((f) => !sampleFilter || f.includes(sampleFilter))
    .map((f) => path.join(SAMPLES_DIR, f));

  if (samples.length === 0) {
    console.error('ERROR: no sample files found in test/samples/');
    process.exit(1);
  }

  // Copy samples into container
  for (const s of samples) {
    console.log(`Copying ${path.basename(s)} to container...`);
    const cp = require('child_process').spawnSync('docker', ['cp', s, `${CONTAINER}:/samples/`]);
    if (cp.status !== 0) {
      console.error(`ERROR: failed to copy ${s} to container`);
      process.exit(1);
    }
  }
  await dockerExec('mkdir -p /samples');

  // Build configs
  let configs;
  if (gridMode) {
    configs = generateGrid(threads);
    console.log(`Grid mode: ${configs.length} configurations to test`);
  } else {
    const presets = presetFilter ? [presetFilter] : PRESETS;
    configs = presets.map((name) => {
      const b = calcBudget(threads, encoderArg, THREAD_PRESETS[name]);
      return { ...b, label: name };
    });
    console.log(`Preset mode: testing ${configs.map((c) => c.label).join(', ')}`);
  }

  // Run benchmarks
  for (const sample of samples) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Sample: ${path.basename(sample)}`);
    console.log(`${'='.repeat(60)}`);

    const results = [];
    for (const config of configs) {
      console.log(`\nRunning: ${config.label} (workers=${config.workers} threads=${config.tpw} vmaf=${config.vmafThreads})...`);

      // Clean temp between runs
      await dockerExec(`rm -rf ${BENCH_TEMP}`);

      const result = encoderArg === 'aom' || encoderArg === 'svt-av1'
        ? await benchAv1an(sample, config, encoderArg, presetNum)
        : await benchAbAv1(sample, config, presetNum);

      results.push(result);
      console.log(`  -> ${result.fps} fps, ${result.avgCpu}% CPU, ${result.peakMem} GiB RAM, ${result.time}`);
    }

    console.log('');
    printTable(results);
  }

  // Cleanup
  await dockerExec(`rm -rf ${BENCH_TEMP}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add benchmark script to package.json**

In `package.json`, add to the `"scripts"` object:

```json
    "benchmark": "node test/benchmark.js"
```

- [ ] **Step 3: Verify the script loads without errors**

Run: `node -c test/benchmark.js`
Expected: No syntax errors.

- [ ] **Step 4: Commit**

```bash
git add test/benchmark.js package.json
git commit -m "feat: add benchmark runner for thread/worker strategy tuning"
```

---

### Task 6: Verify Full Build and Smoke Tests

**Files:** None (verification only)

- [ ] **Step 1: Build all plugins**

Run: `npm run build`
Expected: Clean build, both plugins bundled.

- [ ] **Step 2: Run smoke tests**

Run: `npm run test:smoke`
Expected: All plugins pass (new inputs validate correctly).

- [ ] **Step 3: Commit any fixups if needed**

Only if previous steps revealed issues.
