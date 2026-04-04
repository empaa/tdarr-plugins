# Reality Mode Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reality mode benchmarking, legacy thread strategy, per-chunk FPS reporting, clean terminal output, and multi-preset selection to `test/benchmark.js`.

**Architecture:** All changes are in `test/benchmark.js`. The legacy thread formula is computed inline (not exported). Reality mode trims the sample with ffmpeg inside the container, then lets av1an run to completion. Terminal output switches from live encoder dumps to a single overwriting stats line.

**Tech Stack:** Node.js, child_process (spawn/spawnSync), Docker exec

---

### Task 1: Multi-preset CLI parsing

Replace the single `--preset` parser with one that collects all `--preset` values into an array. Add `--reality` parser. Update `--help` text.

**Files:**
- Modify: `test/benchmark.js:28-90` (CLI args section)

- [ ] **Step 1: Replace preset parser with multi-value collector**

Replace lines 63-66 (the `presetFilter` IIFE) with:

```javascript
const presetFilter = (() => {
  const presets = [];
  for (let i = 0; i < cliArgs.length; i++) {
    if (cliArgs[i] === '--preset' && cliArgs[i + 1]) presets.push(cliArgs[++i]);
  }
  return presets.length > 0 ? presets : null;
})();
```

- [ ] **Step 2: Add reality mode parser**

After the `testDuration` IIFE (line 90), add:

```javascript
const realitySeconds = (() => {
  const idx = cliArgs.indexOf('--reality');
  return idx !== -1 && cliArgs[idx + 1] ? Number(cliArgs[idx + 1]) : null;
})();

if (realitySeconds != null && cliArgs.includes('--duration')) {
  console.error('ERROR: --reality and --duration are mutually exclusive');
  process.exit(1);
}
```

- [ ] **Step 3: Update help text**

In the help string (lines 31-58), update the `--preset` line and add `--reality`:

```
  --preset <name>       Preset(s) to test (repeatable): safe, balanced, aggressive, max, legacy
  --reality <sec>       Trim sample to N seconds (from middle) and encode to completion
```

Add examples:

```
  npm run benchmark -- --reality 30 --preset legacy --preset max --encoder aom
```

- [ ] **Step 4: Commit**

```bash
git add test/benchmark.js
git commit -m "feat(bench): multi-preset CLI and --reality flag parsing"
```

---

### Task 2: Legacy thread strategy

Add the legacy thread budget formula, computed inline when `--preset legacy` is selected.

**Files:**
- Modify: `test/benchmark.js:514-535` (config building section)

- [ ] **Step 1: Add legacy budget function**

Above the `main()` function, add:

```javascript
function legacyThreadBudget(availableThreads) {
  const budget = availableThreads * 2;
  const maxWorkers = Math.max(1, Math.floor(availableThreads / 4));
  const threadsPerWorker = Math.min(
    availableThreads,
    Math.max(4, Math.floor(budget / (maxWorkers / 2)))
  );
  return { maxWorkers, threadsPerWorker, svtLp: threadsPerWorker, vmafThreads: 8 };
}
```

- [ ] **Step 2: Update config building to handle legacy and multi-preset**

Replace the preset config building block (lines 522-534) with:

```javascript
    const presets = presetFilter || PRESETS;
    configs = presets.map((name) => {
      if (name === 'legacy') {
        const b = legacyThreadBudget(threads);
        return { workers: b.maxWorkers, tpw: b.threadsPerWorker, svtLp: b.svtLp, vmafThreads: b.vmafThreads, label: 'legacy' };
      }
      const p = THREAD_PRESETS[name];
      if (!p) {
        console.error(`ERROR: unknown preset "${name}". Available: ${PRESETS.join(', ')}, legacy`);
        process.exit(1);
      }
      const encoder = encoderArg === 'ab-av1' ? 'svt-av1' : encoderArg;
      const singleProcess = encoderArg === 'ab-av1';
      const b = calculateThreadBudget(threads, encoder, false, { strategy: name, singleProcess, encPreset: Number(cpuUsed) });
      return { workers: b.maxWorkers, tpw: b.threadsPerWorker, svtLp: b.svtLp, vmafThreads: b.vmafThreads, label: name };
    });
```

