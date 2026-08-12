# Encoder settings research — method and status

Emil's ask, relayed through hometower: recommended settings for **low / mid / top tier**,
for **both mainline SVT-AV1 and the psy (hdr) fork**. Our previous tuning predates
everything learned in the xav bake-off, was never done against the psy fork, and was done
against a metric that cannot discriminate at our operating point.

## The objective is a frontier, not a score

This is **not** a hunt for better quality. In AV1, preset is primarily a
compression-efficiency-vs-time knob rather than a quality knob: under a quality target the
encoder lands on the target regardless, and a faster preset simply spends more bits getting
there. The parameters carry most of the real gain.

So what is being optimised is **bytes at matched quality per unit of encoding time**, with
quality held fixed as a constraint rather than read as an output.

The bake-off already demonstrated the shape: at matched SSIMULACRA2 72.45, xav hdr and xav
mainline differed by 14.6% in bytes and 85% in time while landing on the *same* quality.
That difference is only visible because quality was pinned.

## Why the old basis is unusable

| Encode | Wall | Video bytes | SSIMU2 | σ | min | VMAF |
|---|---|---|---|---|---|---|
| av1an SVT, target VMAF 95 | 124 s | 212,367,543 | 72.456 | 9.03 | 46.44 | 99.957 |
| av1an **AOM**, target VMAF 95 | **681 s** | 164,544,272 | **68.154** | 11.77 | 39.08 | 99.614 |
| xav hdr, matched to SVT | 178 s | 202,492,484 | 72.447 | **2.18** | **64.35** | 99.052 |
| xav mainline, matched to SVT | **96 s** | 237,218,617 | 72.442 | 2.51 | 51.55 | 99.249 |

1. **VMAF is saturated here.** Every encode scores 99.05–99.96 across a 4.4x bitrate range,
   and the ordering is inverted — our SVT run gets the *highest* VMAF with nearly the worst
   consistency. Any tuning done against VMAF above ~95 optimised a metric with no gradient.
2. **We do not get VMAF 95.** SVT lands at 99.957, AOM at 99.614, on the same
   `vmaf_v0.6.1` model our `--vmaf-path` targets.
3. **The AOM tier is not the top tier.** On this sample it produced a *smaller* file at
   *lower* SSIMULACRA2 than SVT for 5.5x the wall-clock, with the worst consistency
   measured. Possibly entirely the settings — which is the point of this run — but until
   re-derived it cannot be treated as the quality reference.
4. **Consistency, not mean, is where encoders differ.** At identical mean SSIMULACRA2 the
   distributions are not comparable (σ 2.18 vs 9.03). Mean-only tuning keeps missing this.

## Method

Executable form: `/mnt/vm_data/xav-work/host/run-param-sweep.sh`, run on HomeTower
(the GPU is needed for Vship scoring).

- **Objective metric: SSIMULACRA2**, via xav's own TQ search, whose convergence was
  independently verified against FFVship to within 0.02. VMAF recorded for continuity only,
  never tuned to.
- **Compare at matched quality**, never at matched CRF or matched target. Every run targets
  an achieved band and we compare the bytes and wall-clock it took to land there.
- **One-factor-at-a-time from a baseline.** Full factorial is untenable at ~200 s per run.
  OFAT identifies which axes carry the gain; a follow-up confirm run combines the winners.
- **Validity gates.** A run that exits non-zero, produces no video, or lands with every
  chunk pinned at a CRF bound measured nothing and is recorded `FAILED` /
  `INVALID_pinned_*`. The script reports `at_floor` / `at_ceiling` per run for this reason.
- **Fixed hardware envelope.** `-w 2 -v 1`, `--memory 16g`, identical across every run
  compared on wall-clock. Uncapped xav previously drove the host into global OOM and the
  kernel killed the workstation VM's qemu process.

### Tiers

Targets chosen from measurement, not taste:

| tier | target SSIMU2 | rationale |
|---|---|---|
| low | 67.8–68.2 | where av1an AOM actually landed on Avatar (68.15) |
| mid | 72.3–72.7 | parity with the current av1an SVT tier (72.46) |
| top | 84.8–85.2 | solidly inside the "high" band (90+ = visually lossless) |

### Baseline and variants

Baseline is our current production av1an SVT param string, minus what xav owns.
Variants each differ on exactly one axis: `preset2`, `preset6`, `tune0`, `tune2`,
`no_varboost`, `varboost_s3`, `varboost_oct4`, `no_qm`, `no_psy`, `lookahead_def`.

Sample: `avatar_fna_sample.mkv` — 1080p, 2899 frames, clean digital, motion-selected window,
video-only. Grain-heavy content behaves differently and is a second pass, not this one:
the Jurassic 35mm sample saturates fidelity metrics and made earlier results unreadable.

## Finding already produced by this run

**An av1an parameter string cannot be handed to xav unfiltered.** xav validates encoder
params itself (`src/svterr.rs`) and aborts with "argument parsing failed" before encoding
anything. Five of our production flags are hard-rejected, with xav's stated reasons:

| flag | why xav rejects it |
|---|---|
| `--input-depth 10` | xav only ever encodes yuv420p10le; setting it is an error |
| `--lookahead 48` | svt-av1 locks lookahead internally |
| `--keyint -1` | xav sets keyint itself — chunk starts *are* keyframes |
| `--irefresh-type 2` | on xav's NOT_RELEVANT list |
| `--enable-overlays 1` | rejected as "always dangerous" with svt-av1 |

The first sweep launch died on all 40 runs in 20 seconds this way. This is now encoded in
the plugins: `filterEncoderParams` in `src/shared/xav.js` strips these (plus `--crf`,
`--rc`, `--scd`, which target-quality and xav's scene detection own) and logs each drop
with its reason.

## Status

Running on HomeTower, launched 2026-08-12 ~23:05, detached, ~3.5 h expected.
Results append to `/mnt/vm_data/xav-work/bench/param-sweep-results.tsv` after every run, so
an interruption loses nothing and a re-run resumes.

First completed row, as a sanity check on the method:

    mid  xavhdr  baseline  exit 0  197s  190,503,575 bytes  25 chunks
         mean_score 72.53 (min 72.36 max 72.70)  mean_crf 21.86
         at_floor 0  at_ceiling 0  1920x1040  ok

Converged, nothing pinned, inside the target band.

## Reading the results

For each tier, within each binary, rank valid rows by `video_bytes` and by `seconds`. The
recommendation per tier is **two sets — one mainline, one psy — with the time cost stated**,
not a single winner: the bake-off suggests they are different points on the frontier rather
than better and worse.

Then confirm: combine the winning axes into one param set per tier per fork and re-run. OFAT
winners do not always compose, so the combined set must be measured, not assumed.

## Open, not covered by this run

- **Grain-heavy content** as a second sample.
- **The top-tier question**: whether anything reaches AOM-class quality at comparable size
  but meaningfully faster. Note the premise is now shaky — AOM at current settings did not
  reach a higher quality tier than SVT at all.
- **4K sources.** The sweep is 1080p only.
- **The production VMAF overshoot**, which is a live bug independent of all of this: we ask
  for 95 and ship 99.957, costing bitrate on every encode until these tiers are re-derived.
