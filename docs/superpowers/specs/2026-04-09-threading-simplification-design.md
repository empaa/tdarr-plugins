# Threading Simplification

Remove the manual thread strategy system and let av1an/ab-av1 handle all threading decisions with their built-in defaults.

## Background

Extensive benchmarking showed that `lsmash` + av1an's auto-threading is nearly optimal in all cases. The manual thread presets (safe/balanced/aggressive/max/custom) add complexity but don't meaningfully beat av1an's auto mode. The entire `calculateThreadBudget` system, including encoder-specific oversub models and SVT lp-cap tables, is unnecessary overhead.

## Changes

### Remove from `src/shared/encoderFlags.js`

Delete the following (entire functions/constants):

- `SVT_LP_CAP_BY_PRESET` — preset-to-lp-cap lookup table
- `capSvtLpByPreset()` — SVT lp capping function
- `THREAD_PRESETS` — safe/balanced/aggressive/max config objects
- `resolveThreadStrategy()` — strategy name resolver
- `calculateThreadBudget()` — the main thread budget calculator

Remove the `threadsPerWorker` parameter from `buildAomFlags()`. The `--threads=N` flag should no longer be emitted — av1an will decide. The function signature becomes `buildAomFlags(preset, hdrAom)`.

Remove the `lp` parameter from `svtConfig()`. The `lp` entry should no longer be emitted. This cascades to:
- `buildSvtFlags(preset, hdrSvt)` — drop `svtLp` param
- `buildAbAv1SvtFlags()` — drop `lp` param, no longer emits `--svt lp=N`

Remove the `threadsPerWorker` parameter from `buildAbAv1AomFlags()` — it was already unused (dead param). Signature becomes `buildAbAv1AomFlags(preset, hdrAom)`.

Remove `calculateThreadBudget`, `capSvtLpByPreset`, and `THREAD_PRESETS` from `module.exports`.

### Remove from all three plugins (av1anEncode, crfSearchEncode, abAv1Encode)

**Input definitions** — delete the `thread_strategy` and `thread_overrides` input objects from the plugin details array.

**Thread budget code** — delete all of:
- `threadStrategy` variable and parsing
- `threadOverrides` variable and JSON parsing
- `threadOverridesError` variable and warning log
- `isAutoThreads` variable
- `is4kHdr` variable (only used for thread budget)
- All `calculateThreadBudget()` calls and destructured results (`maxWorkers`, `threadsPerWorker`, `svtLp`, `vmafThreads`, `searchBudget`, `encodeBudget`)
- `availableThreads` variable (only used for thread budget; except in crfSearchEncode where it's used for vmaf n_threads — see below)

**Encoder flag building** — simplify to always use the auto path:
- `av1anEncode`: `encFlags = encoder === 'aom' ? buildAomFlags(preset, hdrAom) : buildSvtFlags(preset, hdrSvt)`
- `crfSearchEncode` phase 1: `searchEncFlags = encoder === 'aom' ? buildAbAv1AomFlags(preset, hdrAom) : buildAbAv1SvtFlags()`
- `crfSearchEncode` phase 2: `encFlags = (encoder === 'aom' ? buildAomFlags(preset, hdrAom) : buildSvtFlags(preset, hdrSvt)) + ' ' + crfFlag`
- `abAv1Encode`: `svtFlags = buildAbAv1SvtFlags()`

**av1an CLI args** — stop conditionally injecting `--workers` and `--vmaf-threads`. Just omit them entirely (av1an decides).

**ab-av1 CLI args (abAv1Encode)** — the `--vmaf n_threads=N:model=...` flag: use `os.cpus().length` directly instead of the budget calculator. This matches what crfSearchEncode already does in auto mode.

**ab-av1 CLI args (crfSearchEncode phase 1)** — keep using `os.cpus().length` for `n_threads` (already the auto behavior).

**Log lines** — remove thread-related log lines:
- `av1anEncode`: delete the `threads :` log line entirely
- `crfSearchEncode`: delete the `threads :` log line and simplify the phase 1/phase 2 log lines to remove lp/workers/threads info
- `abAv1Encode`: delete the `threads :` log line

### Remove from e2e test files

Delete `"thread_strategy": "auto"` from all test input objects in:
- `src/av1anEncode/e2e-tests.json`
- `src/crfSearchEncode/e2e-tests.json`
- `src/abAv1Encode/e2e-tests.json`

### Unused imports

After removal, `calculateThreadBudget` and `THREAD_PRESETS` imports can be dropped from all plugin files. `capSvtLpByPreset` was only used internally, so no import changes needed.

In `crfSearchEncode` and `abAv1Encode`, `os` is still needed for `os.cpus().length` (vmaf n_threads). In `av1anEncode`, `os` becomes unused — remove the import.

## What stays unchanged

- `detectHdrMeta()` — still needed for HDR flag passthrough
- `buildAomFlags()` — still builds all non-thread aomenc flags
- `svtConfig()` / `buildSvtFlags()` / `formatSvtForAv1an()` / `formatSvtForAbAv1()` — still build SVT-AV1 flags
- `buildAbAv1SvtFlags()` / `buildAbAv1AomFlags()` — still build ab-av1 encoder args
- Chunk method (`hybrid` / `lsmash`) — unchanged, orthogonal concern
- `--ignore-frame-mismatch` — stays (required by hybrid chunking)