- [ ] **Step 3: Commit**

```bash
git add test/benchmark.js
git commit -m "feat(bench): add legacy thread strategy for benchmarking"
```

---

### Task 3: Reality mode — sample trimming

Probe the sample duration, trim from the middle to N seconds using ffmpeg inside the container, cache the trimmed file.

**Files:**
- Modify: `test/benchmark.js` — add trimming logic in the per-sample loop, before warmup

- [ ] **Step 1: Add trim function**

Above `main()`, add:

```javascript
async function trimSampleForReality(containerSample, seconds) {
  const tag = `reality_${seconds}s`;
  const ext = path.extname(containerSample);
  const base = containerSample.replace(ext, '');
  const trimmedPath = `${base}_${tag}${ext}`;

  // Check cache
  const cacheCheck = await dockerExec(`test -f ${trimmedPath} && echo yes || echo no`, { timeout: 5000 });
  if (cacheCheck.stdout.trim() === 'yes') {
    console.log(`  Using cached trimmed sample: ${path.basename(trimmedPath)}`);
    return trimmedPath;
  }

  // Probe duration
  const probeCmd = `ffprobe -v error -show_entries format=duration -of csv=p=0 ${containerSample}`;
  const probeResult = await dockerExec(probeCmd, { timeout: 15000 });
  const duration = parseFloat(probeResult.stdout.trim());
  if (isNaN(duration) || duration <= 0) {
    console.error('ERROR: could not probe sample duration');
    process.exit(1);
  }

  const start = Math.max(0, (duration / 2) - (seconds / 2));
  console.log(`  Trimming ${seconds}s from middle (start=${start.toFixed(1)}s of ${duration.toFixed(1)}s)...`);

  const trimCmd = `ffmpeg -y -ss ${start.toFixed(3)} -i ${containerSample} -t ${seconds} -c copy ${trimmedPath}`;
  const trimResult = await dockerExec(trimCmd, { timeout: 60000 });
  if (trimResult.code !== 0) {
    console.error('ERROR: ffmpeg trim failed:', trimResult.stderr.slice(-300));
    process.exit(1);
  }

  return trimmedPath;
}
```

- [ ] **Step 2: Integrate trimming into sample loop**

In the per-sample loop (around line 538), after the `console.log` for the sample name, add:

```javascript
    let activeSample = `/samples/${path.basename(sample)}`;
    if (realitySeconds) {
      activeSample = await trimSampleForReality(activeSample, realitySeconds);
    }
```

Then replace all uses of `` `/samples/${path.basename(sample)}` `` in the warmup section with `activeSample`. Specifically, update the warmup `containerSample` (line 546) to use `activeSample`:

```javascript
      const containerSample = activeSample;
```

- [ ] **Step 3: Commit**

```bash
git add test/benchmark.js
git commit -m "feat(bench): trim sample from middle for reality mode"
```

---

### Task 4: Reality mode — full encode to completion

When `--reality` is active, let av1an encode to completion instead of killing after a duration. Track total frames for FPS calculation.

**Files:**
- Modify: `test/benchmark.js` — `benchAv1an()` function

- [ ] **Step 1: Add frame count probe helper**

Above `main()`, add:

```javascript
async function probeFrameCount(containerPath) {
  const cmd = `ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames -of csv=p=0 ${containerPath}`;
  const result = await dockerExec(cmd, { timeout: 60000 });
  const frames = parseInt(result.stdout.trim(), 10);
  return isNaN(frames) ? 0 : frames;
}
```

- [ ] **Step 2: Pass reality mode context into benchAv1an**

Update `benchAv1an` signature to accept reality options:

```javascript
async function benchAv1an(samplePath, config, { realityMode = false, activeSample = null, totalFrames = 0 } = {}) {
```

Update the container sample reference at the top of `benchAv1an` — when `activeSample` is provided, use it instead of computing from `samplePath`:

```javascript
  const containerSample = activeSample || `/samples/${path.basename(samplePath)}`;
```

