# Reality Mode Benchmark + Legacy Strategy

**Date:** 2026-04-04
**Scope:** `test/benchmark.js` only — no plugin source changes

## Problem

av1an+aom encoding at 1080p is 3x slower than the legacy plugin. The root cause is
the thread budget model: the legacy plugin deliberately oversubscribed threads per
worker (e.g. 8 workers x 16 threads on 32 threads), while the current aggressive
preset gives each worker only 2 threads (16 workers x 2 threads). aomenc benefits
from high internal thread counts because its threads aren't fully saturated — the OS
scheduler keeps all cores busy.

The current benchmark's kill-after-duration approach also makes it hard to measure
true FPS throughput because startup overhead, worker ramp-up, and incomplete chunks
distort results.

## Solution

Four changes to `test/benchmark.js`:

### 1. Legacy Thread Strategy (benchmark-only)

Compute the legacy thread budget inline in the benchmark — not added to
`THREAD_PRESETS` in plugin source.

**Formula (replicating old plugin for 1080p):**

```
THREAD_BUDGET = availableThreads * 2
maxWorkers = floor(availableThreads / 4)
threadsPerWorker = min(availableThreads, max(4, floor(THREAD_BUDGET / (maxWorkers / 2))))
vmafThreads = 8
```

**On the 9950X (32 threads):**

| | Workers | Threads/Worker | Total Slots |
|---|---|---|---|
| Legacy | 8 | 16 | 128 (4x oversub) |
| Aggressive | 16 | 2 | 32 (1x) |
| Max | 32 | 1 | 32 (1x) |

Selectable via `--preset legacy`.

### 2. Reality Mode (`--reality <seconds>`)

Encodes a trimmed clip from start to finish instead of killing after a duration.

**Flow:**

1. Probe sample duration, compute start offset: `start = (duration / 2) - (seconds / 2)`
2. Trim from the middle with ffmpeg: `ffmpeg -ss <start> -i sample.mkv -t <seconds> -c copy trimmed.mkv`
3. Cache trimmed file alongside sample (e.g. `sample_reality_30s.mkv`) — reuse across runs
3. Run scene detection on trimmed file as warmup (cached across runs, same as today)
4. Encode the full trimmed clip — no kill timer, av1an runs to completion
5. Measure: FPS = total frames / encode wall time (scene detection time excluded)

`--reality` and `--duration` are mutually exclusive. If both provided, error and exit.

### 3. Per-Chunk FPS from av1an Logs

After encode completes, parse av1an's per-worker chunk log files from the work
directory. Extract FPS per chunk and report in the final summary:

- **Min chunk FPS** — slowest chunk (bottleneck indicator)
- **Median chunk FPS** — typical throughput
- **Max chunk FPS** — fastest chunk

This shows throughput distribution across workers and helps identify whether some
chunks are starving for threads.

### 4. Clean Terminal Output

**During encode:**
- Suppress all encoder stdout/stderr
- Show a single stats line every 10 seconds, overwriting the previous line with `\r`
- Format: `[elapsed] workers: N | fps: X | encoded: Y MiB | cpu: Z% | ram: W GiB`

**On completion:**
- Print full summary table per preset with:
  - Config, Workers, Threads/Worker, VMAF-Threads
  - Total encode time, Total frames, Overall FPS
  - Chunk FPS (min / median / max)
  - Total MiB encoded, CPU %, Peak RAM
  - Status

### 5. Multi-Preset Selection

`--preset` accepts multiple values. Only specified presets run.

```bash
# Run just legacy and max
npm run benchmark -- --reality 30 --preset legacy --preset max --encoder aom --cpu-used 3

# Run single preset
npm run benchmark -- --reality 30 --preset legacy --encoder aom --cpu-used 3

# Default: all standard presets (safe, balanced, aggressive, max) — same as today
npm run benchmark -- --reality 30 --encoder aom --cpu-used 3
```

When `--preset legacy` is among the selections, the legacy formula is used for that
run. All other presets use `calculateThreadBudget` as today.

Combined comparison table printed at the end when multiple presets are run.

## CLI Examples

```bash
# Head-to-head: legacy vs current best
npm run benchmark -- --reality 30 --preset legacy --preset aggressive --encoder aom --cpu-used 3

# Reality mode with all presets
npm run benchmark -- --reality 30 --encoder aom --cpu-used 3

# Existing kill-based mode unchanged
npm run benchmark -- --duration 120 --encoder aom --cpu-used 3

# Grid mode still works
npm run benchmark -- --grid --encoder aom --cpu-used 3
```

## Files Modified

- `test/benchmark.js` — all four changes above

## Out of Scope

- No changes to `src/shared/encoderFlags.js` or any plugin source
- If legacy proves faster, thread preset tuning is a separate follow-up
