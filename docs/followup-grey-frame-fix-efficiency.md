# Follow-up: is the v2.5.0 grey-frame fix costing us time and filesize?

**For a fresh session. Written 2026-08-10 by the session that shipped v2.5.0.**
You do not need any prior context — this file has it all.

---

## 1. Background: what v2.5.0 changed and why

Our AV1 encodes contained **pure mid-grey frames at av1an chunk boundaries** — silent, no error,
no failed job. Root cause: `core.lsmas.LWLibavSource` does not prime the decoder's reorder buffer
after a seek, so the first outputs of a **cold** seek come back flat mid-grey. av1an gives every
chunk worker exactly one cold seek (`vspipe -s START -e END`), so blanks landed on chunk starts in
bursts of 1–12 frames.

Established by run-up bisection on 21 known-bad frames, fresh vspipe process per frame:

```
-s N   -e N   ->  20/21 grey        -s N-4 -e N  ->  0/21
-s N-1 -e N   ->   5/21 grey        -s N-8 -e N  ->  0/21
```

**The fix** (`src/shared/vsSource.js`, `RUNUP_FRAMES = 8`): make frame *n* depend on *n-1..n-8* via
`ModifyFrame`, so the decoder is primed before the frame is handed over. The run-up clips are
cropped to 16×16 because only the decode side-effect is wanted.

It works. Verified in production on The Conjuring (2013), re-encoded from the same re-pulled AVC
remux: **21/21 previously-grey burst positions now real content, full scan CLEAN**. Evidence in
`../hometower/audits/av1-grey-frames/2026-08-09/the-conjuring-post-fix-verification.txt`.

**Do not regress correctness while optimising.** Any candidate must be re-validated (see §6).

---

## 2. The concern

Emil reports a **large jump in encode time and filesize** after the fix. Hard number available:

| The Conjuring (2013) | size |
|---|---|
| pre-fix encode (preserved) | 4,027,455,323 B — **4.03 GB** |
| post-fix encode (2026-08-10 01:54) | 5,259,066,415 B — **5.26 GB** |
| | **+30.6%** |

Keyframe count also moved: **998 → 1020** (+22 chunks).

---

## 3. ⚠ The single most important thing to check first

**My controlled A/B did NOT reproduce a size regression.** Same source region, chunk boundaries
pinned via `--scenes`, only the wrapper differing:

| | time | size |
|---|---|---|
| without run-up | 33 s | 49,692,924 B |
| with run-up | 34 s | 49,768,542 B |

That is **+3% time and +0.15% size** — nowhere near +30.6%.

So **do not assume the wrapper causes the size jump.** Two candidate explanations, and they are
not mutually exclusive:

1. **My A/B used non-production encoder settings** — `svt-av1 --preset 8 --crf 30`, a fixed-CRF
   fast encode. Production uses **aomenc with `--target-quality` (VMAF) and `--probes 6`**, which
   decodes each chunk many times and converges bitrate adaptively. A decode-cost change is
   multiplied by the probe count, and a *reference-quality* change can move the converged bitrate.
2. **The two encodes may not be comparable at all.** The 4.03 GB file was produced at an unknown
   earlier plugin version. v2.4.0 deployed 2026-08-02; v2.3.x before that. If target VMAF, encoder,
   preset or downscale settings differed then, the delta is not about grey frames.

**First task: establish which plugin version and settings produced the 4.03 GB encode**, from the
Tdarr job report / job history for that file. If the settings differ, the +30.6% is explained and
the remaining question is only about *time*.

---

## 4. Hypotheses for the time cost, ranked

1. **Run-up cost is multiplied by target-quality probes.** Each probe re-decodes the chunk; the
   wrapper adds 8 frame requests per output frame. In fixed-CRF this is ~3%; with 6 probes plus the
   VMAF pass it could be several times that. **Most likely dominant cause.**
2. **Node overhead, not decode cost.** The wrapper builds **8 separate `DuplicateFrames` + `Crop`
   node pairs**. Per output frame VS schedules 9 frame requests across 17 filter instances. Most
   should be cache hits, but the scheduling overhead is per-request, not per-decode.
3. **VS cache pressure.** 9 in-flight frames per request across many worker threads may be evicting
   the lsmas cache, turning would-be hits into real decodes. Check `core.max_cache_size`.
