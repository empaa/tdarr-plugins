# SVT-AV1 settings research

Compiled 2026-08-13 by a research agent with no exposure to our sweep or our existing
parameters, at Emil's direction, after an earlier sweep was built by varying our inherited
flags rather than by researching what is actually recommended.

Encoder ground truth read from our own binary. Every substantive claim carries a source.

---

## 1. Our tune 0 measurement vs. the community's tune 0 recommendation

**Not in conflict. They measure different things — and for our pipeline, ours binds.**

Tune 0 (VQ) is *designed* to lose on full-reference metrics. In mainline source,
`derive_vq_params()` ([`enc_handle.c:3272-3298`](https://gitlab.com/AOMediaCodec/SVT-AV1/-/raw/v4.2.0/Source/Lib/Globals/enc_handle.c))
shows only `TUNE_VQ` sets `sharpness_ctrls.{tf, unipred_bias, ifs, cdef, restoration, rdoq} = 1`.
Those bias decisions toward *added visual energy* — retained high-frequency texture, but also
ringing and halos. A full-reference metric scores added energy absent from the source as error,
regardless of whether a viewer prefers it.

So **"tune 0 costs +3.2% to +9.95% bytes at matched SSIMULACRA2" is tune 0 working as intended**,
not evidence it is broken. Our measurement also independently corroborates the JET guide, whose
tune 1 recommendation is itself SSIMULACRA2-derived — we agree because we used the same currency.

Boulder's contrary recommendation is explicitly **subjective**, by eye, on **svt-av1-hdr**, where
tune 0 composes with fork defaults mainline lacks. Psy-fork culture treats metric loss as the
accepted price, not a defect — the same divergence our own bake-off documented when xav scored
9 dB below mainline PSNR at 24x the bitrate.

**Decision rule: our acceptance criterion IS an SSIMULACRA2 target, enforced per chunk. Under
that criterion tune 0 is strictly worse for us** — we would pay 3.2–9.95% more bytes to land on
the identical number, and the compensating benefit is invisible to the gate that accepts the
file. Tune 0 only becomes rational if the acceptance criterion becomes visual inspection.

Note: our sweep measured tune 0 on **both** binaries, hdr included, and it lost on both. So the
"different binary" explanation does not apply — only the metric-vs-eye difference remains.

---

## 2. Is each recommendation metric-grounded or eye-grounded?

The column the community almost never publishes.

| Recommendation | Grounding | Notes |
|---|---|---|
| preset 2 / 4 / 6 | **A — objective** | [Codec Wiki deep dive](https://codecs.wiki/blog/svt-av1-fourth-deep-dive-p1) (2025-06-20): SSIMULACRA2, W-XPSNR, Butteraugli, W-VMAF, BD-rate, 7 clips incl. live action. Our sweep reproduces it |
| qm-min 4 (not 0) | **A — objective by proxy** | Mainline `tune 4` is SSIMULACRA2-optimised and hard-selects `qm 4/10` ([`enc_handle.c:4753`](https://gitlab.com/AOMediaCodec/SVT-AV1/-/raw/v4.2.0/Source/Lib/Globals/enc_handle.c)). `qm-min 0` has no backing anywhere |
| varboost strength 2–3, curve 2 | **A/B** | Same proxy. Feature's value is B — [appendix](https://gitlab.com/AOMediaCodec/SVT-AV1/-/raw/master/Docs/Appendix-Variance-Boost.md) argues from perception; no isolated public BD-rate |
| tile-columns 0 | **A — objective, directional** | Upstream: tile threading "is known to decrease quality" |
| tf-strength 1 | **B — artifact-driven** | JET: eliminates "the tf blocking issue". All three forks default to 1 — strongest cross-source agreement |
| sharpness 1–2 | **C — asserted** | No numbers published anywhere. **Sweep it ourselves** |
| ac-bias 1.0+ | **C — subjective, metric-hostile** | [MR !2513](https://gitlab.com/AOMediaCodec/SVT-AV1/-/merge_requests/2513) qualitative throughout. Expect it to *lose* on SSIMULACRA2 by construction |
| tune 5 grain mode (hdr) | **C — subjective panel** | juliobbv's "56.6% of the size" came with "most of our testers preferred" |
| enable-overlays 0 | n/a — resource | ~2x picture buffers; not a quality claim |
| FGS (`--film-grain`) | metric-hostile by construction | See §6 |

**Implication:** our sweep is *more* authoritative than published advice for tiers A and B — our
content, our binary, our operating point. It **cannot adjudicate tier C at all**. Sharpness,
ac-bias and tune 5 are claims about things our gate cannot see; they need A/B visual inspection
or they stay unresolved.

---

## 3. Which encoder we actually run

`../tdarr-av1/Dockerfile:34` pins `--branch v4.2.0` of mainline SVT-AV1 (released 2026-07-14).
**We ship mainline, not a psy fork.**

Mainline v4.2.0 now has a `Psychovisual Options` section — variance boost, ac-bias,
qp-scale-compress-strength, adaptive-film-grain, hbd-mds, max-tx-size. **"Psy features are
fork-only" is roughly two years stale.**

Our inherited flags are **psy-fork defaults hand-applied to a mainline binary**:
`variance-octile 6`, `sharpness 1`, `tf-strength 1`, `chroma-qm 8/15` are what psyex/hdr default
to. Mainline defaults are 5, 0, 3, 8/15. The recipe traces to the JET guide's example line —
explicitly **anime-targeted** — plus a 2021 gist.

---

## 4. Fork landscape, and a tune-numbering trap

| Fork | Status |
|---|---|
| `psy-ex/svt-av1-psy` | **Discontinued** 2025-04-20, archived 2026-02-12 |
| `BlueSwordM/svt-av1-psyex` | **Dormant** — last push 2026-01-15 |
| `juliobbv-p/svt-av1-hdr` | Active; our xav build uses this |
| mainline v4.2.0 | Active; what we ship |

Effectively **two live options: mainline and hdr.**

**Tune numbers mean different things on the two binaries we are comparing:**

| tune | mainline v4.2.0 | svt-av1-hdr |
|---|---|---|
| 0 | VQ | VQ |
| 1 | PSNR (default) | PSNR (default) |
| 2 | SSIM | SSIM |
| 3 | IQ — still image only | IQ |
| 4 | MS-SSIM / **SSIMULACRA2-optimised** | MS-SSIM |
| 5 | **VMAF** (new in 4.2.0) | **Film Grain** |

Both the [JET guide](https://jaded-encoding-thaumaturgy.github.io/JET-guide/master/encoding/svtav1/)
and [Codec Wiki](https://codecs.wiki/docs/encoders/SVT-AV1) still say hdr's grain mode is tune 3;
it moved to **tune 5** ([`enc_handle.c:4639`](https://raw.githubusercontent.com/juliobbv-p/svt-av1-hdr/main/Source/Lib/Globals/enc_handle.c),
which forces `enable_tf=0, cdef_level=0, enable_restoration=0, complex_hvs=1, ac_bias=4.0,
tx_bias=1`). Following that advice today selects still-image IQ mode on a feature film.

---

## 5. Recommended parameter sets per tier

### Mainline SVT-AV1 v4.2.0 (what we ship)

av1an/ab-av1 owns keyframes and CRF.

    LOW    --preset 6 --keyint -1 --enable-variance-boost 1 --tf-strength 1 --sharpness 1

    MID    --preset 4 --keyint -1 --enable-variance-boost 1 --tf-strength 1 --sharpness 1 \
                  --enable-qm 1 --qm-min 4

    TOP    --preset 2 --keyint -1 --enable-variance-boost 1 --tf-strength 1 --sharpness 2 \
                  --enable-qm 1 --qm-min 4 --qp-scale-compress-strength 1 --ac-bias 1.0

Everything else in our current string is deleted as a no-op (§7). **Keep `--tune` at the default
1** given our SSIMULACRA2 gate. `--tune 4` is the one alternative worth a sweep arm — it is
SSIMULACRA2-optimised and video-capable — but it **silently overrides** `qm-min`, `sharpness` and
varboost to `qm 4/10, sharpness 7, strength 3, curve 2`.

Preset evidence: **preset 2→3 is a 17.08% BD-rate regression**; presets ≤2 cluster tightly;
presets 9–10 are "chaotic". Preset 3 is a dead zone in both JET and Codec Wiki. Our own sweep
(preset 2 = −4.3% bytes at 4x wall-clock) reproduces this.

### svt-av1-hdr (our xav build)

The fork's defaults *are* the recipe — preset M4, tune 1, qm on at 6/10, varboost on,
`tf-strength 1`, `sharpness 1`, `ac_bias 1.0`. Author: *"Only three parameters are required…
tuning mode, CRF and preset."*

    LOW     --preset 6
    MID     --preset 4
    TOP     --preset 2
    GRAINY  --preset 2 --tune 5           # film-grain mode; author's CRF band 20-40
    HDR PQ  add --variance-boost-curve 3  # or auto via --transfer-characteristics 16

**Do not carry our mainline string across** — it fights the fork's tuned defaults. Corroboration
for preset 2 + tune 5 on grain: Boulder, author of [chunknorris](https://github.com/Boulder08/chunknorris)
(a chunked encoder, closest workflow match to ours),
[Doom9 2026-03-23](https://forum.doom9.org/showthread.php?t=177029). chunknorris defaults to
preset 2 / CRF 18 with a per-chunk `--qadjust` pass; its June 2026 CVVDP mode finds the per-chunk
**"knee point" where extra bitrate stops paying** — worth stealing conceptually for our tier
definitions, which are currently fixed score bands.

---

## 6. Content-dependent advice

**Grainy 35mm — two incompatible philosophies, both defensible.**

- *Synthesise*: `--film-grain 8` live action, `4` animation, `--film-grain-denoise 0`
  ([CommonQuestions.md](https://gitlab.com/AOMediaCodec/SVT-AV1/-/raw/v4.2.0/Docs/CommonQuestions.md)).
  [Norkin/Birkbeck DCC 2018](https://norkin.org/pdf/DCC_2018_AV1_film_grain.pdf): up to 50%
  bitrate saving on heavy grain.
- *Retain*: ac-bias with TF/CDEF/restoration off (mainline `--ac-bias 4.0`, or hdr `--tune 5`).
  [MR !2513](https://gitlab.com/AOMediaCodec/SVT-AV1/-/merge_requests/2513): moderate 1.0–1.5 for
  texture/motion; high values 4.0–6.0 with TF and CDEF off *"dramatically improve film grain and
  noise retention."*

**FGS actively corrupts a metric-targeted CRF search, in a known direction.**
[ab-av1 #139](https://github.com/alexheretic/ab-av1/issues/139) (open since 2023-04-22):
synthesized grain reproduces grain *statistics* but not *positions*, which "significantly
reduces" measured VMAF — so the search reads the encode as worse than it is and **picks an
unnecessarily low CRF, inflating file size** to buy quality that does not exist. Mitigations,
best first: (1) switch the search metric to XPSNR/SSIMULACRA2 — **xav's TQ path already does
this, so this bites our av1an/ab-av1 path but not xav**; (2) decode with
`-export_side_data film_grain` during measurement, dav1d only; (3) lower the target by hand.
Given a metric-gated pipeline, **default to grain retention over synthesis**.

**FGS hygiene:** grain tables should be luma-only (chroma grain oversaturates); never feed 8-bit
into an FGS workflow (magenta hue shift). `--adaptive-film-grain` is **on by default in our
build** and has an open flickering bug
([work item 2298](https://gitlab.com/AOMediaCodec/SVT-AV1/-/work_items/2298)); SVT-AV1-Essential
ships it off. Settled misconception: `--film-grain-denoise` does **not** disable film grain — it
disables *encoding from the denoised image*.

**Clean digital.** Variance boost targets exactly this: strength 2 *"great for most live-action
content"*, octile recommended **4–7**.

**HDR vs SDR.** `--luminance-qp-bias` is **discouraged on PQ transfers** by the feature's own
author — SDR/HLG only. The PQ-aware curve is `--variance-boost-curve 3`, and **mainline
hard-errors above 2**. HDR PQ is the one case where hdr gives us something mainline cannot.

**4K.** Genuinely thin. No tiered 4K parameter sets exist anywhere. Our sweep is 1080p-only.

---

## 7. Cargo-culted / stale settings — ours specifically

**Delete: 9 of our 20 flags do nothing.**

| Flag | Why |
|---|---|
| `--rc 0`, `--tune 1`, `--irefresh-type 2`, `--variance-boost-strength 2`, `--qm-max 15`, `--chroma-qm-min 8`, `--chroma-qm-max 15` | Byte-identical to v4.2.0 defaults |
| `--input-depth 10` | **Overwritten by the y4m header** (`app_input_y4m.c:226`). Our 10-bit comes from the vspipe/ffmpeg pipe |
| `--lookahead 48` | **Inert under `--rc 0`** — CRF takes `lad_mg = tpl_lad_mg`, TPL capped at 1 mini-GOP. Doubly meaningless under av1an, where lookahead is bounded by chunk length |

**Fix:** `--variance-octile 6 → 5`. Mainline moved the default in v4.0.0 (2026-01-13). Confirmed
against our own binary's `--help`. We pinned a default, upstream moved it, nobody noticed — the
exact failure mode that argues against defensive pinning.

**Drop unless measured:**

- `--tile-columns 1` — upstream says tile threading "is known to decrease quality" and can cause
  "visible artifacts"; `--lp 1` vs `--lp n` produce **identical output**, so no encode
  parallelism is gained. Pure loss for dav1d/hardware playback.
- `--enable-overlays 1` — off by default everywhere; **~2x picture buffers**
  (`enc_handle.c:358`, `min_parent *= 2`), i.e. N× across parallel av1an workers. **Directly
  relevant to our 4K OOM history.**
- `--scm 0` — a 2021 hedge against a detector rebuilt in 4.0/4.1/4.2. Likely near-neutral on true
  live action; costs us on title cards and credit rolls.

**Keep, well-founded:** `--enable-variance-boost 1`, `--tf-strength 1`, `--sharpness 1`,
`--keyint -1`, `--enable-qm 1`.

**General cargo-cult list:** `--scd 1` (forcibly reset to 0; under av1an it also fights our chunk
boundaries); `--enable-tf 0` (superseded by `tf-strength 1`); `--film-grain-denoise 1` (JET: *"it
is terrible"*); `--pin`/`--lp` tuning (does not change CRF output); `--enable-hdr` (**does not
exist**); `--keyint = 10×fps` (wrong under av1an); `mbr` caps from copied Doom9 strings
(**silently distort a target-quality search**); "always preset 4" — preset *meanings* shifted in
v2.1.0, v2.3.0 and v3.0.0, so **any preset advice predating 2025-02 is not transferable**.

---

## 8. Contested points

**Tune — no consensus.** tune 1 (JET, SSIMULACRA2-derived, and our sweep) vs tune 0 (ORI,
ffmpeg.party, cynthia2006, psyex default, Boulder — all eye-driven) vs tune 2 (Codec Wiki; but
tune 2 was **broken until v3.1.1**). Mainline's own comment is telling:
`TUNE_PSNR = 1, // Average of (PSNR, SSIM, VMAF)` — not pure PSNR.

**qm-min.** Codec Wiki says 0; JET says experiment below 8. But **no maintainer ships 0** —
mainline's perceptual tunes pick 4, psyex 4, hdr 6. Upstream: a lower QM level *"typically results
in bitstreams with lower bitrate and slightly worse quality in CRF rate control mode"* — under a
quality target that is not free, since the search claws the CRF back down.

**tile-columns.** Direct contradiction: JET recommends 1 at 1080p for decoder speed; upstream
calls tiles a known quality decrease. JET concedes: *"Leave tiles to their default… if you are
trying to maximize efficiency."*

**Variance boost.** cynthia2006 dissents — unlikely to beat simply lowering CRF. Unadvertised
cost found in source (`enc_handle.c:4050`): enabling it **forces 64x64 superblocks**, downgrading
from 128 at presets ≤M6.

---

## 9. Provenance

| Source | Date | Version | Verdict |
|---|---|---|---|
| `--help` from our binary + `Parameters.md` | 2026-07-14 | **v4.2.0** | Ground truth |
| [Codec Wiki deep dive](https://codecs.wiki/blog/svt-av1-fourth-deep-dive-p1) | 2025-06-20 | v2.0–v3.0.1 | Best measured preset data |
| [Boulder / chunknorris](https://forum.doom9.org/showthread.php?t=177029) | 2026-03-23 | hdr | Closest workflow; **subjective** |
| [JET guide](https://jaded-encoding-thaumaturgy.github.io/JET-guide/master/encoding/svtav1/) | current | ~v3.x | Good, but **anime-targeted**; stale on octile, chroma-qm, hdr tune 3 |
| [ffmpeg.party](https://ffmpeg.party/guides/av1/) | 2026-04-27 | unstated | Source of our `enable-overlays` / `scm 0` |
| [cynthia2006 gist](https://gist.github.com/cynthia2006/4ea651a74b0f09e7ea519cfa5f33c695) | 2025-10-06 | v2.3+ | Useful dissent |
| [Codec Wiki SVT-AV1](https://codecs.wiki/docs/encoders/SVT-AV1) | undated | pre-4.0 | Source of our `qm-min 0`; hdr tune-3 claim now wrong |
| [dvaupel gist](https://gist.github.com/dvaupel/716598fc9e7c2d436b54ae00f7a34b95) | "May 2026" | **v0.9.0 (2022)** | Stale despite recent date |
| OTTVerse preset analyses | pre-2024 | — | Predates every preset renumbering |

**Codec Wiki moved**: `wiki.x266.mov` is dead; `codecs.wiki` serves the same content.

---

## 10. Honest gaps

- **No tiered parameter sets exist in the community.** Everyone publishes one set plus a preset
  dial. The three-tier structure is ours; only preset has real tier evidence.
- **No published tune comparison on live-action video for v4.x.** The debate rests on animation
  testing and assertion — which is why our sweep is worth more than the literature here.
- **Nobody has tested tune 4 (SSIMULACRA2-optimised) for video**, despite it being the obvious fit
  for our gate.
- **4K tiering and grain-heavy content are unmeasured**, matching the two open items in our plan.
- **qm-min has no consensus**: "highly content and CRF dependent" is the honest state of the art.

## Highest-value next sweep arms

1. `qm-min 0 vs 4 vs 6`
2. `tune 1 vs 4` — skip tune 0 unless the acceptance criterion also changes
3. `tile-columns 1 vs 0`
4. `enable-overlays 1 vs 0` — measure RAM as well as bytes
5. `ac-bias 0 vs 1.0` on the grain sample, judged by **visual A/B**, not SSIMULACRA2
