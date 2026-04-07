# Scene Detection Rework: `--sc-only` + `--scenes`

## Summary

Replace the fragile benchmark warmup mechanism (kill-polling, backup/restore, `--resume`) with av1an's `--sc-only` and `--scenes` flags. Additionally, run scene detection in parallel with CRF search in crfSearchEncode to eliminate dead time between phases.

## Background

The benchmark tool's warmup mode spawns av1an with a fast preset, polls every 3s for `scenes.json` and `chunks.json`, kills av1an once both appear, backs up the files, and restores them with `--resume` for each iteration. This is fragile and was defaulted to off because of reliability issues.

av1an provides two flags that solve this cleanly:
- `--sc-only` — runs scene detection and exits naturally (requires `--scenes`)
- `--scenes <path>` — loads pre-computed scenes, skipping detection entirely

### Verified behaviour (tested on tdarr-interactive-node)

- `--sc-only` writes a JSON file with `frames`, `scenes` (raw boundaries), and `split_scenes` (after extra_splits/min-scene-len)
- `--sc-only` does **not** create a temp/work directory — clean exit
- `--sc-only` **does** generate the lwi index cache, which subsequent runs can reuse
- `--scenes` on encode skips the "Scene detection" step entirely — jumps straight to chunk queuing
- Scene detection args (`--sc-downscale-height`, `--min-scene-len`) must match between `--sc-only` and the encode run
- `--chunk-method` is irrelevant for `--sc-only` — it controls how frames are piped to the encoder, not scene detection

## Scope

Two changes, one mechanism:

1. **Benchmark warmup rework** (`test/benchmark.js`)
2. **crfSearchEncode parallel scene detection** (`src/crfSearchEncode/index.js`)

Out of scope: av1anEncode (no parallel workload to overlap with).

---

## Change 1: Benchmark Warmup Rework

### Current flow (warmup mode)

1. Build VapourSynth script with fast preset
2. Spawn `av1an --workers 1 --cpu-used 8`
3. Poll every 3s for `scenes.json` + `chunks.json` in temp dir
4. Kill av1an once both exist
5. Back up to `scenes_backup.json` / `chunks_backup.json`
6. Each iteration: restore backups, reset `done.json`, run with `--resume`
7. Detect encode-start by polling for first encoded bytes, distinguish elapsed vs encode-only time

### New flow (warmup mode)

1. Run `av1an --sc-only --scenes <path>` with the same VapourSynth script and scene detection parameters as the benchmark iterations will use
2. av1an exits naturally when scene detection completes
3. Each iteration: pass `--scenes <path>` to av1an — pure encode, no detection overhead
4. Timing: start timestamp -> av1an exits = encode time (no encode-start detection needed)

### What gets removed

- Kill-polling loop
- Backup/restore logic (`scenes_backup.json`, `chunks_backup.json`)
- `--resume` flag from warmup benchmark iterations
- `done.json` reset
- Encode-start detection logic (polling for first encoded bytes)
- Elapsed-vs-encode-only time distinction in warmup mode

### Default behaviour change

- `--warmup` becomes the **default** again (was disabled because the old mechanism was fragile)
- `--no-warmup` opts out: av1an runs normally with scene detection included in timing, no special handling

---

## Change 2: crfSearchEncode Parallel Scene Detection

### Current flow

1. Grain estimation (blocking)
2. Phase 1: ab-av1 CRF search (blocking)
3. VapourSynth script + lwi index creation
4. Phase 2: av1an encode (scene detection -> chunked encode)

### New flow

1. Grain estimation (blocking)
2. VapourSynth script + lwi index creation (moved earlier)
3. Spawn `av1an --sc-only --scenes <path>` as background process (not awaited yet)
4. Phase 1: ab-av1 CRF search (runs in parallel with scene detection)
5. If CRF search **failed** -> kill scene detection process, exit output 2
6. If CRF search **succeeded** -> await scene detection completion (update status to "Scene Detection" if still running)
7. If scene detection **failed** -> throw error
8. Phase 2: av1an encode with `--scenes <path>` (skips detection, straight to encoding)

### Scene detection args (must match phase 2)

- Same VapourSynth script (`vpyScript`)
- Same `--sc-downscale-height 540`
- Same `--min-scene-len 24`
- Same lwi cache path (shared between `--sc-only` and phase 2)

### Process lifecycle

- Scene detection is spawned via `pm.spawnAsync()` but the promise is held, not awaited immediately
- `pm.installCancelHandler()` calls `pm.killAll()` — scene detection process is spawned through `pm`, so it gets killed on cancel automatically
- CRF search failure/early exit -> `pm.killAll()` before returning (kills scene detection)
- Scene detection failure (non-zero exit) -> throw error before starting phase 2

### Status updates

- During phase 1: "CRF Search" (unchanged)
- If CRF search finishes before scene detection: "Scene Detection"
- Phase 2: "Encoding" (unchanged)

### Future note

Grain estimation stays blocking for now. If grain synthesis detection becomes more time-consuming in the future, it is a candidate for parallelization alongside scene detection during phase 1.
