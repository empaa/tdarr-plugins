# Scene Detection Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fragile benchmark warmup (kill-polling, backup/restore, `--resume`) with av1an's `--sc-only` + `--scenes` flags, and run scene detection in parallel with CRF search in crfSearchEncode.

**Architecture:** Two independent changes sharing the same mechanism. The benchmark warmup runs `av1an --sc-only` once and passes `--scenes` to each iteration. crfSearchEncode spawns `--sc-only` in background during phase 1 (CRF search) and passes `--scenes` to phase 2.

**Tech Stack:** Node.js, av1an CLI, Docker (benchmark only)

**Spec:** `docs/superpowers/specs/2026-04-07-scene-detection-rework-design.md`

---

## Task 1: Rework benchmark warmup — scene detection

**Files:**
- Modify: `test/benchmark.js:132` (default warmup flag)
- Modify: `test/benchmark.js:958-1021` (warmup scene detection block)

- [ ] **Step 1: Change warmup default**

In `test/benchmark.js` line 132, change the `noWarmup` default so warmup is on by default:

```javascript
// Before:
const noWarmup = cliArgs.includes('--no-warmup') || !cliArgs.includes('--warmup');

// After:
const noWarmup = cliArgs.includes('--no-warmup');
```

- [ ] **Step 2: Update CLI help text**

In the help string (lines 44-46), update to reflect new defaults:

```javascript
  --no-warmup           Skip scene cache warmup, each run does fresh scene detection + encode
  --warmup              Use shared scene cache warmup (default; scene detection runs once via --sc-only)
```

Remove the `(default; use --warmup to force cached scene detection)` from `--no-warmup` and add `(default; ...)` to `--warmup`.

- [ ] **Step 3: Replace warmup scene detection block**

Replace lines 958-1021 (the entire `if (!isAbAv1 && !noWarmup)` block) with the new `--sc-only` approach:

```javascript
    // Warmup: run scene detection once so all benchmark runs skip it
    if (!isAbAv1 && !noWarmup) {
      console.log('\nWarmup: running scene detection via --sc-only...');
      const containerSample = activeSample;
      const warmupDir = `${BENCH_TEMP}/warmup`;
      const vpyParts = [
        'import vapoursynth as vs',
        'core = vs.core',
        `src = core.lsmas.LWLibavSource(source=\\"${containerSample}\\")`,
      ];
      if (downscaleRes) {
        for (const line of buildVsDownscaleLines(downscaleRes)) {
          vpyParts.push(line);
        }
      }
      vpyParts.push('src.set_output()');
      const vpyLines = vpyParts.join('\\n');

      const scenesPath = `${warmupDir}/scenes.json`;
      const scOnlyCmd = [
        `mkdir -p ${warmupDir}/vs &&`,
        `printf '${vpyLines}\\n' > ${warmupDir}/vs/bench.vpy &&`,
        `av1an -i ${warmupDir}/vs/bench.vpy`,
        `--sc-only --scenes ${scenesPath}`,
        `--sc-downscale-height 540`,
        `--verbose`,
      ].join(' ');

      const scResult = await dockerExec(scOnlyCmd, { timeout: 300000, live: true });
      if (scResult.code !== 0) {
        console.error(`ERROR: scene detection failed (exit ${scResult.code})`);
        process.exit(1);
      }
      console.log('    Scenes cached.\n');
    }
```

Key differences from old code:
- No `--workers 1`, no encoder flags, no `--target-quality` — `--sc-only` only does detection
- No kill-polling loop — `--sc-only` exits naturally
- No backup/restore — the scene file persists at `warmupDir/scenes.json`
- No `chunks.json` or `done.json` needed

- [ ] **Step 4: Commit**

```bash
git add test/benchmark.js
git commit -m "refactor(benchmark): replace warmup kill-polling with --sc-only"
```

---

## Task 2: Rework benchmark warmup — iteration runner

**Files:**
- Modify: `test/benchmark.js:258-430` (`benchAv1an` function)

- [ ] **Step 1: Replace warmup branch in benchAv1an**

In the `benchAv1an` function (line 282-313), replace the warmup (non-`noWarmup`) branch. The warmup branch currently restores backups, resets `done.json`, and passes `--resume`. Replace with `--scenes`:

```javascript
  let av1anCmdParts;
  if (noWarmup) {
    // Fresh run: no scene cache, av1an does scene detection + encode from scratch
    const runDir = `${BENCH_TEMP}/run-${config.label.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    av1anCmdParts = [
      `rm -rf ${runDir} 2>/dev/null;`,
      `mkdir -p ${runDir}/work &&`,
      `av1an -i "${containerSample}" -o ${runDir}/out.mkv --temp ${runDir}/work`,
      `-c mkvmerge -e ${av1anEncoder}`,
      workerArgs,
      `--vmaf-path /usr/local/share/vmaf/vmaf_v0.6.1.json`,
      `--sc-downscale-height 540 --chunk-order long-to-short --chunk-method ${chunkMethod}${chunkMethod === 'hybrid' ? ' --ignore-frame-mismatch' : ''}`,
      `--target-quality ${targetVmaf} --qp-range 10-50 --probes 6`,
      `--verbose`,
    ];
  } else {
    // Warmup mode: scene detection already done, pass --scenes to skip it
    const runDir = `${BENCH_TEMP}/run-${config.label.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const scenesPath = `${warmupDir}/scenes.json`;
    av1anCmdParts = [
      `rm -rf ${runDir} 2>/dev/null;`,
      `mkdir -p ${runDir}/work &&`,
      `av1an -i ${warmupDir}/vs/bench.vpy -o ${runDir}/out.mkv --temp ${runDir}/work`,
      `-c mkvmerge -e ${av1anEncoder}`,
      workerArgs,
      `--vmaf-path /usr/local/share/vmaf/vmaf_v0.6.1.json`,
      `--sc-downscale-height 540 --chunk-order long-to-short --chunk-method ${chunkMethod}${chunkMethod === 'hybrid' ? ' --ignore-frame-mismatch' : ''}`,
      `--target-quality ${targetVmaf} --qp-range 10-50 --probes 6`,
      `--scenes ${scenesPath}`,
      `--verbose`,
    ];
  }
```

Key differences:
- Each warmup iteration gets its own `runDir` (no need to share/clean the warmup work dir)
- Uses `--scenes` instead of `--resume` + backup restore
- No `done.json` reset
- Input is the warmup VPY script (has the lwi cache from `--sc-only`)

- [ ] **Step 2: Update runDir variable used later in the function**

The `runDir` variable on line 323-325 is used for the work directory and output file path. Update it to use the per-run dir in both modes:

```javascript
  const runDir = `${BENCH_TEMP}/run-${config.label.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const workDir = `${runDir}/work`;
```

This replaces:
```javascript
  const runDir = noWarmup
    ? `${BENCH_TEMP}/run-${config.label.replace(/[^a-zA-Z0-9_-]/g, '_')}`
    : warmupDir;
  const workDir = `${runDir}/work`;
```

- [ ] **Step 3: Simplify monitoring — remove encode-start detection**

In the warmup path, there's no scene detection phase during the benchmark iteration, so encode starts immediately. Simplify the monitor:

In the `monitorTick` function (lines 340-394), the `encodeStartMs` tracking and fast-to-slow polling switch is only needed for `noWarmup` mode. When warmup is active, set `encodeStartMs = startMs` at the start so timing works correctly without the detection logic:

```javascript
  // In warmup mode, encode starts immediately (no scene detection phase)
  let encodeStartMs = noWarmup ? null : startMs;
```

This single change makes all the existing timing logic work correctly:
- Warmup: `encodeStartMs = startMs` means encode time = elapsed time, duration countdown starts immediately, no "scene detection..." status shown
- No-warmup: `encodeStartMs = null` means it waits for first bytes (existing behaviour)

- [ ] **Step 4: Simplify timeout calculation**

On line 400, the scene detection buffer is no longer needed for warmup mode since `--scenes` skips detection:

```javascript
  // No-warmup needs extra time for scene detection; warmup goes straight to encoding
  const sceneDetectionBuffer = noWarmup ? 300 : 30;
```

Reduce from 60 to 30 for warmup since there's no scene detection at all — just a small buffer for startup overhead.

- [ ] **Step 5: Commit**

```bash
git add test/benchmark.js
git commit -m "refactor(benchmark): use --scenes in iterations, simplify timing"
```

---

## Task 3: Test benchmark warmup on test server

**Files:**
- None (verification only)

- [ ] **Step 1: Build the project**

```bash
cd /Users/emilgrunden/ClaudeProjects/tdarr-plugins
npm run build
```

- [ ] **Step 2: Run a quick warmup benchmark**

Run a short benchmark with warmup (now default) to verify the new flow works:

```bash
npm run benchmark -- --encoder svt-av1 --cpu-used 8 --preset safe --duration 30 --sample jurassic
```

Verify in the output:
- "Warmup: running scene detection via --sc-only..." appears
- No kill-polling or backup messages
- "Scenes cached." appears
- Each iteration starts encoding immediately (no "scene detection..." status)
- Timing shows encode time only (no separate encode-only time)

- [ ] **Step 3: Run a no-warmup benchmark for comparison**

```bash
npm run benchmark -- --encoder svt-av1 --cpu-used 8 --preset safe --duration 30 --no-warmup --sample jurassic
```

Verify:
- No warmup step
- Each iteration shows "scene detection..." during the detection phase
- Timing includes scene detection overhead

- [ ] **Step 4: Commit (if any fixes needed)**

```bash
git add test/benchmark.js
git commit -m "fix(benchmark): address issues found during warmup testing"
```

---

## Task 4: crfSearchEncode — move VPY + lwi creation before phase 1

**Files:**
- Modify: `src/crfSearchEncode/index.js:219-401`

- [ ] **Step 1: Move VapourSynth script and lwi index creation before phase 1**

Currently the VPY script is created at line 379-392 (between phase 1 and phase 2). Move this block to right after the grain estimation and work directory setup (after line 227), before the phase 1 banner log.

Move these lines (currently 379-401) to after line 229 (`fs.mkdirSync(searchDir, { recursive: true })`):

```javascript
  // Build VapourSynth script (needed for both scene detection and phase 2)
  const vpyScript = path.join(vsDir, 'source.vpy');
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

  // Pre-index lwi if needed (shared by scene detection and phase 2)
  if (!fs.existsSync(lwiCache)) {
    updateWorker({ status: 'Indexing' });
    const lwiExit = await pm.spawnAsync(BIN.vspipe, ['--info', vpyScript], {
      cwd: vsDir,
      silent: true,
    });
    dbg(lwiExit === 0 ? '[vs] .lwi index ready' : '[vs] WARNING: .lwi non-zero -- workers will retry');
  }
```

Remove the duplicate lines from their old location (between phase 1 and phase 2). The code is identical — just relocating it.

- [ ] **Step 2: Verify no references break**

Check that `vpyScript`, `escPy`, `vpyLines`, and `lwiCache` are not referenced before their new location. `lwiCache` is defined on line 229 (already before the move target). `vpyScript` is only used in phase 2 and the new scene detection spawn. No breakage.

- [ ] **Step 3: Commit**

```bash
git add src/crfSearchEncode/index.js
git commit -m "refactor(crfSearchEncode): move VPY+lwi creation before phase 1"
```

---

## Task 5: crfSearchEncode — parallel scene detection

**Files:**
- Modify: `src/crfSearchEncode/index.js` (after phase 1 setup, before phase 2)

- [ ] **Step 1: Add scene detection spawn before CRF search**

After the VPY + lwi creation (moved in Task 4) and before the phase 1 banner log, add:

```javascript
  // ── Scene detection (parallel with CRF search) ──────────────────────
  const scenesPath = path.join(workBase, 'scenes.json');
  const scOnlyArgs = [
    '-i', vpyScript,
    '--sc-only',
    '--scenes', scenesPath,
    '--sc-downscale-height', '540',
    '--min-scene-len', '24',
    '--verbose',
  ];

  jobLog(`[scene-detect] starting in background: av1an ${scOnlyArgs.join(' ')}`);
  const sceneDetectPromise = pm.spawnAsync(BIN.av1an, scOnlyArgs, {
    cwd: vsDir,
    filter: (l) => /scenecut|error|warn/i.test(l),
  });
```

This spawns scene detection but does NOT await it. The promise is held for later.

- [ ] **Step 2: Handle early exit after CRF search failure**

After the existing CRF search failure check (lines 360-370), the code already calls `pm.cleanup()` before returning. Since scene detection was spawned through `pm`, `pm.cleanup()` → `pm.killAll()` will kill it. No changes needed here — just verify `pm.cleanup()` is called on the failure path.

However, we should explicitly log that we're aborting scene detection:

```javascript
  if (crfSearchFailed || abExit !== 0 || foundCrf == null) {
    jobLog('[scene-detect] aborting (CRF search did not succeed)');
    pm.cleanup();
    // ... existing failure return ...
  }
```

Add the log line before the existing `pm.cleanup()` call.

- [ ] **Step 3: Await scene detection after successful CRF search**

After the `jobLog('[phase 1] found CRF ...')` line (line 372), add the await:

```javascript
  // Wait for scene detection to finish (may already be done)
  let sceneDetectDone = false;
  sceneDetectPromise.then(() => { sceneDetectDone = true; }).catch(() => { sceneDetectDone = true; });
  // Yield to let microtasks settle (if scene detection already resolved, flag is set)
  await new Promise((r) => setImmediate(r));

  if (!sceneDetectDone) {
    jobLog('[scene-detect] CRF search complete, waiting for scene detection...');
    updateWorker({ status: 'Scene Detection' });
  } else {
    jobLog('[scene-detect] already complete');
  }
  const sceneDetectExit = await sceneDetectPromise;

  if (sceneDetectExit !== 0) {
    pm.cleanup();
    throw new Error(`Scene detection failed (exit ${sceneDetectExit})`);
  }

  jobLog(`[scene-detect] scenes written to ${scenesPath}`);
```

- [ ] **Step 4: Add `--scenes` to phase 2 av1an args**

In the av1an args array (lines 424-440), add `--scenes` and remove the scene detection overhead since it's pre-computed:

```javascript
  const av1anArgs = [
    '-i', vpyScript,
    '-o', outputPath,
    '--temp', av1anTemp,
    '-c', 'mkvmerge',
    '-e', encoder,
    '--sc-downscale-height', '540',
    '--scaler', 'lanczos',
    '--chunk-method', chunkMethod,
    ...(chunkMethod === 'hybrid' ? ['--ignore-frame-mismatch'] : []),
    ...(isAutoThreads ? [] : ['--workers', String(encodeBudget.maxWorkers)]),
    '--min-scene-len', '24',
    '--chunk-order', 'long-to-short',
    '--scenes', scenesPath,
    '--keep',
    '--verbose',
  ];
```

Key changes:
- Added `'--scenes', scenesPath`
- Removed `'--resume'` (not needed when scenes are provided externally)

- [ ] **Step 5: Remove the "Scene Detection" status from the tracker start**

On line 457, `updateWorker({ status: 'Scene Detection' })` is set before the tracker starts. Since scene detection is already done at this point, change it to:

```javascript
  updateWorker({ status: 'Encoding' });
```

- [ ] **Step 6: Commit**

```bash
git add src/crfSearchEncode/index.js
git commit -m "feat(crfSearchEncode): run scene detection in parallel with CRF search"
```

---

## Task 6: Test crfSearchEncode on test server

**Files:**
- None (verification only)

- [ ] **Step 1: Build and deploy**

```bash
cd /Users/emilgrunden/ClaudeProjects/tdarr-plugins
npm run deploy
```

- [ ] **Step 2: Run a test encode via Tdarr**

Trigger a crfSearchEncode job on the test server using the jurassic sample. Monitor the Tdarr job log for:

- `[scene-detect] starting in background` appears before CRF search
- CRF search and scene detection run concurrently (both produce log output)
- Either `[scene-detect] already complete` or `[scene-detect] CRF search complete, waiting for scene detection...` appears
- `[scene-detect] scenes written to ...` appears
- Phase 2 av1an output shows no "Scene detection" line — jumps to chunk queuing
- Encode completes successfully

- [ ] **Step 3: Test cancellation**

Cancel a crfSearchEncode job mid-CRF-search. Verify:
- Both the CRF search process and scene detection process are killed
- No orphaned av1an processes remain

- [ ] **Step 4: Commit (if any fixes needed)**

```bash
git add src/crfSearchEncode/index.js
git commit -m "fix(crfSearchEncode): address issues found during parallel scene detection testing"
```

---

## Task 7: Final cleanup and version bump

**Files:**
- Modify: `package.json` (version bump)

- [ ] **Step 1: Bump version**

Ask the user whether this is a minor or patch bump. This adds a feature (parallel scene detection in crfSearchEncode) so minor bump is likely appropriate.

- [ ] **Step 2: Commit version bump**

```bash
git add package.json
git commit -m "chore: bump version to X.Y.Z"
```

- [ ] **Step 3: Push to dev**

```bash
git push origin dev
```
