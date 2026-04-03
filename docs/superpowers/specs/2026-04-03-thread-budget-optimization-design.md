# Thread & Worker Budget Optimization

## Problem

The current `calculateThreadBudget` in `encoderFlags.js` is very conservative. On a Ryzen 9 9950X (16c/32t, 64GB RAM), encoding hovers at ~40% CPU/RAM utilization. Files that could process in 3-4 hours take 10 hours.

Root causes:
- SVT-AV1: caps at `threads / 6` workers with max 6 threads each
- aomenc: caps at `threads / 4` workers with min 4 threads each
- `--vmaf-threads` hardcoded to 4
- 4K HDR halves worker count unconditionally

## Target Workloads

1. **1080p aomenc preset 3 via av1an** — wants many workers, few threads
2. **1080p SVT-AV1 preset 3-4 via ab-av1** — single encode, wants high `lp`
3. **4K SVT-AV1 preset 4 via av1an** — chunked, needs balanced workers × threads

## Solution

Three components sharing a common config model:
1. Preset-based strategy profiles (non-technical users)
2. Granular plugin input overrides (power users)
3. Benchmark tool to empirically find optimal settings

---

## 1. Config Model (`encoderFlags.js`)

### Preset Profiles

Reference values for 32 threads:

| Preset       | aomenc workers × threads | SVT av1an workers × threads | SVT ab-av1 lp | vmafThreads |
|--------------|-------------------------|-----------------------------|----------------|-------------|
| safe         | 8 × 4                  | ~3 × 5 (4K halved)         | 6              | 4           |
| balanced     | 12 × 2                 | 5 × 6                      | 12             | 8           |
| aggressive   | 16 × 2                 | 6 × 5                      | 20             | 12          |
| max          | 20 × 1-2               | 8 × 4                      | 28             | 16          |

- `safe` = identical to current behavior (backward compatible default)
- Profiles scale proportionally for other thread counts
- 4K HDR worker halving only applies to `safe` preset

### Function Signature

```js
calculateThreadBudget(encoder, availableThreads, resolution, colorTransfer, {
  strategy: 'safe',           // 'safe' | 'balanced' | 'aggressive' | 'max'
  workers: null,              // override — replaces preset value
  threadsPerWorker: null,     // override — replaces preset value
  vmafThreads: null           // override — replaces preset value
})
```

Returns: `{ workers, threadsPerWorker, svtLp, vmafThreads, strategy }`

### Override Behavior

- Any explicit override replaces the corresponding preset value
- Unset overrides fall back to the preset
- Example: strategy `aggressive` + `vmafThreads: 16` = aggressive profile with only vmafThreads changed

---

## 2. Plugin Inputs

### New Inputs (both plugins)

**`thread_strategy`** — dropdown
- Options: `safe`, `balanced`, `aggressive`, `max`, `custom`
- Default: `safe`

**`thread_overrides`** — text field (JSON string)
- Only active when `thread_strategy` is `custom`
- Format: `{"workers": 16, "threadsPerWorker": 2, "vmafThreads": 12}`
- Omitted keys fall back to `aggressive` as the base preset
- Invalid JSON or out-of-range values log a warning and fall back to `aggressive`

### ab-av1 Specifics

- `workers` key is ignored (ab-av1 is single-encode)
- `threadsPerWorker` maps to `--svt lp=<value>`
- `vmafThreads` is ignored (ab-av1 handles VMAF internally)
- Plugin docs note these differences

---

## 3. Benchmark Tool

### Location & Usage

`test/benchmark.js`, invoked via `npm run benchmark`.

Requires a running Tdarr instance (same as e2e tests). The benchmark reuses the e2e test infrastructure (`test/lib/tdarrApi.js`) to create flows with different `thread_strategy` inputs, scan sample files, and poll job completion. All encoding happens inside the Tdarr container where av1an, ab-av1, and ffmpeg are installed.

### Sample Files

