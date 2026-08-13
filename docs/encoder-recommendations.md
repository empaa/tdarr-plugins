# Encoder and parameter recommendations

Status 2026-08-13. Every recommendation is tagged by what it rests on:
**measured** (our own runs), **researched** (community sources, see
`svt-av1-settings-research.md`), or **untested**.

Measured on two very different sources — clean digital (Avatar 1080p remux) and
35mm-era film (Jurassic Park). 4K is entirely unmeasured, and anything the metric
cannot see is marked as such.

**One parameter set serves all content types.** The grain sweep found the same
arms winning on both sources at every tier, so no grain/clean detection or
routing is needed to choose settings.

---

## 1. Tier targets

Working definition, SSIMULACRA2. Bands: 90+ visually lossless, 70–90 high,
50–70 medium.

**Decided 2026-08-13.** Tiers are assigned by SOURCE TYPE, not by preference —
which matches the target to the headroom actually available.

| tier | source | target | size gate |
|---|---|---|---|
| low | TV, almost always WEB-DL/WEBRIP | **70** | 80% |
| mid | movies that are not 1080p remux | **75** | 80% |
| top | 1080p remux only | **80** | 80% |

The size gate is 80% everywhere: if an encode cannot save a fifth of the file it
is not worth doing, and the original passes through. That matters most at the low
tier, where WEB-DL sources have the least headroom and generation loss compounds
on an already-lossy source.

**These are a product decision, not a measurement.** Everything else in this
document is conditional on them.

### The cost curve is steeply non-linear, and the top tier can grow files

Measured, xav hdr on the Avatar sample. Source video is 374,764,422 bytes for
120.911 s (~24.8 Mbps AVC 1080p):

| target | output bytes | % of source |
|---|---|---|
| 72.45 | 202,492,484 | 54% |
| 80 | 333,037,294 | 89% |
| **85** | **509,502,004** | **136%** |
| 90 | 895,337,490 | 239% |

Interpolating the chosen tiers: **70 ≈ 48%, 75 ≈ 66%, 80 ≈ 89%.**

**At 85 the output exceeds the source**, which is why 80 was chosen as the
ceiling. This is structural, not a quirk of the sample: SSIMULACRA2 scores
against the *source file*, not a master. Above a certain target you are paying to
faithfully reproduce the source's own AVC compression artifacts.

**IMPORTANT CAVEAT on all percentages above.** The Avatar sample is the busiest
sustained-motion window in the film (mean motion 16.29, against 3.71 for a
locked-off shot elsewhere), deliberately selected that way for the bake-off. The
source is near-constant-bitrate but our encode cost tracks content, so cheap
scenes shrink while the source does not. **These figures are an upper bound on
the worst two minutes, not a film average** — across a whole film every tier
lands materially lower.

**The percentages are source-dependent.** A 60 Mbps 4K remux or a grainy 35 Mbps
Blu-ray has far more headroom — 85 might land near 60% there. A lean 8 Mbps
WEB-DL may inflate even at 72. An absolute target therefore behaves very
differently across the library, which is why `max_encoded_percent` is doing real
work regardless of the target chosen.

---

## 2. Encoder by tier

**measured** — Avatar bake-off at matched SSIMULACRA2 72.45, one machine, plus
round 1 baselines.

| tier | recommendation | rationale |
|---|---|---|
| **low** | xav + **mainline** | hdr *loses* at low (+1.17% bytes) and costs 32% more time |
| **mid** | xav + **hdr** | −1.21% bytes vs mainline; worst frame 64.35 vs 51.55. +34% time |
| **top** | xav + **hdr** | −2.86% bytes, +20% time |

### Why xav over our current av1an path

Not size — **consistency**. At matched quality av1an sits between the two xav
builds on bytes (212 MB vs 237 mainline / 202 hdr), but its distribution is far
worse:

| | σ | worst frame | 5th pct |
|---|---|---|---|
| av1an SVT | 9.03 | 46.44 | 55.54 |
| xav mainline | 2.51 | 51.55 | — |
| xav hdr | **2.18** | **64.35** | 69.10 |

Per-chunk VMAF targeting leaves individual frames far below its own average;
per-scene SSIMULACRA2 targeting does not. On means the two look equivalent — the
gap only exists in the distribution.

### AOM is not a top tier

