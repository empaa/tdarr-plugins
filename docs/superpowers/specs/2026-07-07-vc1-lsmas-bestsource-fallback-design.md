# VC-1 lsmas → BestSource Automatic Fallback

## Summary

Add an automatic, per-file fallback from L-SMASH Works (lsmas) to a ffmpeg-based
VapourSynth source (BestSource) when lsmas fails to decode the source. This fixes
av1an crashing on VC-1 (and any other lsmas-hostile) input while keeping lsmas as
the fast default for the files it already handles. Spans two repos: plugin changes
here (`av1anEncode`, `crfSearchEncode`, a new shared module) plus a sibling
(`tdarr-av1`) image change to ship the BestSource VapourSynth plugin.

## Background — proven root cause

**Symptom:** `The Hangover (2009) … [VC1]-FraMeSToR.mkv` (VC-1 Advanced, 1080p
progressive, TrueHD 5.1) fails on the production node. The sanitizer succeeds, then
av1an exits in ~11s (far too fast to be encoding).

**Investigation** (production job `xOsg2Sh4f` + direct reproduction inside
`tdarr_node_ryzen_9950x` on the real file):

- av1an panic: `thread 'main' panicked at av1an-core/src/split/mod.rs:167 — split
  scores is not empty`, in `Av1anContext::split_routine` (scene splitting). The exact
  line is `.expect("split scores is not empty")` inside `enhanced_extra_splits`: for a
  scene longer than the extra-split length, av1an looks up per-frame scene-cut scores in
  a frame-index window; that window was empty.
- **Direct cause:** lsmas cannot decode this VC-1 stream. `vspipe` decode of the
  plugin's `.vpy` errors at frame 728 of 155209:
  `Error: Failed to retrieve frame 728 with error: lsmas: failed to output a video
  frame.` Note: `vspipe --info` (the index build) *succeeds* and reports the full
  155209-frame count — the failure is at decode time, not index time.
- With the scene detector starved to ~728 frames, av1an finds "2 scene(s)" spanning the
  nominal 155209-frame length, then `enhanced_extra_splits` hits the empty score window
  and panics.
- **ffmpeg's native VC-1 decoder decodes the entire file cleanly** (`ffmpeg -f null`:
  exit 0, zero decode errors). BestSource wraps ffmpeg, so it is expected to decode this
  file where lsmas cannot.

**Key constraints discovered:**

- lsmas is the **only** VapourSynth source filter in the stack image. No BestSource, no
  ffms2. So a ffmpeg-based source requires a sibling image change.
- The ffmpeg build in the stack has **no x264/x265** (AV1-only stack). A transcode-based
  "prepare the file" fix would be limited to FFV1 (lossless, huge) or MPEG-2/4 (ugly) —
  rejected in favour of this source-swap approach.
- `-x 0` (disable extra-splits) only *hides* the panic; the encode would still be built
  from ~728 usable frames and be broken. Rejected.

**Failure sentinels (verified):**

- `av1anEncode` runs av1an in one shot; on the split panic the temp contains
  `done.json`, `encode/`, `split/` but **no `chunks.json`**. `chunks.json` is written
  only after scene-splitting succeeds, so its absence on a non-zero exit reliably means
  "died at/before scene-splitting" = a source-decode failure.
- `crfSearchEncode` runs av1an `--sc-only --scenes <path>`; that JSON (with
  `frames`/`scenes`/`split_scenes`) is written only *after* extra-splits, so the panic
  leaves it **unwritten/empty** — the analogous sentinel.

## Scope

1. New shared module `src/shared/vsSource.js` — source-`.vpy` construction + failure gate.
2. `src/av1anEncode/index.js` — try-lsmas → fall-back-to-BestSource around the av1an run.
3. `src/crfSearchEncode/index.js` — same fallback around its `--sc-only` scene detection
   (and the resulting `.vpy` is reused for phase-2 av1an).
4. Sibling request to `tdarr-av1` — add the BestSource VapourSynth plugin to the image.

