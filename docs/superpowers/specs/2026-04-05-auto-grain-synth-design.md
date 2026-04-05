# Auto Grain Synthesis Design (v2 — VapourSynth)

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

Both encoders use the same 0-50 scale.

## Why VapourSynth Instead of ffmpeg

The v1 design used ffmpeg signalstats YDIF for noise estimation. Testing against the tdarr test server revealed that ffmpeg does not output usable sigma values — YDIF is an average absolute temporal luma difference that doesn't reliably correlate with actual noise sigma, especially across different content types.

VapourSynth provides precise per-frame plane statistics via `std.PlaneStats`, and `vspipe` is already a runtime dependency for the av1an plugin's source pipeline.

## Approach

Temporal frame differencing via VapourSynth built-ins. No extra VS plugins required — only `std.Expr`, `std.PlaneStats`, `std.ShufflePlanes`, and `std.ModifyFrame`.

The feature remains a single toggle: on or off. When on, noise is estimated from the source and the appropriate encoder parameters are set automatically.

## Noise Estimation Method

### Algorithm

1. Load source via `lsmas.LWLibavSource` (reuses the `.lwi` index cache)
2. Extract luma plane (`std.ShufflePlanes`, `planes=0`, `colorfamily=GRAY`)
3. Sample 4 regions of ~50 frames each, evenly spaced across the video (at 15%, 35%, 55%, 75% of total frames — avoids start/end which often have logos, credits, black)
4. For each region, compute per-frame absolute temporal difference: `std.Expr([frame_n, frame_n+1], 'x y - abs')`
5. Run `std.PlaneStats` on each diff frame
6. `std.ModifyFrame` callback prints `SIGMA:<value>` to stderr for each frame
7. Splice the 4 regions and `set_output()`

### MAD-to-Sigma Conversion

`PlaneStatsAverage` returns the mean absolute deviation (MAD) of the diff frame, normalized to 0.0–1.0. Convert to noise sigma:

```
sigma = PlaneStatsAverage × 255 × √(π/2) / √2
      = PlaneStatsAverage × 255 × 1.2533 / 1.4142
```

- `× 255`: convert from normalized to 8-bit pixel scale (always 255, regardless of source bit depth — PlaneStatsAverage is already normalized, and 8-bit scale keeps sigma in a familiar range)
- `× √(π/2)` (≈ 1.2533): convert MAD to standard deviation for Gaussian noise
- `/ √2` (≈ 1.4142): correct for differencing two identically-noisy frames (noise variance doubles, so sigma scales by √2)

### Aggregation

Collect all per-frame sigma values (~200 total across 4 regions), take the **median**. The median is robust to:
- Scene changes (outlier high values)
- Static black frames (outlier low values)
- Motion-heavy sections (high values filtered by multi-point sampling + median)

### Generated .vpy Script

The script is generated dynamically at runtime (same pattern as the existing av1an source script). Example structure:

```python
import vapoursynth as vs
import sys

core = vs.core
src = core.lsmas.LWLibavSource(source='<input>', cachefile='<lwi_path>')
src = core.std.ShufflePlanes(src, planes=0, colorfamily=vs.GRAY)

# Sample 4 regions of 50 frames each
clips = []
for start in [<pos1>, <pos2>, <pos3>, <pos4>]:
    region = src[start:start+51]
    base = region[:-1]
    shifted = region[1:]
    diff = core.std.Expr([base, shifted], expr=['x y - abs'])
    diff = core.std.PlaneStats(diff)
    clips.append(diff)

out = core.std.Splice(clips)

def _print_stats(n, f):
    avg = f.props['PlaneStatsAverage']
    sigma = avg * 255.0 * 1.2533 / 1.4142
    print(f'SIGMA:{sigma:.4f}', file=sys.stderr, flush=True)
    return f

out = core.std.ModifyFrame(out, out, _print_stats)
out.set_output()
```

### Execution

```
vspipe -p noise_estimate.vpy - 2>&1
```

Progress mode (`-p`), output piped to null, sigma values captured from stderr.

## Updated Module: `src/shared/grainSynth.js`

### New Signature

```
estimateNoise(inputPath, durationSec, totalFrames, vspipeBin, lwiCache, dbg)
```