**measured.** On the Avatar sample av1an+AOM produced a *smaller* file at *lower*
quality than SVT (68.15 vs 72.46) for **5.5x** the wall-clock, with the worst
consistency of anything tested (σ 11.77, min 39.08). It should not be treated as
the quality reference until re-derived — and xav hdr matches its quality in 3.3%
fewer bytes and **4.7x less time**.

---

## 3. Parameters — mainline SVT-AV1 v4.2.0

What production ships (`src/shared/encoderFlags.js`):

    --preset <tier> --tune 1 --keyint -1 --enable-variance-boost 1
    --enable-qm 1 --qm-min 0 --tf-strength 1 --sharpness 1
    --tile-columns 1 --scm 0

| flag | basis | evidence |
|---|---|---|
| `--qm-min 0` | **measured, both sources** | correctly signed in **6 of 6** tier-source combinations. Worth <1.2% at our shipped low/mid targets; the large film figure is measured at ~85, not at our 80 ceiling -- see the correction below |
| `--enable-qm 1` | **measured** | disabling costs +4.3 / +6.6 / **+15.6%** |
| `--tf-strength 1` | **measured** | mainline default 3 costs +2.4–3.3% |
| `--tune 1` | **measured, both sources** | tune 0 costs +3.2–9.95%; tune 4 is the worst arm in **6 of 6** combinations, +36–56% on clean digital and **+41 to +134%** on film |
| `--enable-variance-boost 1` | **measured** | disabling costs +9.0% low, +7.7% mid, **+0.46% top** |
| `--tile-columns 1` | **measured** | byte-neutral (±0.2%); removing it raised top-tier wall-clock to 1.09x |
| `--keyint -1` | structural | av1an owns keyframes |
| `--sharpness 1` | **unmeasurable on our gate** | byte-neutral, but SSIMULACRA2 cannot see what it does |
| `--scm 0` | **untested** | inherited 2021 hedge; likely near-neutral on live action |

**Stock defaults are not good enough**: `bare_defaults` (`--preset 4` alone) cost
**+18 to +22%**. The parameter work is justified overall.

### DECIDED 2026-08-13: the tuned set ships on mainline

Verified as real Tdarr jobs on JOB5 (low tier, `xavEncode` via
`inputFile → sanitizeFile → xavEncode → replaceOriginalFile`), tuned vs
`param_set: none`. A win counts only where one arm beats the other on **both**
size and quality:

| clip | source type | tuned | stock | verdict |
|---|---|---|---|---|
| westworld | WEB-DL | 38.40% @ 71.05 | 45.19% @ 69.31 | **tuned dominates** |
| harrypotter | VC-1 remux | 62.64% @ 71.49 | 65.73% @ 67.00 | **tuned dominates** |
| closeenc | 35mm grain | 61.87% @ 69.53 | 72.18% @ 68.03 | **tuned dominates** |
| topgun | IMAX remux | 29.70% @ 70.16 | 30.14% @ 70.41 | tie (−1.5% bytes, −0.25 quality) |

Worst-frame improves with the tuned set on all four (+14.0, +16.7, +12.2, +2.6),
which matters more than the mean — distribution is why xav was chosen over av1an
in the first place (§2).

**Emil's call: ship the tuned set on mainline.** The topgun regression is 0.25
SSIMULACRA2 against three dominant wins and a universal worst-frame gain. This
is the `param_set: auto` default and needs no further change.

Scope: **mainline only**, i.e. the low tier. §5 covers why the hdr fork at
mid/top gets no parameter string.

**`--qm-min 0` is confirmed on both sources** and the stake is content-dependent.

**Corrected 2026-08-13.** This section previously read "~6.8% on 35mm film,
symmetric in both directions (qm-min 6 costs +6.78%)". That was a
delta-of-deltas error. In the Jurassic sweep `new_set` was **qm-min 4**, not 0
(the script documents the switchover), so −6.79% and +6.78% are both measured
*against qm-min 4* and cannot be added or read as symmetric around 0. Computed
from the raw bytes at matched quality (`hometower/docs/data/xav-settings-sweep-jurassic.tsv`):

| tier | qm-min 0 | qm-min 6 | 0 vs 6 |
|---|---|---|---|
| low (mean 67.99) | 19,262,652 | 19,343,194 | −0.42% |
| mid (mean 72.54) | 27,854,512 | 28,178,092 | −1.15% |
| top (mean 84.97) | 134,816,703 | 154,441,603 | **−12.71%** |