- [ ] **Step 3: Modify timeout and kill logic for reality mode**

In `benchAv1an`, the `progressMonitor` interval currently kills av1an when `testDuration` is reached. Wrap the kill logic:

```javascript
      // Time limit (only in duration mode, not reality mode)
      if (!realityMode && elapsedSec >= testDuration) {
        timedOut = true;
        process.stdout.write(`    Time limit reached (${testDuration}s) — stopping encode\n`);
        spawnSync('docker', ['exec', CONTAINER, 'bash', '-c',
          'pkill -f "av1an|aomenc|SvtAv1EncApp" 2>/dev/null; true',
        ]);
      }
```

Update the `dockerExec` timeout for the encode command. In reality mode, allow up to 2 hours:

```javascript
  const execTimeout = realityMode ? 7200000 : (testDuration + 60) * 1000;
  const result = await dockerExec(cmd, { timeout: execTimeout, live: !realityMode });
```

Note: `live` is `false` in reality mode because Task 5 will handle terminal output differently.

- [ ] **Step 4: Add FPS to return value**

In `benchAv1an`'s return object, add fps calculation:

```javascript
  const fps = realityMode && totalFrames > 0 && encodeTimeSec > 0
    ? (totalFrames / encodeTimeSec).toFixed(1) : null;
```

Add `fps` and `totalFrames` to the return object:

```javascript
  return {
    ...existing fields...,
    fps,
    totalFrames: realityMode ? totalFrames : null,
  };
```

- [ ] **Step 5: Update call site to pass reality options**

In the per-config loop (around line 646), update the `benchAv1an` call:

```javascript
      let totalFrames = 0;
      if (realitySeconds && !isAbAv1) {
        totalFrames = await probeFrameCount(activeSample);
        if (totalFrames === 0) {
          console.error('ERROR: could not determine frame count of trimmed sample');
          process.exit(1);
        }
      }

      const result = isAbAv1
        ? await benchAbAv1(sample, config, abAv1Crf)
        : await benchAv1an(sample, config, {
            realityMode: !!realitySeconds,
            activeSample,
            totalFrames,
          });
```

- [ ] **Step 6: Commit**

```bash
git add test/benchmark.js
git commit -m "feat(bench): reality mode runs av1an to completion with FPS tracking"
```

---

### Task 5: Clean terminal output

Replace live encoder output with a single overwriting stats line during encode. Suppress encoder stdout/stderr.

**Files:**
- Modify: `test/benchmark.js` — `benchAv1an()` and `benchAbAv1()` progress monitors

- [ ] **Step 1: Replace progress monitor output in benchAv1an**

In `benchAv1an`'s `progressMonitor` interval, replace the `process.stdout.write` line with an overwriting single-line format. Also remove the existing `live: true` line logging.

Replace the stats output line:

```javascript
      const elapsed = formatMs(Date.now() - startMs);
      const cpuStr = cpuSamples.length > 0 ? cpuSamples[cpuSamples.length - 1].toFixed(0) + '%' : '-';
      const memStr = memSamples.length > 0 ? memSamples[memSamples.length - 1].toFixed(1) + ' GiB' : '-';
      const encMiBStr = encMiB;

      if (realityMode) {
        const pctStr = totalFrames > 0 ? '' : '';  // frames not available mid-encode from disk
        process.stdout.write(`\r    [${elapsed}] workers: ${config.workers} | encoded: ${encMiBStr} MiB | cpu: ${cpuStr} | ram: ${memStr}    `);
      } else {
        const remaining = Math.max(0, testDuration - elapsedSec);
        process.stdout.write(`\r    [${elapsed}] workers: ${config.workers} | encoded: ${encMiBStr} MiB | ${formatMs(remaining * 1000)} left | cpu: ${cpuStr} | ram: ${memStr}    `);
      }
```

- [ ] **Step 2: Ensure encoder output is suppressed in reality mode**

The `dockerExec` call already has `live: !realityMode` from Task 4 Step 3. For non-reality mode (duration mode), also switch to the overwriting format by changing `live: true` to `live: false`:

