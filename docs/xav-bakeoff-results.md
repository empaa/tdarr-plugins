# xav Bake-Off — Results

Evaluation of [emrakyz/xav](https://github.com/emrakyz/xav) against the current
av1an + ab-av1 stack. Plan: `docs/superpowers/plans/2026-08-12-xav-bakeoff.md`.

**Status: Phase A incomplete — blocked on a silent encode failure (see Findings).**
No benchmark numbers recorded yet; nothing has been compared against the baseline.

---

## Environment

| | |
|---|---|
| Date | 2026-08-12 |
| Host | Ubuntu 24.04 VM on the Unraid box, CPU passthrough |
| CPU | AMD Ryzen 9 9950X, 24 vCPU exposed, AVX-512 present |
| RAM | 35 GB (raised from 7 GB mid-session) |
| GPU | none (QXL only) → `build.sh` selects `HW=vulkan` automatically |
| xav commit | `6896aeb5` (2026-08-06, repo HEAD) |
| Toolchain | clang 18.1.3, lld, nasm, meson, ninja, cmake, Rust nightly 1.99.0 |

## Build

Builds successfully on Ubuntu, in ~6 minutes, producing a **22 MB** binary.

**Local patches required (1):**

1. `build_dav1d()` — upstream rewrites dav1d's pkg-config `libdir` with
   `sed "s|libdir=\${prefix}/lib|libdir=\${prefix}/build/src|"`. On Arch (upstream's
   platform) meson writes `libdir=${prefix}/lib`, so this works. On Debian/Ubuntu meson
   writes `libdir=${prefix}/lib/x86_64-linux-gnu`, leaving a dangling multiarch suffix and
   a path that does not exist. FFmpeg's configure then fails with the misleading
   `dav1d >= 1.0.0 not found using pkg-config` — pkg-config resolves the package fine; it is
   the *link test* that fails. Fix: replace the whole `libdir=` line.

**Not statically linked**, despite the README's "NO system-side dependency": links
`libc`, `libm`, `libgcc_s`, and requires **GLIBC_2.38**.

## Deployment viability — positive

- Official Tdarr image `ghcr.io/haveagitgat/tdarr:2.86.01` is **Ubuntu 24.04 / glibc 2.39**,
  so the GLIBC_2.38 floor is satisfied.
- The binary **runs inside the stock official image** (`xav -h`, exit 0).
- Crop detection, scene detection and audio parsing all run correctly inside the container.
- **The container is not a blocker.** `io_uring` vs Docker seccomp was never reached as an
  issue; the encode failure below reproduces identically outside any container.
- **Integration constraint:** xav writes its hashed temp directory *next to the source file*,
  so the source directory must be writable (`os error 30`/EROFS on a read-only mount).

## Findings

### F1 — Silent encode failure (BLOCKING, unresolved)

xav completes crop detection and scene detection, enumerates chunks, then encodes **zero**
of them, muxes an ~865-byte file, prints `DONE` with `100.00%`, deletes its temp dir, and
**exits 0**.

```
┃ Size  ┃ 857.97 MB (22822 kb/s)  0 KB (0 kb/s) 󰛀 100.00% ┃
┃ Video ┃    0x0    ┃ 23.976 fps ┃ 00:05:00              ┃
┃ Time  ┃ 00:00:00 @ 14074.81 fps                        ┃
```

Reproduced on: the 1080p h264+DTS sample (which instead **SIGSEGVs**, exit 139, once an
audio track is present), an ffmpeg remux of it with audio stripped, a 30 s excerpt, and
clean synthetic 1080p sources in both 8-bit h264 and 10-bit HEVC. Reproduces natively and
in the container.

`strings` on the binary reveals error paths that are **never printed**:
`svt_av1_enc_init failed`, `svt_av1_enc_set_parameter failed`, `svt_av1_enc_init_handle failed`.
So SVT initialisation is failing and the error is swallowed.

Ruled out on evidence:
- Encoder parameters — defaults fail identically.
- FFmpeg ABI drift — xav's hand-declared `AVStream` and `AVCodecParameters` match the linked
  FFmpeg 63 field-for-field, and fps/duration parse correctly (only the *output* reads 0x0).
- The SVT-AV1 build itself — `SvtAv1EncApp` from the same build encodes fine standalone
  (60 frames, 342 fps, valid 102 KB output).
- Source-specific problems — clean synthetic sources fail too.
- Container/seccomp — fails natively as well.

Leading hypothesis: **SVT-AV1 fork mismatch.** xav hardcodes `EbSvtAv1EncConfiguration`
(with a fixed `_padding: [u8; 128]` tail) and carries fork-specific compile-time handling
(`Cargo.toml` has an `svt-essential` feature that `build.sh` enables only for that fork), so
the forks' struct layouts genuinely differ — with **no compile-time check**. All testing so
far used `mainline`, chosen by us; upstream lists `hdr` first and prompts interactively.
Test in progress.

### F2 — Interrupted PGO builds leave a poisoned artifact

`cleanup_existing()` decides a component is complete purely by whether its artifact file
exists. A build interrupted between SVT's PGO *generate* and *use* stages leaves an
instrumented `libSvtAv1Enc.a` that looks finished. Every later run links it and fails at the
final link with `undefined symbol: __llvm_profile_instrument_target`.
**Operational rule: if a build is interrupted, wipe the component directory — never trust the resume.**

### F3 — Changing an external library does not trigger a relink

`build.sh` runs `cargo clean` only in its interactive path; with a preset (`static_tq`) it
skips it. Cargo does not track `libSvtAv1Enc.a`, so swapping the SVT fork or version
**silently relinks nothing** and reports "Build complete" in zero seconds against the old
binary. This invalidated one of our own test results before it was caught.
**Operational rule: always `cargo clean` before rebuilding after any dependency change.**

### F4 — No aomenc support

Zero mentions of aomenc/libaom in the 134 KB guide. Encoders are SVT-AV1, AVM (AV2),
vvenc, x265, x264. Since aomenc is our primary encoder today, adopting xav means
**switching encoders**, not just swapping the orchestrator. Emil has accepted this
trade-off provided SVT-AV1 delivers the results.

### F5 — Unpinned upstream clones

opus, dav1d and FFmpeg are cloned from HEAD with no pinning; FFmpeg landed on `n9.1-dev`
built from a commit dated the same day. As a consumer this is tolerable (we keep the built
binary), but a rebuild is not reproducible and can drift under us.

## Requirements this imposes on any future xav plugin

- **Validate the output before reporting success**: non-zero dimensions, frame count within
  tolerance of the source, duration match, and a minimum size floor. Throw on failure so
  Tdarr's own error handling runs and the original is never discarded. F1 is precisely the
  failure mode this guards against — exit 0, plausible-looking file, no content.

## Still not measured

Baseline (Task 1), decode-correctness comparison (Task 3), speed/RAM bake-off (Task 4),
audio/mux fidelity (Task 5). All gated on F1.

**Comparison ground rule** (Emil, 2026-08-12): xav as its author intended vs our stack as we
intended it — both sides use their own chosen component versions. No artificial pinning.