So the true gap at the sweep's top tier is nearly **twice** the number this
document carried. **But read the mean scores**: that sweep's top tier targeted
~85, and §1 sets our shipped top tier at **80** precisely because 85 inflates
output past the source. The 12.71% is measured at a quality level we
deliberately abandoned, and the trend across tiers (0.42 → 1.15 → 12.71) is
steep enough that extrapolating it down to 80 is not safe. **At our actual tier
targets the qm-min stake is measured only at low and mid, where it is under
1.2%.**

Two consequences. It is still correctly signed everywhere, so keep it on
mainline — it costs nothing. But it is not the headline win the old number
implied, and it is not yet a justification for overriding the hdr fork's
defaults at mid/top (see §5).

The caveat that remains: it is optimal *on SSIMULACRA2*. Every maintainer ships
4–6, which may encode banding and flat-area concerns a full-reference metric does
not reward. Our pipeline gates on SSIMULACRA2, so optimising for it is
self-consistent — but this is not evidence the maintainers are wrong.

**Not attributed to grain.** The two samples also differ ~3x in motion, so this
pair cannot separate grain from motion and detail character. "Content-dependent"
is what the data supports; grain is an untested hypothesis for the mechanism.

---

## 4. Preset by tier — and an interaction that reverses

**measured**, round 1.

| tier | mainline | hdr |
|---|---|---|
| low | **6** | 6 |
| mid | **4** | 4 |
| top | **2** | **4 — not 2** |

preset 2 vs preset 4, bytes at matched quality:

| tier | hdr | mainline | time cost |
|---|---|---|---|
| low | −5.65% | −6.19% | 3.1–4.0x |
| mid | −4.33% | −4.70% | 3.1–4.0x |
| top | **+0.59%** | −2.13% | 2.9–3.1x |

**preset 2 reverses on hdr at the top tier** — 3x the time for a *larger* file.
When CRF is already ~8–10 the deeper search has little left to find. On mainline
it still pays slightly, so the right preset depends on the binary.

At the low tier, preset 2's −6.19% for 4x wall-clock is a poor trade for bulk
content; preset 6 (+1.3 to +8.8% bytes for 0.55–0.75x time) is the better lane.

---

## 5. The hdr build: do not port our string across

**researched.** The fork's defaults *are* the recipe — its author states only
tuning mode, CRF and preset are required. Its defaults already encode qm 6/10,
variance boost on, `tf-strength 1`, `sharpness 1`, `ac-bias 1.0`. Our mainline
string fights them.

    LOW     --preset 6
    MID     --preset 4
    TOP     --preset 4        (NOT preset 2 -- see §4)
    GRAINY  --preset 2 --tune 5
    HDR PQ  add --variance-boost-curve 3

**Tune numbers differ between the two binaries.** On mainline v4.2.0 `--tune 5`
is VMAF; on hdr it is Film Grain. hdr's grain mode moved from tune 3 to tune 5,
and both the JET guide and Codec Wiki still say 3 — following that advice today
selects still-image IQ mode on a feature film.

HDR PQ is the one case where hdr does something mainline cannot: mainline
hard-errors on `--variance-boost-curve` above 2.

---

## 6. Open questions

| question | status |
|---|---|
| ~~Grainy content~~ | **closed.** Same arms win on both sources; no detection or routing needed. `qm-min 0` confirmed and its stake is 5x larger on film |
| 4K | entirely unmeasured; no tiered 4K parameter sets exist publicly either |
| `--enable-overlays` | untestable through xav; needs an av1an run with RSS sampling. Bears on the open 4K OOM problem |
| sharpness, ac-bias, hdr tune 5 | metric-blind — need visual A/B or stay unresolved |
| Production VMAF target | **live bug**: av1an asks VMAF 95, delivers 99.957. Disappears if a tier moves to xav; otherwise needs re-deriving |

### Things the metric cannot settle

SSIMULACRA2 is a full-reference metric, so it under-rewards anything that adds
visual energy not present in the source. Confirmed in mainline source: only
`TUNE_VQ` sets the sharpness controls that bias toward retained texture — which
is why tune 0 measures worse for us and is still recommended by practitioners
judging by eye. The same caution applies to sharpness, ac-bias and hdr's tune 5.

**Our sweep outranks published advice for metric-grounded parameters. It cannot
adjudicate the others at all.**
