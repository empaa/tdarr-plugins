# XAV Bake-Off Evaluation Plan

> **For agentic workers:** This is an *evaluation* plan, not an implementation plan. Tasks are experiments with explicit pass/fail gates, not TDD cycles. No plugin source is modified in any task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decide, on evidence, whether [xav](https://github.com/emrakyz/xav) should replace any part of the av1an + ab-av1 + VapourSynth + ffmpeg + mkvmerge pipeline — before a single line of plugin code or sibling image change is written.

**Architecture:** Two phases with a hard gate between them. **Phase A** runs entirely on this VM (12 vCPU, 7 GB RAM, no GPU), CPU-only, no target quality, 1080p only, and answers the three cheap questions: *does it build, does it decode our problem sources correctly, is it fast.* **Phase B** (target quality via GPU metrics, 4K/HDR memory behaviour) is deliberately deferred because this VM cannot run it — it requires GPU passthrough and more RAM, and is only worth that disruption if Phase A passes.

**Tech Stack:** xav (Rust nightly, no-std, statically links its own FFmpeg/dav1d/SVT-AV1/opus), compared against the current containerised stack in `../tdarr-av1` (av1an + ab-av1 + SVT-AV1 v4.2.0 shared lib + VapourSynth/lsmas).

## Global Constraints

- **No plugin source changes in this plan.** `src/` is untouched. If xav wins, integration is a *separate* plan.
- **No sibling repo edits.** Findings go to `../tdarr-av1` via the inbox, not by editing their files.
- **Nothing runs against production.** Prod (`tdarr_node_hometower`, `10.0.0.3:8265`) is read-only. All work is local to this VM.
- **VM hardware (measured 2026-08-12):** 12 vCPU · 7 GB RAM total (~2 GB free at rest) · no GPU (QXL paravirtual only) · `/` has 29 GB free · `/mnt/vm_data` has 794 GB free. Every task must respect these; put all build artifacts on `/mnt/vm_data`.
- **Samples available (all 1080p):** `test/samples/jurassic_sample.mkv` (980 MB, fast iteration), `Frozen II (2019) ... [TrueHD Atmos 7.1][x265]-playBD.mkv` (14 GB, HEVC + Atmos), `Snow White (2025) ... [TrueHD Atmos 7.1][AV1]-ATELiER.mkv` (5 GB, AV1 source). **No 4K/HDR sample exists locally** — the 4K question cannot be answered in Phase A.
- **Encoder parity:** baseline prod builds **mainline SVT-AV1 v4.2.0** (`../tdarr-av1/Dockerfile:34`). xav must be built against the same fork and pinned to the same tag, or the speed comparison is meaningless.
- **Primary metric is encode FPS** (established project convention), with peak RSS and output size as co-equal guardrails.
- **Every task ends by appending its result — numbers, not impressions — to `docs/xav-bakeoff-results.md`.** A task with no recorded numbers is not done.

---

## Phase A — cheap kill tests (this VM, CPU-only, no TQ)

### Task 1: Record the current-stack baseline

Do this **first**, before installing anything for xav — the toolchain install changes the box, and the baseline must reflect the box as it is today.

**Files:**
- Create: `docs/xav-bakeoff-results.md`
- Uses: `test/benchmark.js` (existing harness, `--reality` mode)

**Prerequisite:** the local interactive test server must be running (sibling `../tdarr-av1`, `build.sh --interactive`). **Ask the user to start it — do not start containers unprompted.**

- [ ] **Step 1: Confirm the container is up and note its SVT version**

```bash
docker ps --format '{{.Names}}' | grep -i tdarr
docker exec tdarr-interactive-node SvtAv1EncApp --version 2>&1 | head -3
```

Record the exact SVT-AV1 version string. Expected: 4.2.0 (mainline).

- [ ] **Step 2: Baseline run on the fast sample**

```bash
TDARR_CONTAINER=tdarr-interactive-node npm run benchmark -- \
  --encoder svt-av1 --cpu-used 6 --reality 120 \
  --sample jurassic --custom '{"workers":4,"threadsPerWorker":3,"vmafThreads":6}' \
  2>&1 | tee /tmp/baseline-jurassic.log
```

`--reality 120` trims 120 s from the middle and encodes to completion, so the FPS number is a real encode rate, not a partial-run extrapolation. Fixed `--custom` config (not preset auto-detect) so xav can be given the identical worker×thread budget.

- [ ] **Step 3: Baseline run on the HEVC + Atmos sample**

```bash
TDARR_CONTAINER=tdarr-interactive-node npm run benchmark -- \
  --encoder svt-av1 --cpu-used 6 --reality 120 \
  --sample Frozen --custom '{"workers":4,"threadsPerWorker":3,"vmafThreads":6}' \
  2>&1 | tee /tmp/baseline-frozen.log
```

- [ ] **Step 4: Record the numbers**

Create `docs/xav-bakeoff-results.md` with a table capturing, per sample: encode FPS, peak RAM (the harness prints `ram:` live — take the max), output size in MiB, wall-clock, scene count, and SVT version. Also record `nproc`, total RAM, and the date. These are the numbers every later task is compared against.

- [ ] **Step 5: Commit**

```bash
git add docs/xav-bakeoff-results.md docs/superpowers/plans/2026-08-12-xav-bakeoff.md
git commit -m "docs: xav bake-off plan + current-stack baseline numbers"
git push origin dev
```

---

### Task 2: Build xav on the VM (no-TQ, CPU-only)

**Why no-TQ:** `build.sh` mode 2 (`static_notq`) skips Vship entirely and sets the Vulkan backend — this is the only mode this GPU-less VM can build. Target quality is Phase B.

**Files:**
- Create: `/mnt/vm_data/xav/` (checkout), `/mnt/vm_data/xav-build/` (upstream sources)
- Nothing in this repo is modified.

**Kill criteria:** abandon Phase A if the build is not producing a binary after ~3 hours of active effort, or if it fails in xav's own Rust code (as opposed to a missing host package we can install). A build we cannot reproduce is a build the sibling image cannot reproduce either.

- [ ] **Step 1: Install the host toolchain**

`build.sh`'s `install_deps` only knows pacman/dnf/emerge/brew — **this VM is Ubuntu, so auto-install will not fire.** Install manually:

```bash
sudo apt update && sudo apt install -y \
  clang lld llvm nasm meson ninja-build cmake pkgconf ffmpeg \
  libc++-dev libc++abi-dev git curl
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain nightly
source "$HOME/.cargo/env"
```

Note: `ffmpeg` (the binary) is a hard requirement of `build.sh`'s pre-flight check even though xav links its own libav.

- [ ] **Step 2: Verify every tool build.sh gates on**

```bash
for i in cargo ffmpeg clang pkgconf ninja meson cmake nasm; do
  printf '%-10s ' "$i"; command -v $i >/dev/null && $i --version 2>&1 | head -1 || echo MISSING
done
rustc +nightly --version
```

Expected: no MISSING. `build.sh` exits immediately if any of `cargo ffmpeg clang pkgconf ninja meson cmake` is absent.

- [ ] **Step 3: Redirect the build directory off the root filesystem**

`BUILD_DIR` is hardcoded to `$HOME/.local/src` (`build.sh:63`), which lives on `/` with only 29 GB free. FFmpeg + SVT-AV1 + dav1d + opus + Vulkan sources and objects will approach that. Symlink it:

```bash
mkdir -p /mnt/vm_data/xav-build
[ -e "$HOME/.local/src" ] && mv "$HOME/.local/src" "$HOME/.local/src.bak"
mkdir -p "$HOME/.local"
ln -s /mnt/vm_data/xav-build "$HOME/.local/src"
ls -ld "$HOME/.local/src"
```

- [ ] **Step 4: Pre-clone SVT-AV1 pinned to the baseline tag**

`clone_async` skips any target directory that already exists (`build.sh:266`). Pre-seeding it is how we pin SVT to the same version prod uses, instead of letting xav build an unpinned HEAD:

```bash
git clone --branch v4.2.0 https://gitlab.com/AOMediaCodec/SVT-AV1.git /mnt/vm_data/xav-build/SVT-AV1
git -C /mnt/vm_data/xav-build/SVT-AV1 describe --tags
```

Expected: `v4.2.0`. Record in the results doc that opus/dav1d/FFmpeg remain unpinned HEAD clones — that is a real reproducibility problem for the sibling image and must be reported regardless of the bake-off outcome.

- [ ] **Step 5: Clone and build xav**

```bash
git clone https://github.com/emrakyz/xav /mnt/vm_data/xav
cd /mnt/vm_data/xav
git log -1 --format='%H %ci' | tee -a /tmp/xav-build.log
time ./build.sh static_notq mainline 2>&1 | tee -a /tmp/xav-build.log
```

`static_notq` = mode 2 (no Vship / no TQ), `mainline` = the SVT fork matching prod. This builds opus, dav1d, SVT-AV1 (with a PGO training pass that downloads a 4K sample) and FFmpeg in parallel, then link-time-optimises the Rust binary.

**Watch RAM.** With 7 GB total, parallel builds plus fat LTO may OOM. If the OOM killer fires, re-run — the script skips already-completed components (it checks for each artifact and returns early), so a rerun resumes rather than restarting.

- [ ] **Step 6: Verify the binary**

```bash
ls -la /mnt/vm_data/xav/target/release/xav
file /mnt/vm_data/xav/target/release/xav          # expect: statically linked
ldd /mnt/vm_data/xav/target/release/xav 2>&1       # expect: "not a dynamic executable"
/mnt/vm_data/xav/target/release/xav -h | head -40
```

Expected: a static binary, `-h` prints the CLI. Record binary size and total build wall-clock — both matter to the sibling image decision.

- [ ] **Step 7: Record the build cost and any deviations**

Append to `docs/xav-bakeoff-results.md`: build wall-clock, peak RAM during build, binary size, xav commit hash, every apt package that had to be installed, and every place `build.sh` needed manual intervention on Ubuntu. This section *is* the dependency spec the sibling would need.

- [ ] **Step 8: Commit**

```bash
git add docs/xav-bakeoff-results.md
git commit -m "docs(xav): build results and Ubuntu toolchain requirements"
git push origin dev
```

---

### Task 3: Decode correctness on our known-problem sources

This is the highest-information task in the plan. The whole thesis is that xav's own decoder removes the VapourSynth/lsmas bug class — silent mid-grey frames on cold seeks, and the "found 1 scene(s)" silent decode failure on feature-length sources. If that thesis is wrong, nothing else matters.

**Files:**
- Modify: `docs/xav-bakeoff-results.md`

**Kill criteria:** if xav mis-decodes any of the three samples (implausible scene count, grey/black frames at chunk boundaries), stop. It has no advantage over lsmas and none of lsmas's track record.

- [ ] **Step 1: Scene detection only, all three samples**

xav writes a hidden temp dir (hashed from the input) *next to the working directory*, so run everything from a scratch dir on the big filesystem — never from `test/samples/`, which must stay clean:

```bash
mkdir -p /mnt/vm_data/xav-work && cd /mnt/vm_data/xav-work
for f in /mnt/vm_data/ClaudeProjects/tdarr-plugins/test/samples/*.mkv; do
  echo "=== $f"
  time /mnt/vm_data/xav/target/release/xav "$f" --sc-only 2>&1 | tail -5
done
```

Expected: a scene count in the hundreds-to-thousands for the feature films. **A count of 1 (or single digits) on a feature film is a silent source-decode failure, never a success** — the established project rule. Compare each count against the baseline scene count recorded in Task 1.

- [ ] **Step 2: Encode a short range from a cold seek deep into the file**

The lsmas grey-frame bug only appeared when seeking cold into the middle of a source. Reproduce that access pattern:

```bash
/mnt/vm_data/xav/target/release/xav \
  "/mnt/vm_data/ClaudeProjects/tdarr-plugins/test/samples/Frozen II (2019) - [Remux-1080p][TrueHD Atmos 7.1][x265]-playBD.mkv" \
  /mnt/vm_data/xav-work/frozen-coldseek.mkv \
  -r 60000-61200 -w 2 -p "preset 8 crf 30" 2>&1 | tail -20
```

- [ ] **Step 3: Check for grey/black frames in the output**

```bash
docker exec tdarr-interactive-node ffmpeg -hide_banner -i /path/in/container/frozen-coldseek.mkv \
  -vf "signalstats,metadata=print:key=lavfi.signalstats.YAVG" -f null - 2>&1 \
  | grep YAVG | awk '{print $NF}' | sort -n | head -5
```

Expected: no run of frames pinned near a constant mid-grey luma (~128 for 8-bit). A handful of genuinely dark/bright frames is fine; a *sustained flat* YAVG across consecutive frames at a chunk boundary is the failure signature. If the container isn't running, the host `ffmpeg` installed in Task 2 works equally well.

- [ ] **Step 4: Repeat Steps 2–3 on the AV1-source sample**

Same commands against the Snow White sample (AV1 source exercises xav's dav1d path rather than its HEVC path — a different decoder entirely, and worth its own result row).

- [ ] **Step 5: Record and commit**

Record per sample: scene count, scene-detection wall-clock, cold-seek encode success, YAVG findings. Commit and push.

---

### Task 4: Speed and memory bake-off

**Files:**
- Modify: `docs/xav-bakeoff-results.md`

Matched conditions are what make this meaningful: same box, same source, same 120 s middle segment, same SVT version, same preset and CRF, same total worker×thread budget as Task 1's baseline.

- [ ] **Step 1: Fixed-CRF xav encode, matched settings**

```bash
cd /mnt/vm_data/xav-work
/usr/bin/time -v /mnt/vm_data/xav/target/release/xav \
  /mnt/vm_data/ClaudeProjects/tdarr-plugins/test/samples/jurassic_sample.mkv \
  jurassic-xav.mkv -w 4 -p "preset 6 crf 30 lp 3" 2>&1 | tee /tmp/xav-jurassic.log
```

`-w 4` with `lp 3` matches the baseline's 4 workers × 3 threads. `/usr/bin/time -v` gives Maximum resident set size — the peak-RAM number to compare.

- [ ] **Step 2: Repeat on the Frozen II sample**

Same command shape against Frozen II, with `-r` restricted to a 120 s range from the middle so the comparison matches the baseline's `--reality 120`. Compute the frame range as `fps × start_seconds` through `fps × (start_seconds + 120)`.

- [ ] **Step 3: Compare quality at matched CRF**

Equal FPS at worse quality is not a win. Score both outputs against the same source segment with the container's VMAF (the only metric both stacks share — xav's own metrics need a GPU):

```bash
docker exec tdarr-interactive-node ffmpeg -hide_banner \
  -i /path/xav-output.mkv -i /path/baseline-output.mkv \
  -lavfi "[0:v][1:v]libvmaf=model_path=/usr/local/share/vmaf/vmaf_v0.6.1.json" -f null - 2>&1 | tail -5
```

Note in the results that VMAF is being used only as a *common yardstick* here, not as an endorsement — replacing VMAF is one of xav's selling points, and that claim is untestable until Phase B.

- [ ] **Step 4: Record the comparison table**

Per sample: xav FPS vs baseline FPS, xav peak RSS vs baseline peak RAM, output size, VMAF, wall-clock. State plainly whether xav wins, loses, or ties on each axis.

- [ ] **Step 5: Commit and push**

---

### Task 5: Audio and mux sanity

xav replacing mkvmerge and the `audioMerge` shared module is a meaningful chunk of the integration surface, so it needs its own check. Frozen II's TrueHD Atmos 7.1 is the hard case.

**Files:**
- Modify: `docs/xav-bakeoff-results.md`

- [ ] **Step 1: Encode a short range with Opus audio enabled**

```bash
/mnt/vm_data/xav/target/release/xav \
  "/mnt/vm_data/ClaudeProjects/tdarr-plugins/test/samples/Frozen II (2019) - [Remux-1080p][TrueHD Atmos 7.1][x265]-playBD.mkv" \
  /mnt/vm_data/xav-work/frozen-audio.mkv \
  -r 60000-61200 -w 2 -p "preset 8 crf 30" -a "auto 0" 2>&1 | tail -20
```

`-a "auto 0"` = Opus, channel-derived bitrate (76 kbps mono → 331 kbps 7.1), stream 0.

- [ ] **Step 2: Inspect the muxed result**

```bash
ffprobe -hide_banner -show_streams -show_format /mnt/vm_data/xav-work/frozen-audio.mkv 2>&1 \
  | grep -E 'codec_name|channels|channel_layout|TAG:language|TAG:title|duration|bit_rate'
```

Check specifically: channel count and layout preserved (7.1 not silently downmixed unless asked), **language tags preserved**, title tags, duration matches the requested range, and A/V sync (compare stream durations and start times).

- [ ] **Step 3: Verify the container xav produced is well-formed**

```bash
ffmpeg -hide_banner -v error -i /mnt/vm_data/xav-work/frozen-audio.mkv -f null - 2>&1 | head -20
mkvmerge -i /mnt/vm_data/xav-work/frozen-audio.mkv 2>&1 | head
```

Expected: no errors from either. xav writes its own MKV with a hand-rolled muxer — this checks that mkvtoolnix and ffmpeg both accept it, which matters because Tdarr and downstream players will have to.

- [ ] **Step 4: Record findings and commit**

Note any metadata the custom muxer drops (chapters, attachments, subtitle tracks, per-track flags). Anything lost here is integration work that would have to be added back — count it against xav in the decision.

---

### Task 6: Decision and hand-off

**Files:**
- Modify: `docs/xav-bakeoff-results.md`
- Possibly create: `~/.claude/projects/-mnt-vm-data-ClaudeProjects-tdarr-av1/inbox/2026-XX-XX-from-tdarr-plugins-xav-evaluation.md`

- [ ] **Step 1: Write the verdict against explicit criteria**

State a go/no-go using these thresholds, decided *before* seeing the numbers:

| Axis | xav must achieve |
|---|---|
| Decode correctness | No mis-decodes on any sample. **Non-negotiable — a failure here is an immediate no-go.** |
| Encode FPS | Within 10 % of baseline or better. Slower than that needs the quality/TQ upside to justify it. |
| Peak RAM | Not worse than baseline at matched worker count. |
| Quality at matched CRF | Within VMAF noise (±0.5) or better. |
| Audio/mux fidelity | No silent metadata loss that integration can't cheaply restore. |
| Build reproducibility | The unpinned opus/dav1d/FFmpeg clones must be pinnable, or the sibling image can't ship it. |

- [ ] **Step 2: Note the Phase B triggers explicitly**

Whatever the verdict, record what Phase A *could not* test: per-scene target quality (SSIMU2/Butteraugli/CVVDP — needs GPU + CUDA), 4K/HDR memory behaviour (xav documents ~7.5 GB per 4K 10-bit chunk *per worker*; this VM has 7 GB total), and hardware-accelerated decode.

- [ ] **Step 3: If go — message the sibling**

Only if the verdict is go. Write to the sibling inbox: what xav is, what it would replace, the exact host toolchain it needs, the pinning problem, and the fact that its build disables standard hardening flags (`-fno-pie`, `-D_FORTIFY_SOURCE=0`, no stack protector, no unwind tables) — a deliberate choice by upstream that the sibling must consciously accept before shipping it in an image. **Do not edit sibling files; inbox message plus telling Emil is the only channel.**

- [ ] **Step 4: Commit, push, and report**

---

## Phase B — gated, requires hardware this VM does not have

**Do not start Phase B unless Phase A returns a go.** Recorded here so the requirements are known, not as scheduled work.

Requires: GPU passed through to this VM (for Vship — SSIMU2/Butteraugli, and CUDA specifically for CVVDP), and materially more RAM than 7 GB (4K chunks alone are ~7.5 GB per worker). Also requires sourcing a 4K HDR sample, which does not exist locally today.

Would test: per-scene target-quality convergence and its real cost (upstream claims 2.0–3.5× encode time), quality-per-bitrate versus ab-av1's VMAF-targeted search at matched output size, 4K HDR memory ceiling versus the current stack's OOM behaviour, and GPU-accelerated decode throughput.

Build command changes to `./build.sh static_tq mainline` (mode 1, clones and builds Vship).
