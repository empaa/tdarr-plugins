# VS Prefilter + Photon Noise Grain Synthesis

**Date:** 2026-04-08
**Status:** Draft
**Replaces:** Built-in encoder grain synthesis (aomenc `--denoise-noise-level`, SVT-AV1 `--film-grain`)

## Summary

Replace the built-in encoder denoiser + grain synthesis with a higher-quality pipeline:
1. **VapourSynth NLMeans prefilter** (vs-nlm-ispc) denoises the source before encoding
2. **av1an `--photon-noise`** adds physically-modeled synthetic grain at decode time
3. **Encoder built-in denoise/grain is always disabled** — both aomenc and SVT-AV1

This produces more visually pleasing results than the encoder's built-in wiener filter + grain synthesis, per av1an documentation and community consensus.

## Motivation

The av1an docs specifically recommend against using aomenc and SVT-AV1's built-in denoise/grain synthesis functions, as they produce uglier results than combining a VS prefilter with av1an's photon noise. The built-in wiener filters are basic compared to dedicated denoising algorithms, and the encoder's grain synthesis models are less natural-looking than photon noise tables.

## Architecture

### Pipeline Overview

```
Source → estimateNoise() → sigma >= 2? ─── no ──→ encode clean (no denoise, no grain)
                              │
                             yes
                              │
                              ▼
                    NLMeans in .vpy script
                    (denoise luma + chroma)
                              │
                              ▼
                    av1an --photon-noise N --chroma-noise
                    (add synthetic grain table)
                              │
                              ▼
                    Encoder with built-in denoise DISABLED
                    aom: --enable-dnl-denoising=0
                    svt: --film-grain 0 --film-grain-denoise 0
```

### Affected Plugins

All three encoding plugins are affected:
- `av1anEncode` — gets the new NLMeans + photon noise pipeline
- `crfSearchEncode` — gets the new pipeline (phase 2 av1an encode)
- `abAv1Encode` — grain synthesis removed entirely (no av1an, no VS pipeline)

### Component Changes

#### 1. `encoderFlags.js` — Remove `grainParam`, always disable built-in denoise

**Current:** `buildAomFlags(preset, threads, hdr, grainParam)` — passes `grainParam` to encoder flags.

**New:** `buildAomFlags(preset, threads, hdr)` — no `grainParam` parameter. Always emits:
- aomenc: `--enable-dnl-denoising=0`
- SVT-AV1: `--film-grain 0 --film-grain-denoise 0`

All flag builder functions lose the `grainParam` parameter:
- `buildAomFlags(preset, threads, hdr)`
- `buildSvtFlags(preset, lp, hdr)`
- `buildAbAv1SvtFlags(lp)`
- `buildAbAv1AomFlags(preset, threads, hdr)`

#### 2. `grainSynth.js` — Return NLMeans + photon noise params instead of encoder grain param

**Current exports:**
```js
estimateNoise() → { sigma, grainParam }
mapSigmaToGrainParam(), GRAIN_CURVE
```

**New exports:**
```js
estimateNoise() → { sigma, nlmH, nlmChromaH, photonNoise }
mapSigmaToNlmH(), mapSigmaToPhotonNoise()
DENOISE_CURVE, PHOTON_CURVE
```

- `sigma` — raw estimated luma noise sigma (unchanged)
- `nlmH` — NLMeans `h` parameter for luma denoising (mapped from sigma via `DENOISE_CURVE`)
- `nlmChromaH` — NLMeans `h` parameter for chroma denoising (mapped from sigma × 0.5)
- `photonNoise` — av1an `--photon-noise` value (mapped from sigma via `PHOTON_CURVE`)

`DENOISE_CURVE` and `PHOTON_CURVE` control points are derived empirically via the calibration test (see below).

The old `GRAIN_CURVE`, `mapSigmaToGrainParam` are removed.

#### 3. VapourSynth `.vpy` Script — Add NLMeans denoise block

When grain synth is enabled and sigma >= threshold, the `.vpy` script includes:

```python
import vapoursynth as vs
core = vs.core
src = core.lsmas.LWLibavSource(source='...', cachefile='...')

# NLMeans denoise (only when sigma >= threshold)
src = core.nlm_ispc.NLMeans(src, d=1, a=2, s=4, h=<nlmH>, channels="Y")
src = core.nlm_ispc.NLMeans(src, d=1, a=2, s=4, h=<nlmChromaH>, channels="UV")

# optional: downscale (after denoise)
src.set_output()
```

NLMeans parameters:
- `d=1` — temporal radius (3 frames: prev/current/next)
- `a=2` — spatial search radius
- `s=4` — similarity patch size
- `h` — denoising strength (adaptive, from sigma mapping)
- `channels` — separate calls for luma ("Y") and chroma ("UV") at different strengths

Denoise happens before downscale — denoising at full resolution is more effective.

When grain synth is disabled or sigma < threshold, the `.vpy` has no NLMeans block (same as today).

#### 4. av1an Args — Add `--photon-noise` and `--chroma-noise`

When grain synth is enabled and sigma >= threshold, add to av1an args:
- `--photon-noise <photonNoise>` — luma grain synthesis intensity
- `--chroma-noise` — boolean flag, enables chroma grain at the same intensity

