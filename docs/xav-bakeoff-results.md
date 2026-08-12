# xav Bake-Off — Results

Evaluation of [emrakyz/xav](https://github.com/emrakyz/xav) against the current
av1an + ab-av1 stack. Plan: `docs/superpowers/plans/2026-08-12-xav-bakeoff.md`.

**Status: xav works. Phase A functional checks pass.** Two integration constraints found
(TTY, seccomp), both solvable. Baseline comparison not yet run.

> **Correction (2026-08-12):** an earlier revision of this document concluded xav was broken
> upstream and encoded nothing. That was wrong. The cause was our own test harness — every
> command was run from a non-interactive shell, and xav switches to pipe-input mode when
> stdin is not a TTY. See F1.

---

## Environment

| | |
|---|---|
| Date | 2026-08-12 |
| Host | Ubuntu 24.04 VM on the Unraid box, CPU passthrough |
| CPU | AMD Ryzen 9 9950X, 24 vCPU, AVX-512 present |
| RAM | 35 GB |
| GPU | none (QXL) → `build.sh` selects `HW=vulkan` |
| xav commit | `6896aeb5` (2026-08-06, repo HEAD) |
| Final build | `static_tq`, **fully unpinned / upstream defaults** — SVT-AV1 `hdr` fork `v4.1.0-19-g8b4b9f562`, FFmpeg `n9.1-dev-780`, dav1d 1.5.4, Rust nightly 1.99.0 |

All pins we had introduced were removed and the build re-verified. The only remaining local
change is the dav1d Ubuntu build fix, which is a bug fix rather than a pin. **FFmpeg version
is immaterial to xav's performance here:** n8.1.2 gave 223.30 fps and n9.1-dev gave 226.95 fps
on the identical job — run-to-run noise, byte-comparable output.

## First real numbers (not yet a comparison)

Real 5-minute 1080p sample (h264 + DTS 7.1), `-w 4 -p "--preset 8 --crf 32 --lp 3" -a "auto 1"`:

| | |
|---|---|
| Encode rate | **223 fps** (32 s of encode time for 5 min of 1080p) |
| Size | 857.97 MB → 93.01 MB (**89.16% reduction**) |
| Video | AV1 **1920x960** yuv420p10le — autocrop correctly removed letterboxing |
| Audio | Opus, **7.1 layout preserved** |
| Integrity | duration within 0.05 s of source; full ffmpeg decode with zero errors |

These are xav-only figures at settings not yet matched to the baseline. **No comparison has
been made yet** — Task 1 (baseline) and Task 4 (matched bake-off) are still outstanding.

## Build

Builds on Ubuntu in ~6 minutes, 22 MB binary. **One local patch required.**

**Patch 1 — dav1d pkg-config libdir (Debian/Ubuntu portability bug).** Upstream rewrites
dav1d's `.pc` with `sed "s|libdir=\${prefix}/lib|libdir=\${prefix}/build/src|"`. On Arch meson
writes `libdir=${prefix}/lib`, so it works; on Debian/Ubuntu meson writes
`libdir=${prefix}/lib/x86_64-linux-gnu`, leaving a dangling multiarch suffix pointing at a
nonexistent path. FFmpeg's configure then fails with the misleading
`dav1d >= 1.0.0 not found using pkg-config` — pkg-config resolves it fine; the *link test*
fails. Fix: replace the whole `libdir=` line.

**Not statically linked**, despite the README's "NO system-side dependency": links `libc`,
`libm`, `libgcc_s`, requires **GLIBC_2.38**. The official Tdarr image is Ubuntu 24.04 /
glibc 2.39, so this is satisfied.

**FFmpeg version is not constrained:** xav compiles cleanly against both n8.1.2 (major 62)
and n9.1-dev (major 63). It will not fight our stack's FFmpeg 8.1.2 pin.

## Findings

### F1 — xav requires a TTY on stdin (CRITICAL for plugin integration)

xav switches to **pipe-input mode** when stdin is not a TTY. In that mode it reads video from
stdin, gets nothing, muxes an ~870-byte file, prints `DONE 100.00%` with `Video 0x0`, and
**exits 0**. With an audio track present it instead SIGSEGVs (exit 139); one run hung
indefinitely waiting on stdin.

Confirmed by elimination — identical failure across both SVT forks, FFmpeg 8.1.2 and
9.1-dev, TQ on and off, every source type (including synthetic 8-bit and 10-bit), natively
and in-container, at 1/2/4 workers, with default and explicit params. The tell was the only
useful error message produced all session, from `--hwdec`:
`Hardware accelerated decoding can not be used with a pipe`.

**`/dev/null` and closed stdin also fail.** Only a real TTY works:

```bash
script -qec "xav in.mkv out.mkv -w 4 -p '--preset 8 --crf 32'" /dev/null
```

**Mechanism, confirmed in source** (`src/y4m.rs`):

```rust
pub fn is_pipe() -> bool {
    !stdin().is_terminal()   // = !isatty(0)
}
```

There is **no flag, no env var and no override** — pipe mode is decided solely by `isatty(0)`,
so *any* non-interactive caller (Docker without `-t`, systemd, cron, CI, Node
`child_process`) is treated as sending piped Y4M.

**Worth proposing upstream:** checking `S_ISFIFO(fstat(0))` instead of `!isatty(0)` would
distinguish a real pipe from `/dev/null`, a closed fd, or a redirected stdin — and would have
made every failure in this session impossible. That is a far more useful bug report than
"it doesn't work".

**Consequence for a Tdarr plugin:** Tdarr spawns processes via Node `child_process` with no
TTY, so a naive plugin would silently produce empty files in production. The plugin **must**
allocate a PTY. `script` (util-linux 2.39.3) is present in the official Tdarr image and works.

### F2 — Docker's default seccomp blocks io_uring (mux fails)

Inside the stock official Tdarr image, xav encodes correctly but fails at the mux stage with
`io_uring_setup failed (errno 1)` (EPERM). With `--security-opt seccomp=unconfined` the same
command completes and produces a valid AV1 file.

Needs either `seccomp=unconfined` or a custom profile allowing `io_uring_setup`/`_enter`/
`_register`. On our own hardware that is our call to make, but it is a real deployment
constraint and weakens container isolation.

### F3 — Interrupted PGO builds leave a poisoned artifact

`cleanup_existing()` decides a component is complete purely by whether its artifact exists. A
build interrupted between SVT's PGO *generate* and *use* stages leaves an instrumented
`libSvtAv1Enc.a` that looks finished; later runs link it and fail with
`undefined symbol: __llvm_profile_instrument_target`.
**Rule: if a build is interrupted, wipe the component directory — never trust the resume.**

### F4 — Changing an external library does not trigger a relink

`build.sh` runs `cargo clean` only in its interactive path; with a preset it skips it, and
cargo does not track `libSvtAv1Enc.a`. Swapping the SVT fork silently relinks nothing and
reports "Build complete" in zero seconds against the old binary — this invalidated one of our
own test results before it was caught.
**Rule: always `cargo clean` before rebuilding after any dependency change.**

### F5 — No aomenc support

Zero mentions of aomenc/libaom in the 134 KB guide. Encoders: SVT-AV1, AVM (AV2), vvenc,
x265, x264. Adopting xav means **switching encoders**, not just swapping the orchestrator.
Emil has accepted this provided SVT-AV1 delivers.

### F6 — Other operational notes

- **Writable source directory required:** xav writes its hashed temp dir next to the input
  (`os error 30`/EROFS on a read-only mount).
- **Resume reuses `cmd.txt`:** re-running after an interrupted job replays the *original*
  command, including its output filename, ignoring newly-passed arguments.
- **Refuses to overwrite an existing scene file** — it exits rather than regenerate.
- **Unpinned upstream clones:** opus, dav1d and FFmpeg are cloned from HEAD. Tolerable for a
  consumer who keeps the built binary, but rebuilds are not reproducible.
- **AVX-512 effectively required:** 15 hard `target_feature = "avx512bw"` gates with no
  fallback; the build fails to compile at `-C target-cpu=x86-64-v3`.
- **Test suite** needs `git submodule update --init` for `test_files`. With it: 32 passed,
  68 failed, and every failure is `hw_*`/`dim_hw_*`/`tq::*` — i.e. GPU-dependent, expected
  on this GPU-less box.

## Two viable plugin designs (guide section 4, "Pipe Into XAV")

Pipe input is a first-class feature: you send Y4M (`YUV420P` or `YUV420P10LE`) frames from
ffmpeg CLI or `vspipe`, while still passing the input file as an argument (xav analyses the
original for scene detection and metadata regardless).

| | **A: PTY wrapper** | **B: deliberate Y4M pipe** |
|---|---|---|
| Mechanism | `script -qec "xav ..." /dev/null` | `ffmpeg -i in -f yuv4mpegpipe - \| xav in.mkv out.mkv` |
| Decode | xav's own optimised path | ffmpeg/vspipe does it — README: **slower than native** |
| Non-interactive | Works, but relies on a PTY | **The supported path** — no TTY needed |
| Resume | Full native resume | Degraded: sender must replay all frames, identical pipe command required (VapourSynth on Linux excepted — xav can analyse the pipe and jump to the resume point) |
| Filtering | None | Full ffmpeg/VapourSynth chains |
| `--hwdec` | Available | Incompatible (frames arrive decoded) |

Pipe mode constraints: **no** framerate change, tonemapping/colour change, or frame decimation
(all need a lossless intermediate); VFR unsupported. Allowed: any filtering, down/upscaling,
denoise, deband, dehalo — and xav adapts its crop detection to a downscaled pipe.

Note this reopens something we had written off: our existing **VapourSynth filtering**
(downscale, grain synthesis) would still work via `vspipe`, at the cost of the
"no VapourSynth" simplification that made xav attractive. Lean is A as the default path with
B available, but that is a post-numbers decision.

## Requirements for any future xav plugin

1. **Allocate a PTY** (F1) — without it, silent empty output.
2. **Validate the output before reporting success**: non-zero dimensions, frame count within
   tolerance of source, duration match, minimum size floor. Throw on failure so Tdarr's error
   handling runs and the original is never discarded.
3. **Ensure io_uring is permitted** in the node container (F2).
4. **Source directory must be writable** (F6).

## Still to do

Task 1 (baseline), Task 3 (decode-correctness comparison), Task 4 (matched speed/RAM
bake-off), Task 5 (audio/mux fidelity vs current stack).

**Comparison ground rule** (Emil, 2026-08-12): xav as its author intended vs our stack as we
intended it — both sides use their own chosen component versions. No artificial pinning.
