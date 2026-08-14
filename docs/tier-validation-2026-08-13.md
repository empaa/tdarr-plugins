# Tier validation — 2026-08-13

> **CORRECTION 2026-08-14 — every "% of source" below is INFLATED.** The mux took
> the encoded file whole, and xav copies the source's audio/subs into its own
> output, so every result carried TWO copies of the non-video streams (fixed in
> `1f6a3f1`). The overstatement is a constant per clip: closeenc +14.44, harrypotter
> +23.55, topgun +15.41, westworld +6.24, captain +6.83 points. Corrected table at
> the bottom. Because the offset is constant within a clip, every RELATIVE finding
> here still holds — tier ordering, top≈mid equivalence, preset 6 over preset 4 —
> but the absolute sizes are better than stated, and the AOM comparison inverts.

Two tier sets run as **real Tdarr jobs** on JOB5 (visible on the dashboard at
`http://10.0.0.3:8275`), so the whole integration is exercised, not just the encoder.
Raw data: `docs/data/job5-2026-08-13-tier-validation.tsv`.

## What was run

| tier | target | crf range | preset |
|---|---|---|---|
| top | 75 | 5-50 | 4 |
| mid | 75 | 10-60 | 4 |
| low | 70 | 10-60 | 6 |
| top-lean | 72.5 | 5-50 | 4 |
| mid-lean | 70 | 10-60 | 4 |
| low-lean | 67.5 | 10-60 | 6 |

Targets are ±0.2 bands around the stated value. **mainline-tuned for SDR, hdr-defaults for
HDR** — expressed by which binary each run uses, since `param_set=auto` already encodes that
rule (mainline gets `MAINLINE_PARAMS`, the hdr fork gets none because its defaults *are* the
recipe). Confirmed in the logs: captain reports *"hdr fork defaults"*, the SDR clips report
*"mainline researched set"*.

Sources: four 1080p 8-bit SDR clips, plus captain (3840x2160, smpte2084) as the only HDR
source — it takes the 4K→1080p pipe path.

## First set — results

| clip | top | mid | low |
|---|---|---|---|
| closeenc | 77.77% | 77.65% | **61.92%** |
| harrypotter | 70.91% | 70.89% | **62.66%** |
| topgun | 31.51% | 31.46% | **29.71%** |
| westworld | 56.86% | 56.92% | **38.49%** |
| captain (4K HDR) | 22.54% | 22.39% | not run |

(% of source. Encode wall time 124-176 s per 2-minute clip; captain 251-266 s.)

## Findings

**1. Top and mid are the same tier on SDR.** Both are target 75 / preset 4, differing only in
CRF range, and across all four SDR clips **no chunk came within 10 of either bound** (widest
excursion: topgun at crf 44.5 against a ceiling of 50). Output sizes agree to within 0.15%.
Shipping both means two tier assignments competing for identical results.

**2. Except on 4K HDR, where they do diverge.** captain's chunk #28 chose crf 10.0 — free in
top, but exactly mid's floor, so mid pinned **2 chunks at the floor, both starved** (below
target with nowhere to go) where top had none. The lower floor earns its place on 4K HDR and
nowhere else in this set.

**3. Dropping the target from 75 to 70 saves 1.8-18.4 points of source size, and the amount
does not track content difficulty.** topgun is already at 31% and has nothing left to give;
westworld saves the most (18.4) despite not being the hardest clip. A per-tier uniform target
is therefore a blunt instrument — the same target costs very different amounts per title.

**4. The over-high target was the whole problem on HDR.** captain at target 80 this morning:
26.53% of source, mean 72.14, **13 of 29 chunks starved at the CRF floor**. At target 75:
22.54%, mean 76.62, **zero at the floor**. Smaller *and* better, because a reachable target
lets the search converge instead of thrashing at the bound.

**5. closeenc at the low tier reproduces the 10-hour AOM result.** 61.92% of source against
av1an+AOM's 62.4% on the same film (job `Zcn7fGVw4z`), from SVT-mainline-tuned in 127 s for a
2-minute sample — roughly 2.4 h for the full film against AOM's 10 h. Caveat: ours is a
2-minute sample, theirs the whole film; the sample's 23.66 Mbps sits on the film's average, so
it is not a flattering excerpt.

## Lean set — results (% of source, m = achieved mean)

| clip | top-lean (72.5) | mid-lean (70) | low-lean (67.5) |
|---|---|---|---|
| closeenc | 69.54% m74.14 | 62.07% m69.58 | **56.44%** m68.13 |
| harrypotter | 66.13% m74.84 | 61.96% m70.99 | **59.39%** m68.38 |
| topgun | 30.27% m74.49 | 29.42% m71.00 | **29.10%** m68.57 |
| westworld | 45.89% m72.98 | 37.85% m70.57 | **32.22%** m68.08 |
| captain (4K HDR) | 19.94% m74.52 | 18.21% m71.77 | not run |

## DECIDED — this is the shipping lineup

Emil's call after reviewing both sets:

| tier | target | crf range | preset |
|---|---|---|---|
| top | 72.3-72.7 | 5-50 | **6** |
| mid | 69.8-70.2 | 10-60 | **6** |
| low | 67.3-67.7 | 10-60 | **6** |