When sigma < threshold or grain synth disabled: no photon noise args.

#### 5. Plugin Index Files — Wire it all together

Each plugin's `index.js` changes:
- Call `estimateNoise()` as before, but destructure `{ sigma, nlmH, nlmChromaH, photonNoise }` instead of `{ sigma, grainParam }`
- If sigma >= threshold: generate `.vpy` with NLMeans block, add `--photon-noise` to av1an args
- If sigma < threshold: no NLMeans in `.vpy`, no photon-noise args
- Encoder flags calls lose the `grainParam` argument
- Log output updated to reflect new pipeline

#### 6. `crfSearchEncode` — Two-phase handling

`crfSearchEncode` has two phases sharing the same `.vpy` script:
- **Phase 1 (ab-av1 CRF search):** Reads the `.vpy` (with NLMeans prefilter) — searches for optimal CRF on the denoised signal. No `--photon-noise` here (ab-av1 doesn't support it). This is correct — we want the CRF tuned for the clean signal.
- **Phase 2 (av1an encode):** Uses the same `.vpy` + adds `--photon-noise` and `--chroma-noise` to av1an args. Full pipeline applies.

#### 7. `abAv1Encode` — Drop grain synthesis

`abAv1Encode` uses ab-av1 directly (no av1an, no VapourSynth pipeline), so the new grain synthesis pipeline cannot apply. Since `crfSearchEncode` supersedes `abAv1Encode` for all grain synthesis use cases, grain synthesis support is removed entirely from `abAv1Encode`:
- Remove the `grain_synth` input toggle from the plugin UI
- Remove all grain estimation and `grainParam` code
- Remove `grainSynth.js` import
- Encoder built-in denoise is always explicitly disabled (`--film-grain 0 --film-grain-denoise 0`)

### Error Handling

- If `nlm_ispc` plugin is not available AND sigma >= threshold AND grain synth is enabled: **throw error** — "Grain synthesis requires vs-nlm-ispc plugin. Disable grain_synth or install the plugin."
- If sigma < threshold: proceed normally regardless of plugin availability
- If `grain_synth` is disabled: no checks, no NLMeans, no photon noise

### Chroma Noise Model

- Chroma noise is estimated as `luma_sigma × 0.5` (standard heuristic — camera sensors filter chroma more aggressively)
- NLMeans chroma `h` is derived by mapping `sigma × 0.5` through the same `DENOISE_CURVE`
- `--chroma-noise` is a boolean flag in av1an (not a separate intensity) — chroma grain uses the same ISO as luma

## Calibration Test

Empirically derive the `DENOISE_CURVE` (sigma → NLMeans `h`) and `PHOTON_CURVE` (sigma → photon-noise value) by testing with known noise levels.

### Phase 1: Generate Test Clips with Known Sigma

- Start with a clean reference clip (generate a synthetic clip with VapourSynth, or use a known-clean source)
- Add Gaussian noise at specific sigma levels using VapourSynth: **2, 3, 4, 6, 8, 10, 15**
- Run our `estimateNoise()` on each noisy clip to verify our estimation accuracy

### Phase 2: Calibrate NLMeans h → sigma mapping (DENOISE_CURVE)

For each sigma test point:
1. Generate noisy clip (clean + Gaussian noise at sigma N)
2. Denoise with NLMeans at a range of `h` values (e.g., 0.5 to 5.0 in steps)
3. Measure PSNR of each denoised result vs the clean original
4. The `h` value producing the best PSNR is the optimal denoising strength for that sigma
5. Record: `{ sigma: N, h: optimal_h }`

Result: a set of control points for `DENOISE_CURVE`.

### Phase 3: Calibrate photon-noise → sigma mapping (PHOTON_CURVE)

For each sigma test point:
1. Take the optimally-denoised clip from Phase 2
2. Encode with av1an at various `--photon-noise` values (e.g., 1 to 40 in steps)
3. Decode each encoded output
4. Measure the apparent noise sigma of the decoded output (using our `estimateNoise()`)
5. The photon-noise value that produces output sigma closest to the original source sigma is the match
6. Record: `{ sigma: N, photonNoise: matching_value }`

Result: a set of control points for `PHOTON_CURVE`.

### Test Infrastructure

- Runs inside the Docker container (needs vspipe, av1an, ffmpeg)
- Automated script that runs all phases and outputs the curve control points
- Can be re-run when we change denoiser settings or want to re-calibrate
- Test clips are short (a few seconds) to keep runtime manageable

### Interpolation

Both curves use linear interpolation between control points (same as current `GRAIN_CURVE` implementation). Below `SIGMA_SKIP_THRESHOLD` (2), all values return 0.

## Migration

This is a full replacement, not an addition:
- `GRAIN_CURVE` → removed, replaced by `DENOISE_CURVE` + `PHOTON_CURVE`
- `mapSigmaToGrainParam()` → removed, replaced by `mapSigmaToNlmH()` + `mapSigmaToPhotonNoise()`
- `grainParam` parameter → removed from all encoder flag functions
- Encoder built-in denoise → always explicitly disabled
- No backward compatibility shim — the old approach is fully replaced
