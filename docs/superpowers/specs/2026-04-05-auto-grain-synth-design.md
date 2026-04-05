# Auto Grain Synthesis Design

## Goal

Automatically detect source noise, let the AV1 encoder denoise it, and synthesize matching grain at decode time. Encoder-side denoising produces cleaner frames (smaller files), while decoder-side grain synthesis restores the original noise character at zero file size cost.

## Background

AV1 has a built-in film grain synthesis spec. Both SVT-AV1 (`--film-grain`) and aomenc (`--denoise-noise-level`) implement the same pipeline:

1. Wiener filter denoises the source at a user-specified strength
2. Encoder analyzes the residual (original - denoised) in flat regions
3. An auto-regressive (AR) noise model is fitted per frame
4. The denoised frames are encoded (better compression)
5. Grain parameters are embedded in the bitstream header
6. The decoder regenerates matching grain at playback

The grain synthesis adds essentially zero to file size since the decoder generates it from model parameters + shared Gaussian noise samples.

Both encoders use the same 0-50 scale, divided by 10 internally to produce a Wiener filter factor (0-5.0). The denoising strength scales quadratically with this factor.

## Approach

Encoder-native grain synthesis with automatic noise detection. No external denoising (BM3D, MVTools, etc.) — the encoder's built-in Wiener filter handles denoising, and its grain analysis pipeline models and reconstructs the noise.

The feature is a single toggle: on or off. When on, noise is estimated from the source and the appropriate encoder parameters are set automatically.

## New Shared Module: `src/shared/grainSynth.js`

### Responsibilities

1. **Estimate noise** — sample frames from the source via ffmpeg signalstats, compute noise sigma
2. **Map sigma to encoder param** — interpolate through a tunable control-point curve
3. **Return encoder flags** — encoder-specific flag strings for the caller

### Noise Estimation

Run ffmpeg signalstats on ~200 frames sampled from the middle of the source file:

```
ffmpeg -ss <mid_timestamp> -i <input> -frames:v 200 -vf signalstats -f null - 2>&1
```

Parse per-frame `YHUMED` (luma temporal difference median) or `YHUMEDAVG` values from stderr output — these correlate with noise energy in flat regions. Average across sampled frames to produce a single sigma estimate. The exact metric and any normalization will be validated during implementation by comparing signalstats output against known-noisy and known-clean test samples. The estimation takes 2-5 seconds — negligible compared to encode time.

The result is logged to `av1-debug.log` for inspection.

### Sigma-to-Parameter Mapping

Linear interpolation between tunable control points:

| Detected sigma | `--film-grain` / `--denoise-noise-level` |
|---------------|------------------------------------------|
| < 2           | skip (no grain processing)               |
| 2             | 4                                        |
| 4             | 8                                        |
| 6             | 15                                       |
| 10            | 25                                       |
| 15+           | 50 (capped)                              |

The control points live in a config object at the top of the module. These are initial values to be refined through test encodes.

Clean sources (sigma < 2) skip grain processing entirely — no encoder flags added, current behavior preserved.

### Flag Output

The module exports a function that takes `{ encoder, sigma }` and returns the flags to append:

**aomenc:**
- `--denoise-noise-level=<N>` (replaces current `--enable-dnl-denoising=0`)

**SVT-AV1 (av1an):**
- `--film-grain <N> --film-grain-denoise 1`

**SVT-AV1 (ab-av1):**
- `--svt film-grain=<N>` + `--svt film-grain-denoise=1`

When grain synthesis is disabled or source is clean, aomenc keeps `--enable-dnl-denoising=0` (current behavior), and SVT-AV1 gets no grain flags.

## Plugin Changes

### av1anEncode

Pipeline placement:

```
probe -> downscale check -> [NEW: noise estimation] -> build encoder flags -> av1an encode -> mux
```

- `grainSynth.estimate(inputPath)` called after probing, before flag construction
- Result passed to `buildAomFlags()` / `buildSvtFlags()` which incorporate grain params
- New FlowPlugin input: **Grain Synthesis** (boolean, default false)

### abAv1Encode

Same estimation step, same shared module:

```
probe -> [NEW: noise estimation] -> build ab-av1 flags -> ab-av1 encode
```

- Result passed to `buildAbAv1SvtFlags()` which adds `--svt film-grain=<N>` flags
- New FlowPlugin input: **Grain Synthesis** (boolean, default false)

## Encoder Flag Changes

### aomenc (grain enabled + noise detected)

Remove:
- `--enable-dnl-denoising=0`

Add:
- `--denoise-noise-level=<N>`

### aomenc (grain disabled or clean source)

No change from current behavior:
- `--enable-dnl-denoising=0`

### SVT-AV1 via av1an (grain enabled + noise detected)

Add:
- `--film-grain <N>`
- `--film-grain-denoise 1`

### SVT-AV1 via ab-av1 (grain enabled + noise detected)

Add:
- `--svt film-grain=<N>`
- `--svt film-grain-denoise=1`

## Tdarr FlowPlugin UI

One new boolean input on both plugins:

- **Name:** Grain Synthesis
- **Default:** false
- **Tooltip:** "Automatically detect noise, denoise during encoding, and synthesize matching grain at playback. Saves bitrate on noisy sources with no visual penalty."

No other user-facing controls. Detection and parameter selection are fully automatic.

## What This Does NOT Include

- No external denoising (BM3D, MVTools) — encoder-native Wiener filter handles it
- No manual grain level override — fully automatic when enabled
- No VapourSynth changes — noise estimation uses ffmpeg signalstats
- No new binary dependencies — ffmpeg signalstats is built-in

## Expected Impact

- **Clean sources (sigma < 2):** No change, skipped entirely
- **Moderate grain (sigma 4-6):** ~10-20% bitrate savings at same VMAF
- **Heavy grain (sigma > 10):** ~20-40%+ bitrate savings, grain reconstructed at playback

## Testing Plan

1. Encode samples across noise levels (clean, moderate, heavy) with grain synth on/off
2. Compare file sizes at equivalent VMAF targets
3. Subjective visual comparison of synthesized grain vs original
4. Verify clean sources are correctly detected and skipped
5. Tune the control-point curve based on results
6. Test both encoders (aomenc, SVT-AV1) and both plugins (av1an, ab-av1)

## Dependencies on Sibling Repo

None. No new binaries or VapourSynth plugins required. ffmpeg signalstats is built into ffmpeg which is already present.