4. **Different chunking** (998 → 1020 keyframes) — real but small; ~22 extra keyframes cannot
   account for 1.2 GB. Worth confirming *why* it changed (grey frames themselves look like scene
   cuts to the detector, so the OLD chunking may have been the anomalous one).

---

## 5. Candidate cheaper designs, best first

### A. Single far run-up instead of eight (cheapest to test, potentially 8× less overhead)
The bisection that justified K=8 measured `vspipe -s N-8 -e N`, i.e. a **contiguous decode** from
N-8. The wrapper instead requests eight *individual* frames. It may be that requesting **only
`n-8`** is equivalent: lsmas seeks to n-8, and the subsequent request for n decodes forward through
exactly the frames that were the point of the exercise.

If so, one delayed clip replaces eight. **Test this first** — it is a one-line change and the
biggest single win available.

### B. Scope the run-up to chunk boundaries only
Run-up is only needed after a *cold seek*, i.e. the first ~8 frames of each chunk. Everywhere else
it is pure overhead on ~99% of frames.

We already know every boundary: `av1anEncode` can run `av1an --sc-only --scenes scenes.json` first
(`crfSearchEncode` already does scene detection), and `buildSourceVpy` generates the script. Bake
the boundary list into the `.vpy` and apply run-up only when `n` is within RUNUP of a boundary:

```python
_bounds = frozenset([...])          # from scenes.json
# warm only near a boundary; identity elsewhere
```
Cost becomes ~0 for the vast majority of frames. Costs an `--sc-only` pre-pass, but that output is
reusable by the real encode via `--scenes`, so it is close to free.

### C. Reduce K with a better construct
K=8 was simply the first depth that reached zero **on one file** (K=4 left 1/998). If A works, K
matters much less. Do not lower K without re-running the full 998-frame validation.

### D. Confirm whether target-quality convergence changed
If the VMAF reference previously contained grey frames, converged bitrate could differ. Compare
per-chunk converged CRF between a run-up and a no-run-up encode of the same region under
**production settings**.

---

## 6. How to validate any candidate (do not skip)

The detector lives at `../hometower/audits/av1-grey-frames/2026-08-09/verify-file.sh` (a copy of
`greyscan3.sh`). `bash verify-file.sh --one <file.mkv>` prints `CLEAN,...` or `AFFECTED,...`.

**Correctness gate — a candidate is only acceptable if it reproduces this:**

1. **Cold-seek probe, 998 chunk starts in randomised order** on
   `/mnt/user/media/movies/The Conjuring (2013)/…[AVC]-FraMeSToR.mkv`:
   no run-up → **21 grey**; candidate → **0**.
   Randomised order is essential — ascending order keeps lsmas warm and hides the bug entirely.
2. **Bit-exactness**: `framemd5` over a clean sequential range must match the unwrapped clip.
3. **Chunk-worker shape**: one fresh `vspipe -s N -e N+59` per known-bad start; 38 grey → 0.
4. **Real encode A/B** under **production settings** (aomenc + target-quality), same region, chunk
   boundaries pinned with `--scenes`, measuring **time and size** as well as grey count.

Known-bad frame indices (source frame numbers):
```
12778, 21822, 27971, 57594, 63464, 73527, 86204, 86302, 86909, 105337, 105797,
111451, 112143, 114218, 116597, 121735, 137298, 140693, 144181, 145544, 145664
```

---

## 7. Assets

- **Pre-fix damaged encode**: `/mnt/user/emil/av1-debug/…GREYFRAME-EVIDENCE.mkv` (4 GB, `chmod 444`,
  **only copy in existence** — do not delete). Its `evidence/data/signalstats.csv` has per-frame
  YMIN/YMAX/YAVG for all 161,049 frames; the 45 grey frames are extractable with
  `awk -F, '$2==$3 && $4>510 && $4<514'`.
- **Proven-bad source**: the AVC remux in the library — measured at 21/998 cold-seek failures.
- **Post-fix encode**: same folder, verified clean.
- My scratch on the shares was deleted; the scripts above are the surviving copies.

## 8. Do not re-litigate