```javascript
  const result = await dockerExec(cmd, { timeout: execTimeout, live: false });
```

Encoder output is now always suppressed. The 10s stats line is the only terminal output.

- [ ] **Step 3: Add newline after encode finishes**

After `clearInterval(progressMonitor)`, add a newline to move past the overwriting line:

```javascript
  clearInterval(progressMonitor);
  process.stdout.write('\n');
```

- [ ] **Step 4: Apply same pattern to benchAbAv1**

In `benchAbAv1`'s `statsInterval`, replace the `process.stdout.write` with the same overwriting format:

```javascript
      const elapsed = formatMs(Date.now() - startMs);
      const cpuStr = cpuSamples.length > 0 ? cpuSamples[cpuSamples.length - 1].toFixed(0) + '%' : '-';
      const memStr = memSamples.length > 0 ? memSamples[memSamples.length - 1].toFixed(1) + ' GiB' : '-';
      process.stdout.write(`\r    [${elapsed}] encoded: ${encMiB} MiB | ${formatMs(remaining * 1000)} left | cpu: ${cpuStr} | ram: ${memStr}    `);
```

Change `live: true` to `live: false` in the `benchAbAv1` `dockerExec` call too. Add `process.stdout.write('\n')` after `clearInterval(statsInterval)`.

- [ ] **Step 5: Commit**

```bash
git add test/benchmark.js
git commit -m "feat(bench): clean terminal output with overwriting stats line"
```

---

### Task 6: Per-chunk FPS parsing from av1an logs

After encode completes, parse av1an's chunk log files to extract per-chunk FPS and report min/median/max.

**Files:**
- Modify: `test/benchmark.js` — add parser, integrate into `benchAv1an()` return, update `printTable()`

- [ ] **Step 1: Add chunk FPS parser**

Above `main()`, add:

```javascript
async function parseChunkFps(workDir) {
  const logDir = `${workDir}/log`;
  const lsResult = await dockerExec(`ls ${logDir}/ 2>/dev/null`, { timeout: 5000 });
  if (lsResult.code !== 0) return null;

  const logFiles = lsResult.stdout.trim().split('\n').filter((f) => f.startsWith('av1an.log'));
  if (logFiles.length === 0) return null;

  const allFps = [];
  for (const lf of logFiles) {
    const catResult = await dockerExec(`cat ${logDir}/${lf}`, { timeout: 10000 });
    if (catResult.code !== 0) continue;

    const lines = catResult.stdout.split('\n');
    for (const line of lines) {
      if (/finished/i.test(line)) {
        const m = line.match(/(\d+(?:\.\d+)?)\s*fps/i);
        if (m) allFps.push(parseFloat(m[1]));
      }
    }
  }

  if (allFps.length === 0) return null;

  const sorted = [...allFps].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];

  return {
    min: sorted[0],
    median,
    max: sorted[sorted.length - 1],
    count: sorted.length,
  };
}
```

- [ ] **Step 2: Call parser in benchAv1an after encode**

In `benchAv1an`, after the encode completes and `clearInterval(progressMonitor)`, add:

```javascript
  const chunkFps = await parseChunkFps(workDir);
```

Add `chunkFps` to the return object:

```javascript
  return {
    ...existing fields...,
    chunkFps,
  };
```

- [ ] **Step 3: Update printTable to show FPS columns**

In `printTable`, add columns for reality mode results. Check if any result has `fps` or `chunkFps`:

