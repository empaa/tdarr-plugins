# Tier validation — 2026-08-13

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