Stamped into both plugins' defaults (`target_quality` 69.8-70.2, `preset` 6) with the
reasoning in the tooltips, so a flow built from scratch lands on the measured
configuration rather than the old one.

**Preset 6 everywhere** because preset 4 does not earn its cost. Measured head to head at
target 70, CRF 10-60, four clips, only the preset differing:

| clip | preset 6 | preset 4 | size delta | time delta |
|---|---|---|---|---|
| closeenc | 61.92% | 62.07% | **+0.15 (worse)** | +26% |
| harrypotter | 62.66% | 61.96% | -0.70 | +19% |
| topgun | 29.71% | 29.42% | -0.29 | +28% |
| westworld | 38.49% | 37.85% | -0.64 | +29% |

~0.9% smaller for ~25% more encode time, and on one clip preset 4 was *larger*. The
target-quality search dominates the outcome, so the slower preset's work does not reach the
output. This independently reproduces the existing note that SVT + target-quality prefers
cpu-used 6-8, but measured in this exact configuration.

**Caveat on the review files:** the `top-lean` and `mid-lean` outputs in `_outputs/` were
encoded at **preset 4**, since the preset decision came after they ran. The shipping config is
preset 6. Measured difference is under 1% of size and within noise on quality, so they remain
valid for judging quality -- but they are not byte-identical to what the tier will now produce.

## What the CRF ranges are actually doing

Across all 28 encodes, bounds were touched **twice**:

- captain (4K HDR) at mid: 2 chunks pinned at the floor of 10 and starved. Top's floor of 5
  avoided it. This is the only justification for top's wider floor.
- topgun at low-lean: chunks chose crf 50.25 and 51.75, above top's ceiling of 50.

Everywhere else no chunk came within 10 of a bound. The ranges are a safety rail, not a
tier-defining parameter -- the **target** is what moves output.

## Measurement caveat — read before comparing scores

Achieved-quality numbers carry roughly **±3.5 points** of run-to-run noise. harrypotter top vs
mid produced files within **0.02%** of the same size but means of **76.88 and 73.33**, with
quite different chunk-CRF distributions. Byte counts are reproducible; scores are not. Do not
read small score differences between tiers as real — the visual review is the better
instrument, and the file sizes are the trustworthy number.

Three of four SDR clips also **overshot** the requested band at the top tier (harrypotter by
1.68), meaning bytes spent above what the tier asked for.

## Reviewing the output

Everything is in one directory, named `<clip>-<tier>.mkv`:

    /mnt/cache_nvme_two/vm_data/xav-work/job5/library/_outputs/

Compare against the untouched sources:

    <job5>/clips/{closeenc,harrypotter,topgun,westworld}.mkv
    <job5>/masters/captain_remux_atmos_sample.mkv

Worth looking hardest at:

- **closeenc-low** — grain-heavy, worst chunk scored 52.93, the lowest in the set.
- **westworld-low** — the biggest size drop (56.9% → 38.5%), so the most likely to show it.
- **topgun-low** — worst chunk 56.41 on high-motion content.
- **captain-top vs captain-mid** — the only pair where the CRF range mattered.

Note the outputs are **autocropped** (closeenc 1080 → 816, topgun → 1012, captain → 804), so a
side-by-side against the source needs the offset or the panels will not align.

## CORRECTED sizes (2026-08-14) — duplicate non-video streams removed

Measured non-video bytes per source, subtracted once from each result:
closeenc 59,054,426 · harrypotter 90,847,728 · topgun 83,142,971 ·
westworld 9,701,555 · captain 92,833,364.

| clip | top | mid | low | top-lean | mid-lean | low-lean |
|---|---|---|---|---|---|---|
| closeenc | 63.33% | 63.21% | 47.49% | 55.11% | 47.63% | **42.00%** |
| harrypotter | 47.36% | 47.34% | 39.11% | 42.58% | 38.41% | **35.84%** |
| topgun | 16.11% | 16.05% | 14.31% | 14.86% | 14.01% | **13.69%** |
| westworld | 50.62% | 50.68% | 32.25% | 39.65% | 31.61% | **25.98%** |
| captain (4K HDR) | 15.71% | 15.56% | — | 13.11% | 11.39% | — |

### What this changes

**The AOM comparison inverts.** closeenc at the low tier is **47.49%** of source,
not the 61.92% reported. av1an+AOM reached 62.4% on the same film (job
`Zcn7fGVw4z`) and that figure is clean — av1anEncode feeds av1an a VapourSynth
`.vpy`, which is video-only, so it never duplicated anything. SVT therefore beats
AOM on this content by a wide margin rather than matching it, which strengthens
the decision to drop AOM rather than weakening it.

**Nothing relative changes.** The inflation is a constant per clip, so tier
ordering, the top≈mid equivalence, and preset 6 over preset 4 all stand exactly as
measured.

**The grain problem is smaller than it looked.** closeenc at the top tier is 63.3%
of source, not 77.8%. The clip that read as marginal this morning is comfortable.

### Caveat on the review files

The 28 outputs in `_outputs/` were produced BEFORE this fix, so each carries a
duplicate audio and subtitle set. Their **picture** is unaffected and they remain
valid for judging quality on the projector; only their file sizes read high, by
the per-clip constants above.