These were measured and **all leave the failure at exactly 21/998** — do not spend time on them:
`threads=1/2`, `seek_mode=0/1/2`, `seek_threshold=100`, `dr=0`, `prefer_hw=0`,
`rap_verification=0/1`, a rebuilt `.lwi` index, and VapourSynth `num_threads=1/2/4/8`.
lsmas serializes on one decoder, so VS thread count is irrelevant (1 and 32 run identically).

`FrameEval` + `prop_src` — the construct with *guaranteed* ordering — performed **worse** (18/998)
and 3.4× slower than `ModifyFrame`. The mechanism is not decode ordering; it is that lsmas resolves
a burst of requests around *n* with a single seek and one forward decode pass.

## 9. §3 RESOLVED (2026-08-10): the two encodes share almost nothing

Job reports recovered over the API (`search-job-reports` → `read-job-file`) settle it. The 4.03 GB
file was produced on **2026-01-10** — job `ZmtCfg1hIT`, footprint `7vR0kW0Sg`, Tdarr 2.58.02,
**Node[RTX3060]** — with `"newSize":3.7508600605651736` GiB = 4,027,455,323 B, an exact match.
**This repo's first commit is 2026-04-02.** The pre-fix encode predates these FlowPlugins entirely;
no version of them produced it.

The av1an invocations, verbatim from the two reports:

**Pre-fix (2026-01-10, RTX3060, predecessor plugin stack, no VapourSynth — av1an read the MKV
directly):**

```
av1an --log-file ./../temp/tdarr-workDir2-ZmtCfg1hIT/av1an/log.log -c mkvmerge -e aom
  -v "--end-usage=q --cq-level=22 --cpu-used=4 --threads=16 --enable-fwd-kf=1 --enable-qm=1
      --bit-depth=10 --lag-in-frames=48 --tile-columns=1"
  --sc-downscale-height 720 --scaler lanczos --target-quality 95.5 --probes 5 --qp-range 1-50
  --chunk-order sequential --probe-res 1280x720 --vmaf-res 1280x720
```

**Post-fix (2026-08-09, RYZEN9950X, plugins v2.5.0, source.vpy):**

```
av1an -i .../av1an-work/vs/source.vpy -c mkvmerge -e aom
  --sc-downscale-height 540 --scaler lanczos --qp-range 10-50 --target-quality 95
  --vmaf-path /usr/local/share/vmaf/vmaf_v0.6.1.json --probes 6 --chunk-order long-to-short
  -v "--end-usage=q --cpu-used=4 --tune=ssim --enable-fwd-kf=0 --disable-kf --kf-max-dist=9999
      --enable-qm=1 --bit-depth=10 --lag-in-frames=48 --tile-columns=0 --tile-rows=0
      --sb-size=dynamic --deltaq-mode=0 --aq-mode=0 --arnr-strength=1 --arnr-maxframes=4
      --enable-chroma-deltaq=1 --enable-dnl-denoising=0 --disable-trellis-quant=0
      --quant-b-adapt=1 --enable-keyframe-filtering=1"
```

**The dominant size lever: VMAF measurement resolution.** The January encode probed *and scored*
VMAF at **1280x720** (`--probe-res` + `--vmaf-res`); downscaled VMAF is far more lenient, so
target 95.5@720p converges at a much lower bitrate than target 95 at native 1080p. On top of that:
different source file (re-pulled remux is a different mux: 22.148 vs 22.180 GiB), different
keyframe policy (`--enable-fwd-kf=1` vs `--disable-kf --kf-max-dist=9999`), `--tune=ssim`,
different qp-range/probes/scene-detect settings, and a different node (so the *time* comparison
between these two encodes is also apples-to-oranges).

**Conclusion: the +30.6% is settings/source drift across seven months, not the run-up wrapper** —
consistent with the controlled A/B in §3 (+0.15% size). The keyframe delta (998 → 1020) likewise
falls out of the different scene-detect settings and source. Remaining open question: wrapper
*time* cost under target-quality on the same node (§4.1) — made moot if §10 ships.

### 9.1 Production A/B confirmed (2026-08-11): Scary Movie 5, near-perfect natural experiment