```javascript
function printTable(results) {
  const hasReality = results.some((r) => r.fps != null);
  const hasChunkFps = results.some((r) => r.chunkFps != null);

  const headers = ['Config', 'Workers', 'Threads', 'VMAF-T'];
  if (hasReality) headers.push('FPS', 'Frames');
  if (hasChunkFps) headers.push('Chunk FPS (min/med/max)');
  headers.push('MiB/min', 'Total MiB', 'CPU %', 'Peak RAM', 'Time', 'Status');

  const rows = results.map((r) => {
    const row = [
      r.label,
      String(r.workers),
      String(r.threads),
      String(r.vmafThreads),
    ];
    if (hasReality) {
      row.push(r.fps || '-', r.totalFrames != null ? String(r.totalFrames) : '-');
    }
    if (hasChunkFps) {
      row.push(r.chunkFps
        ? `${r.chunkFps.min.toFixed(1)} / ${r.chunkFps.median.toFixed(1)} / ${r.chunkFps.max.toFixed(1)}`
        : '-');
    }
    row.push(
      r.mibPerMin,
      r.totalMiB,
      `${r.avgCpu}%`,
      `${r.peakMem} GiB`,
      r.time,
      r.oom ? 'OOM' : r.exitCode === 0 ? 'OK' : `exit ${r.exitCode}`,
    );
    return row;
  });

  // ... rest of table rendering (widths, sep, fmt) stays the same
```

- [ ] **Step 4: Update recommendation to consider FPS in reality mode**

In the recommendation section of `printTable`, when `hasReality` is true, sort by FPS instead of MiB/min:

```javascript
  if (best) {
    // ... existing recommendation logic
  }

  if (hasReality) {
    const bestFps = results
      .filter((r) => !r.oom && r.exitCode === 0 && r.fps != null)
      .sort((a, b) => parseFloat(b.fps) - parseFloat(a.fps))[0];
    if (bestFps) {
      console.log(`\nFastest (reality): ${bestFps.label} at ${bestFps.fps} fps`);
    }
  }
```

- [ ] **Step 5: Commit**

```bash
git add test/benchmark.js
git commit -m "feat(bench): per-chunk FPS parsing and enhanced results table"
```

---

### Task 7: Update header logging and final integration

Update the startup banner to show reality mode info, and print mode in the header.

**Files:**
- Modify: `test/benchmark.js` — `main()` header section

- [ ] **Step 1: Update header**

In `main()`, after the existing `console.log` lines (around line 476-478), adjust:

```javascript
  if (realitySeconds) {
    console.log(`Mode: reality (${realitySeconds}s trimmed from middle, encode to completion)`);
  } else {
    console.log(`Mode: duration (${testDuration}s per config, kill after limit)`);
  }
```

- [ ] **Step 2: Update per-config run log to show FPS expectation**

In the per-config loop, update the log line to mention reality mode:

```javascript
      const modeStr = realitySeconds ? `reality ${realitySeconds}s` : `${testDuration}s`;
      console.log(`\nRunning: ${config.label} (${detail}) — ${modeStr}...`);
```

- [ ] **Step 3: Update per-config result summary line**

After each benchmark run, show FPS when available:

```javascript
      const fpsStr = result.fps ? `, ${result.fps} fps` : '';
      const chunkStr = result.chunkFps
        ? `, chunks: ${result.chunkFps.min.toFixed(1)}/${result.chunkFps.median.toFixed(1)}/${result.chunkFps.max.toFixed(1)} fps`
        : '';
      console.log(`  -> ${result.mibPerMin} MiB/min (${result.totalMiB} MiB)${fpsStr}${chunkStr}, ${result.avgCpu}% CPU, ${result.peakMem} GiB RAM${result.oom ? ' [OOM]' : ''}`);
```

- [ ] **Step 4: Commit**

```bash
git add test/benchmark.js
git commit -m "feat(bench): update header and result logging for reality mode"
```

---

### Task 8: Manual verification

- [ ] **Step 1: Verify help text**

```bash
npm run benchmark -- --help
```

Expected: shows `--reality`, updated `--preset` with `legacy`, new examples.

- [ ] **Step 2: Dry-run check — multi-preset parsing**

Add a temporary `console.log(configs)` after config building, run:

```bash
npm run benchmark -- --reality 30 --preset legacy --preset aggressive --encoder aom --cpu-used 3
```

Verify configs array has exactly 2 entries: legacy (8 workers, 16 threads on 32-thread system) and aggressive. Remove the temporary log.

- [ ] **Step 3: Commit final state**

```bash
git add test/benchmark.js
git commit -m "chore(bench): finalize reality mode benchmark implementation"
```
