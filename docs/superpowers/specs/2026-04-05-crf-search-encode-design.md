# crfSearchEncode Plugin Design

## Overview

A hybrid two-phase encoding plugin that combines ab-av1's CRF search with av1an's multi-worker chunked encoding. Phase 1 uses `ab-av1 crf-search` to find a single CRF that meets a VMAF target. Phase 2 feeds that CRF into `av1an` for fast parallel encoding without per-chunk quality search.

The result: ab-av1's quality targeting with av1an's speed.

## Motivation

- **av1anEncode** (target-quality mode) is accurate but slow — it runs VMAF probes per chunk to find the right QP for each.
- **abAv1Encode** finds a good CRF quickly but encodes single-threaded.
- This plugin takes the best of both: a single CRF search (fast, samples across the whole file) followed by a multi-worker encode at that fixed CRF (no per-chunk probing overhead).

## Encoder Support

Both aom and svt-av1 from day one. ab-av1 supports `--encoder libaom-av1` and `--encoder libsvtav1` natively. av1an supports both via `-e aom` and `-e svt-av1`.

## Shared Flag Refactor

Currently `buildSvtFlags` (for av1an) and `buildAbAv1SvtFlags` (for ab-av1) diverge — different lookahead, missing flags in ab-av1 variant. This must be fixed so both phases use identical encoder settings.

**Approach:** Extract a single shared config object that defines all encoder settings. Two formatter functions convert it to the target format:

- `--key value` format for av1an's `-v` flag
- `--svt key=value` format for ab-av1's `--svt` flag
- `--enc key=value` format for ab-av1's aom encoder flags

This ensures the CRF found during search produces the same quality when used in av1an.

## Phase 1: CRF Search

Runs `ab-av1 crf-search` to find a suitable CRF without doing a full encode.

```
ab-av1 crf-search
  --input <file>
  --encoder <libsvtav1|libaom-av1>
  --min-crf <user_min_crf>
  --max-crf <user_max_crf>
  --min-vmaf <user_target_vmaf>
  --max-encoded-percent <user_max_encoded_percent>
  --vmaf n_threads=<N>:model=path=<vmaf_model>
  --svt/--enc <flags from shared config>
```

### Thread budget

Single-process mode for the search (same as current abAv1Encode). The search is I/O-light and fast — no need for multi-worker overhead.

### Output parsing

Parse ab-av1 stdout for the chosen CRF value. ab-av1 outputs the found CRF on success.

### Failure handling

If ab-av1 fails to find a suitable CRF (no CRF in range meets VMAF target, or predicted size exceeds `max_encoded_percent`), the plugin passes the input file through on **output 2** (Tdarr convention for "criteria not met, skip encoding").

## Phase 2: Chunked Encode

Runs `av1an` with the found CRF in fixed-CRF mode (no `--target-quality`, no `--qp-range`).

```
av1an
  -i <vpy_script>
  -o <output.mkv>
  --temp <temp_dir>
  -c mkvmerge
  -e <aom|svt-av1>
  --sc-downscale-height 540
  --scaler lanczos
  --workers <N>
  --chunk-order long-to-short
  --keep
  --resume
  --verbose
  -v "<encoder_flags> --crf <found_crf>"
```

For aom, the CRF is passed as `--cq-level=<found_crf>` instead of `--crf`.

### Thread budget

Multi-worker mode using the same thread strategy presets and `calculateThreadBudget` as av1anEncode.

### VapourSynth pipeline

Same as av1anEncode — lsmas source, optional Lanczos3 downscale, grain estimation via `estimateNoise()`.

### Size monitoring

The av1an size monitor (from shared progressTracker) checks encoded output against `max_encoded_percent` during the encode. Uses the same `max_encoded_percent` value the user set — not a hardcoded default. If exceeded mid-encode, abort and pass-through on output 2.

## Size Guard: Two Layers

1. **Pre-encode (Phase 1):** ab-av1's `--max-encoded-percent` rejects CRFs that would produce files too large, before any av1an encode starts. Cheap and fast.
2. **During encode (Phase 2):** The av1an size monitor catches cases where the fixed CRF produces a larger file than predicted (different content distribution across chunks vs ab-av1's samples). Safety net only.

Both use the user's `max_encoded_percent` setting.

## User-Facing Parameters

Same parameter set as av1anEncode, ensuring consistency across plugins:

| Parameter | Description | Default |
|-----------|-------------|---------|
| encoder | `aom` or `svt-av1` | `svt-av1` |
| target_vmaf | VMAF score target | 93 |
| min_crf | Minimum CRF for search | 10 |
| max_crf | Maximum CRF for search | 50 |
| preset | cpu-used (aom) or preset (SVT-AV1) | 4 |
| max_encoded_percent | Abort if output exceeds % of source | 80 |
| downscale_enabled | VapourSynth pre-filter downscaling | false |
| downscale_resolution | Target resolution (720p/1080p/1440p) | 1080p |
| thread_strategy | safe/balanced/aggressive/max/custom | auto |
| thread_overrides | JSON for custom thread control | - |
| grain_synth | Auto noise detection and film-grain synthesis | false |

All parameters are passed to both ab-av1 (Phase 1) and av1an (Phase 2).

## Progress Tracking

- **Phase 1:** Reuse `abAv1Tracker` from shared modules. Shows CRF search progress.
- **Phase 2:** Reuse `av1anTracker` from shared modules. Shows encode progress, FPS, ETA, size estimate.

Tdarr progress bar shows both phases sequentially. Phase 1 is typically fast (seconds to a few minutes). Phase 2 is the bulk of the work.

## Project Structure

```
src/crfSearchEncode/index.js    # Plugin source
src/shared/encoderFlags.js      # Refactored: shared config + formatters
dist/LocalFlowPlugins/video/crfSearchEncode/1.0.0/index.js  # Bundled output
```

## Audio Handling

Same as the other plugins — audio streams are copied/merged via the shared `audioMerge` module. No re-encoding of audio.