Emil's suggestion. The damaged SM5 encode ran **2026-04-13** (job `vV3--bm0I7`) under the
April-era plugin with an av1an command **verbatim identical** to today's, on the same node
(RYZEN9950X); the re-pulled source is byte-identical in size (`oldSize` matches to the last
digit), and both encodes produced **identical chunking: 1299 scenes → 1453 chunks**. The re-encode
under v2.5.0 (job `Nu_648nsk`, finished 2026-08-11 05:41 CEST) differs only by the v2.5.0-era
plugin internals — dominated by the run-up wrapper (both eras use lsmas; the v2.4.0 pre-flight
probe costs seconds).

| | pre-fix 2026-04-13 | post-fix 2026-08-11 | delta |
|---|---|---|---|
| size | 6,208,198,800 B | 6,313,896,626 B | **+1.70%** |
| av1an phase | 09:08:30→≈13:51 ≈ 4 h 43 m | 22:00:39→≈03:41 ≈ 5 h 40 m | **+20.3%** |
| tail fps | 7.5 | 6.2 | −17% |

- **Size: the wrapper is exonerated.** +1.7%, and part of that is legitimate: the pre-fix output
  had ≥32 confirmed grey bursts — flat grey compresses to almost nothing and grey probe frames
  converge chunks to lower bitrate; the post-fix file encodes the real content there.
- **Time: the cost is real, ≈ +20% under production target-quality** — §4 hypothesis 1 confirmed
  (the ~3% fixed-CRF overhead is multiplied by 6 probes + VMAF passes). This is exactly what the
  §10 scoped run-up eliminates.

## 10. RECOMMENDED superior fix: scope run-up to the actual cold seek via `/proc/self/cmdline`

Supersedes §5A/§5B. The run-up is only needed for the first ~RUNUP frames after a cold seek, and
every av1an chunk worker / target-quality probe is a **fresh vspipe process whose own command line
contains the seek target** (`vspipe -s START -e END script.vpy`). vspipe evaluates the script
in-process, so the `.vpy` can read it directly — no scenes.json pre-pass (§5B's cost), no shim,
no sibling-repo change:

```python
import os
_argv = open('/proc/self/cmdline','rb').read().split(b'\0')
_start = 0
for _i, _a in enumerate(_argv):
    if _a in (b'-s', b'--start') and _i + 1 < len(_argv):
        _start = int(_argv[_i + 1]); break

wrapped = _runup(src)                      # the existing, validated 8-clip construct
a = min(_start, src.num_frames)
b = min(_start + RUNUP_FRAMES, src.num_frames)
parts = ([src[:a]] if a else []) + [wrapped[a:b]] + ([src[b:]] if b < src.num_frames else [])
out = core.std.Splice(parts)               # absolute frame numbering preserved
```

- Frames outside `[START, START+8)` request plain lsmas frames — **zero** added scheduling, so
  hypotheses §4.1/2/3 (probe multiplication, node overhead, cache pressure) all go to ~0 at once.
- The frames that *do* need priming keep the byte-identical proven construct — minimal
  re-validation risk. (§5A's single-far-run-up becomes irrelevant: 8 frames × 8 deps per process
  is noise.)
- No `-s` on the cmdline (av1an `--sc-only` pass, `vspipe --info`, manual runs) → START=0, which
  primes the head of the clip: harmless and correct.
- Linux-only (`/proc`) — fine, this only ever runs in the Docker stack.
- **Risk to gate on:** any consumer that cold-seeks *mid-process* (a second seek inside one vspipe
  run) would be missed. All observed failures were at chunk starts, but this is exactly what §6's
  randomised 998-probe gate + full-file scan must confirm. Also verify ab-av1's vspipe invocation
  shape in `crfSearchEncode` (per-sample `-s` → covered; anything else → needs its own look).

The §6 correctness gate remains mandatory and unchanged.

## 11. Operational notes

- Tdarr is **running**; 14 of 16 re-pulled titles are still importing and will re-encode under
  v2.5.0 over the coming days. Any change here affects those.
- Deploy runbook: `../hometower/apps/tdarr.md` (rsync **without** `--delete`, then
  `docker restart tdarr_server`, nodes idle).
- Production is read-only from the VM by convention; test via `docker exec tdarr_server`.
- Full history: `git log` on `src/shared/vsSource.js`, and commit `a7b68bb`.