Out of scope: `abAv1Encode` (pure ab-av1 / ffmpeg, does not touch lsmas — unaffected).
Out of scope: making BestSource the default source (explicitly rejected — keeps lsmas fast
for the ~99% of files it handles).

---

## Shared module: `src/shared/vsSource.js`

Single responsibility: build a source `.vpy` for a chosen filter, and decide whether an
av1an run failed because of the source.

```
SOURCE_LSMAS      = 'lsmas'
SOURCE_BESTSOURCE = 'bestsource'

buildSourceVpy({ sourceFilter, inputPath, cachePath, fpsNum, fpsDen, downscaleLines }) -> string
  // returns the full .vpy text:
  //   lsmas:      core.lsmas.LWLibavSource(source='...', cachefile='<cachePath>')
  //   bestsource: core.bs.VideoSource(source='...', cachepath='<cachePath>')
  //               src = core.std.AssumeFPS(src, fpsnum=<fpsNum>, fpsden=<fpsDen>)   # see below
  // followed by the (optional) downscale filter lines, then src.set_output()
  // Python-escapes the source path exactly as the plugins do today (escPy).

sourceFailedBeforeChunking(av1anTempDir) -> boolean   // av1anEncode gate
  // true when chunks.json is absent (encoding never started)

sceneDetectProducedScenes(scenesJsonPath) -> boolean  // crfSearchEncode gate
  // true when the --scenes file exists and parses with a non-empty split_scenes/scenes
```

The downscale filter chain (`buildVsDownscaleLines`) is unchanged and sits below the
source line regardless of filter, so downscale/HDR behaviour is identical on both paths.

Cache paths differ per filter: lsmas writes `source.lwi`, BestSource writes its own cache
via the `cachepath` param; the module owns both.

**BestSource fps quirk — AssumeFPS is required (validated).** BestSource auto-detects the
*wrong* framerate for this VC-1 remux: `core.bs.VideoSource` alone yields `10.979 fps`
(av1an banner: `Input: 1920x1080 @ 10.979 fps`) while the true rate is `24000/1001`
(23.976). The frame *count* is correct (155209), only the timebase is wrong — an
uncorrected encode would have the wrong duration and broken A/V sync. Fix:
`core.std.AssumeFPS(src, fpsnum, fpsden)` using the source's ffprobe `r_frame_rate`
(a metadata relabel — verified to preserve the exact frame count: 155209 → 155209, fps →
23.976, av1an banner → `@ 23.976 fps`). AssumeFPS is applied on the BestSource path
(harmless no-op if ever applied to lsmas, which already reports the correct rate). If
`r_frame_rate` is missing/`0`, skip AssumeFPS and log a warning.

## av1anEncode fallback flow

1. Build `source.vpy` with lsmas (`SOURCE_LSMAS`), build the lwi index (`vspipe --info`),
   run av1an — all exactly as today.
2. If av1an exits non-zero **and** `sourceFailedBeforeChunking(av1anTemp)`:
   - Log: `lsmas failed before chunking (source decode issue) — retrying with BestSource`.
   - If BestSource is unavailable in the image, log a clear "stack update required"
     message and throw (VC-1 stays broken exactly as today; nothing else regresses).
   - Rebuild `source.vpy` with `SOURCE_BESTSOURCE`, wipe the av1an temp and stale index,
     re-run av1an **once**.
3. If the BestSource run also fails, or av1an failed *with* `chunks.json` present
   (a genuine mid-encode failure, not a source issue) → throw as today.

Only the source line changes on retry; `--target-quality`, downscale args, encoder flags,
progress tracking, audio merge, and size-guard logic are untouched.

## crfSearchEncode fallback flow

The lsmas `.vpy` feeds an av1an `--sc-only --scenes <scenesPath>` pass (run in parallel
with ab-av1 CRF search) and later phase-2 av1an.

1. Build `source.vpy` with lsmas; run `--sc-only` scene detection as today.
2. If scene detection exits non-zero **and** `!sceneDetectProducedScenes(scenesPath)`:
   rebuild `source.vpy` with BestSource, delete the stale `scenes.json`, and re-run
   `--sc-only`. The BestSource `.vpy` is then used for phase-2 av1an as well (so the whole
   job uses one consistent source).