- `test/samples/` directory (gitignored, user-provided)
- Users place a typical 1080p and 4K source file there
- `test/samples/.gitkeep` committed as placeholder

### Benchmark Strategy

**av1an (aomenc or SVT-AV1):**
1. Run av1an scene detection on sample file (cached after first run)
2. For each config in the test grid, encode the first N chunks (default 5)
3. Measure metrics, kill after chunks complete

**ab-av1:**
1. Extract a 60-second clip from sample via ffmpeg
2. For each config, run ab-av1 on the clip
3. Measure metrics

### Two Modes

**Preset mode** (non-technical users):
```bash
npm run benchmark                         # test all 4 presets
npm run benchmark -- --preset aggressive  # test one preset
```

**Custom grid mode** (power users):
```bash
npm run benchmark -- --grid               # auto-generated worker × thread matrix
```

Grid auto-generates combinations based on available threads, filtering out combos exceeding total threads. For 32t: workers=[4,6,8,10,12,16,20] × threadsPerWorker=[1,2,3,4,6].

### Output

```
┌─────────────┬─────────┬────────┬──────┬────────┬─────────┬──────────┐
│ Config      │ Workers │ Threads│ FPS  │ CPU %  │ Time    │ Peak RAM │
├─────────────┼─────────┼────────┼──────┼────────┼─────────┼──────────┤
│ safe        │ 8       │ 4      │ 2.1  │ 42%    │ 4m 12s  │  6.1 GiB │
│ balanced    │ 12      │ 2      │ 3.8  │ 71%    │ 2m 21s  │  8.4 GiB │
│ aggressive  │ 16      │ 2      │ 4.9  │ 88%    │ 1m 49s  │ 11.2 GiB │
│ max         │ 20      │ 1      │ 5.2  │ 96%    │ 1m 42s  │ 14.2 GiB │
└─────────────┴─────────┴────────┴──────┴────────┴─────────┴──────────┘

Recommended: aggressive
Paste into plugin: {"workers": 16, "threadsPerWorker": 2, "vmafThreads": 12}
```

### Metrics Collection

- **Wall-clock**: time from job start to completion via Tdarr API polling
- **FPS**: extracted from Tdarr job progress updates during polling
- **CPU% and Memory**: `docker stats` sampled in parallel during encode, capturing container-level CPU and memory usage from the host side. Detects OOM risk — if memory peaks near container limit, the config is flagged as unsafe.
- Container name/ID configurable via `TDARR_CONTAINER` env var (defaults to auto-detection)

**OOM detection:** If a benchmark run is killed by the OOM killer (job fails + memory was near limit), the result row shows `OOM` instead of metrics and the config is excluded from recommendations.

---

## File Changes

### Modified

| File | Change |
|------|--------|
| `src/shared/encoderFlags.js` | Add preset profiles, refactor `calculateThreadBudget` to accept strategy + overrides |
| `src/av1anEncode/index.js` | Add `thread_strategy` and `thread_overrides` inputs, pass to thread budget |
| `src/abAv1Encode/index.js` | Same inputs, map `threadsPerWorker` to `lp` |
| `src/shared/progressTracker.js` | Export FPS/metrics helpers for benchmark reuse |
| `package.json` | Add `benchmark` script |

### Created

| File | Purpose |
|------|---------|
| `test/benchmark.js` | Benchmark runner |
| `test/samples/.gitkeep` | Sample file directory placeholder |

### Not Changed

`processManager.js`, `audioMerge.js`, `downscale.js`, `logger.js`, build system, CI.

---

## Backward Compatibility

- Default `thread_strategy` is `safe`, producing identical output to current `calculateThreadBudget`
- Existing users see no behavior change unless they opt in
- Existing e2e tests pass unchanged (they use default inputs)

## Testing

- Existing e2e tests validate `safe` preset (no regression)
- Add e2e-tests.json scenarios for `balanced` and `aggressive` to verify they don't crash
- Benchmark tool is self-validating — if it runs and produces results, it works