- `inputPath` — source video file
- `durationSec` — total duration (for logging)
- `totalFrames` — total frame count (for calculating sample positions)
- `vspipeBin` — path to vspipe binary
- `lwiCache` — path to shared `.lwi` index file
- `dbg` — debug logger function

### Flow

1. Calculate 4 sample start positions at 15%, 35%, 55%, 75% of `totalFrames`
2. Generate `.vpy` script with those positions, 50 frames each
3. Write to `noise_estimate.vpy` in the same directory as `.lwi` cache
4. `spawnSync(vspipeBin, ['-p', vpyPath, '-'], { timeout: 60000 })`
5. Parse `SIGMA:<value>` lines from output
6. Take median as final sigma
7. Map through `mapSigmaToGrainParam()` curve
8. Clean up temp `.vpy` file
9. Return `{ sigma, grainParam }`

### Error Handling

If vspipe fails or no SIGMA values are parsed, return `{ sigma: 0, grainParam: 0 }` — grain synthesis is silently skipped. Errors are logged via `dbg()`.

### .lwi Index Reuse

The noise estimation creates/reuses the `.lwi` index at the provided path. In `av1anEncode`, this is the same `.lwi` the encode step uses — so the encode step's separate indexing step is skipped if it already exists. In `abAv1Encode`, the `.lwi` is created during estimation but not reused (ab-av1 doesn't use VapourSynth).

## Sigma-to-Parameter Mapping (Unchanged)

Linear interpolation between tunable control points:

| Detected sigma | `--film-grain` / `--denoise-noise-level` |
|---------------|------------------------------------------|
| < 2           | skip (no grain processing)               |
| 2             | 4                                        |
| 4             | 8                                        |
| 6             | 15                                       |
| 10            | 25                                       |
| 15+           | 50 (capped)                              |

These are initial values calibrated against YDIF. May need retuning after test encodes with the new VS-based sigma values, since the measurement method changed.

## Plugin Changes

### av1anEncode

```
probe -> [noise estimation via VS] -> build encoder flags -> [.lwi already cached] -> av1an encode -> mux
```

- `estimateNoise` called with `totalFrames, BIN.vspipe, lwiCache`
- Reuses existing `vsDir` and `lwiCache` paths
- `.lwi` index from estimation is reused by encode — the separate "Indexing" step can be skipped if `.lwi` exists

### abAv1Encode

```
probe -> [noise estimation via VS] -> build ab-av1 flags -> ab-av1 encode
```

- Add `vspipe` to binary resolution (`findBin('vspipe', '/usr/local/bin/vspipe', '/usr/bin/vspipe')`)
- Create `vsDir` + `lwiCache` path in work directory
- `estimateNoise` called with `totalFrames, vspipeBin, lwiCache`

## Encoder Flag Integration (Unchanged)

Encoder flags are set via `grainParam` passed to existing flag builders:

- **aomenc:** `--denoise-noise-level=<N>` (or `--enable-dnl-denoising=0` when skipped)
- **SVT-AV1 via av1an:** `--film-grain <N> --film-grain-denoise 1`
- **SVT-AV1 via ab-av1:** `--svt film-grain=<N>` + `--svt film-grain-denoise=1`

## Tdarr FlowPlugin UI (Unchanged)

One boolean input on both plugins:

- **Name:** Grain Synthesis
- **Default:** false
- **Tooltip:** "Automatically detect noise, denoise during encoding, and synthesize matching grain at playback. Saves bitrate on noisy sources with no visual penalty."

## Dependencies on Sibling Repo

`vspipe` and `lsmas` are already shipped in the tdarr-av1 Docker images. No new binaries required. `abAv1Encode` newly depends on `vspipe` at runtime (only when grain synth is enabled).

## Testing Plan

1. Encode samples across noise levels (clean, moderate, heavy) with grain synth on/off
2. Compare file sizes at equivalent VMAF targets
3. Subjective visual comparison of synthesized grain vs original
4. Verify clean sources are correctly detected and skipped
5. Compare VS sigma values against known-noisy test samples to validate accuracy
6. Tune the control-point curve based on results
7. Test both encoders (aomenc, SVT-AV1) and both plugins (av1an, ab-av1)

## Expected Impact

- **Clean sources (sigma < 2):** No change, skipped entirely
- **Moderate grain (sigma 4-6):** ~10-20% bitrate savings at same VMAF
- **Heavy grain (sigma > 10):** ~20-40%+ bitrate savings, grain reconstructed at playback