3. If scene detection still fails on BestSource → throw (existing behaviour).

ab-av1 CRF search reads the source directly via ffmpeg and is not affected by the lsmas
decode bug, but must run against the same source the encode uses; phase-2 av1an uses the
selected `.vpy`, so consistency is preserved.

## Deploy sequencing / graceful degradation

The plugin is safe to ship independently of the image:

- Before the image has BestSource: lsmas is tried first (unchanged for working files); on
  a VC-1 failure the fallback `.vpy` errors on `core.bs` (missing) and we throw with a
  "BestSource not available — stack update required" message. VC-1 remains broken exactly
  as it is today; **no non-VC-1 regression**.
- After the new image lands: VC-1 auto-recovers on the BestSource retry with no further
  plugin change.

## Error handling

- Distinguish source failures (retry) from genuine failures (throw) via the verified
  sentinels — never retry a failure that occurred after encoding started.
- Per project convention: throw on unrecoverable failure for Tdarr's built-in handler;
  no error output port.
- Observability gap noted during debugging: the plugin's `AV1AN_KEEP` output filter keeps
  the `panicked …` line but drops the following reason line and the lsmas decode error.
  Widen the filter (or capture the source-error line) so the lsmas failure and the
  fallback decision are visible in the job log.

## Testing

- **Unit** (`vsSource.js`): lsmas vs BestSource `.vpy` generation (incl. path escaping and
  downscale lines below the source line); `sourceFailedBeforeChunking` and
  `sceneDetectProducedScenes` gates against fixture temp dirs.
- **E2E** on the interactive test server once the new image is up: run `av1anEncode` on
  the VC-1 sample, confirm the lsmas→BestSource fallback fires and the encode completes;
  confirm a normal (non-VC-1) file still uses lsmas with no retry and no overhead.
  Mandatory VS plugin-autoload check on the new image (per stack-update testing protocol).
- **Pre-validation — DONE (2026-07-07).** Built BestSource (commit `bf3554d`) in a
  throwaway `--rm` container off the `tdarr_node` image, against its VS R77 + ffmpeg 8.1.2.
  Result: BestSource decoded the exact VC-1 file end-to-end — `vspipe --info` index pass
  (a full linear decode) completed with exit 0, **155209 frames, zero decode errors** (vs
  lsmas dying at frame 728). AssumeFPS relabel verified (see shared-module section). The
  fix is confirmed to work before any sibling rebuild.

## Sibling request (to `tdarr-av1` inbox)

Add the BestSource VapourSynth plugin to the stack image. Build recipe is already worked
out (from the pre-validation build against this exact image):

- Source: `https://github.com/vapoursynth/bestsource` (validated at commit `bf3554d`),
  clone `--recurse-submodules` (vendors `libp2p`).
- Extra build dep beyond the current toolchain: **`libxxhash-dev`** (plus a C++ compiler;
  meson/ninja/nasm/pkg-config already present). Builds against the image's `/usr/local`
  VS + ffmpeg via `pkg-config` (`meson setup build --buildtype release && ninja -C build`).
- Output `libbestsource.so` → install into the VS autoload dir
  `/usr/local/lib/python3/dist-packages/vapoursynth/plugins/`.
- API confirmed: `core.bs.VideoSource(source=…, cachepath=…)`; namespace `bs`.

Needed back: confirmation the plugin autoloads (`core.bs` resolves in a stock `vspipe`
run on the published image) and the final `.so` path. Note the fps quirk (we handle it
plugin-side via AssumeFPS — no sibling action needed). Publishing of the new image is
gated on our confirmation, per existing protocol.

## Open questions / to confirm during implementation

- BestSource `.vpy` API is confirmed (`core.bs.VideoSource(source=, cachepath=)`), and the
  fps quirk + AssumeFPS fix are validated. Remaining: confirm the autoload `.so` path on
  the *published* sibling image matches the throwaway build.
- Whether to generalize the fallback trigger beyond the two verified sentinels (kept
  minimal for now — YAGNI).
