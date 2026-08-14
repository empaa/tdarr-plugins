# xavEncode — Design

Status: approved design, not yet implemented.
Supersedes nothing. Companion to `docs/xav-bakeoff-results.md` (evidence) and
`hometower/docs/xav-avatar-bakeoff-results.md` (measurements).

## Why

The Avatar bake-off settled what xav is actually good at. At matched quality
(SSIMULACRA2 72.45, means 0.009 apart) xav and our av1an SVT tier are within ~5%
on size — but xav's distribution is far tighter: σ 2.18 vs 9.03, worst frame
64.35 vs 46.44. Against the AOM tier xav reaches the same quality in 3.3% fewer
bytes and **4.7x less time**.

So this is not an efficiency decision, it is a **consistency** decision, plus
speed against the top tier.

Second driver: xav needs one mounted binary and nothing else. Everything it
depends on already exists in stock `ghcr.io/haveagitgat/tdarr_node` — verified
directly:

| | stock 2.86.01 |
|---|---|
| Ubuntu 24.04.4, glibc 2.39 | clears xav's GLIBC_2.38 requirement |
| `/usr/bin/script` | the PTY wrapper xav mandates |
| `/usr/bin/mkvmerge` | sanitizeFile + audioMerge |
| `/usr/local/bin/ffmpeg` | 7.1.4-Jellyfin, **no libvmaf** |
| `vspipe` | **absent** — no VapourSynth |

HomeTower's `run-tq-sweep.sh` defaults to `IMG=ghcr.io/haveagitgat/tdarr:2.86.01`,
so every xav number in the bake-off was already produced inside the stock image.
Mounting onto upstream is demonstrated, not hypothetical.

## Scope

Build `xavEncode`. **Keep the custom images and the existing plugins** until
xavEncode is confirmed in production. Design so that swapping to stock upstream
later is a Docker template change, not a code change.

Out of scope: retiring `av1anEncode` / `abAv1Encode` / `crfSearchEncode`,
retiring the sibling image, the encoder-settings research run, and the
production VMAF-target overshoot (tracked separately — we ask for 95 and deliver
99.957, because VMAF is saturated at our operating point).

## Portability contract

xavEncode may depend only on `script`, `mkvmerge`, `ffmpeg`, `ffprobe`, and a
mounted `xav`. It must not reference VapourSynth, av1an, ab-av1, or libvmaf.
Binary discovery: `findBin('xav', inputs.xav_path, '/usr/local/bin/xav',
'/opt/xav/xav')`.

This contract is the deliverable. If it holds, the image swap is free.

## xav's flag surface

From `src/guide.txt` upstream:

`-e --encoder` · `-w --worker` · `-b --buff` · `-p --param` · `-s --sc` ·
`--sc-only` · `--hwdec` · `-r --range` · `-a --audio` · `-t --tq` ·
`-m --mode` · `-f --qp` · `-v --vship` · `-d --display` · `-P --alt-param`

Three consequences:

1. **There is no resize option.** xav works at native resolution after autocrop.
   Any downscale must happen before xav sees the frames. See "Downscale path".
2. **The temp dir is not configurable** — xav hashes the input and creates
   `.<hash>` *next to the input file*, always. This is why sanitizeFile must
   stage (below).
3. **`-m --mode` sets TQ aggregation to `mean` or `pN%`.** Since the measured
   advantage is worst-frame consistency, a percentile target aims at it
   directly. Exposed as a plugin input.

No `-a` is passed, so xav stays video-only; audio and subtitles are merged back
from the staged file afterwards, as today.

**An av1an parameter string cannot be handed to xav unfiltered.** xav validates
encoder params itself (`src/svterr.rs`) and aborts with "argument parsing failed"
before encoding anything. Six of our production flags are hard-rejected —
`--input-depth`, `--lookahead`, `--keyint`, `--irefresh-type`,
`--enable-overlays`, `--scm` — which is how the first parameter sweep died on
all 40 runs in 20 seconds. `filterEncoderParams` strips these plus `--crf`,
`--rc` and `--scd` (owned by target quality and xav's own scene detection), and
logs every drop with its reason.

## Plugin inputs

| input | default | notes |
|---|---|---|
| `xav_path` | `''` | overrides binary discovery |
| `target_quality` | `85` | SSIMULACRA2; passed as `-t` |
| `tq_mode` | `mean` | `mean` or `pN%` — `-m` |
| `crf_range` | `10-40` | `-f`; must not pin (see validation) |
| `preset` | `4` | via `-p --preset`; TQ allows 0-7 only |
| `workers` | `4` | `-w` — primary memory driver |
| `buffer` | `2` | `-b` — secondary memory driver |
| `resolution` | `1080p` | `xavPipeEncode` only — scale target |
| `max_encoded_percent` | `100` | size gate; 100 disables |
| `hwdec` | `false` | `--hwdec` |

## Two plugins, gated in the flow

The two execution paths ship as **two separate plugins**, not as a runtime
branch inside one:

- **`xavEncode`** — native path, PTY via `script`. The default for anything
  already at target resolution.
- **`xavPipeEncode`** — pipe path, ffmpeg scale into xav's stdin. Used only when
  downscaling.

The gate lives in the **Tdarr flow**, not in plugin code: the flow author routes
on resolution (Tdarr's own resolution check plugin) and sends 4K to
`xavPipeEncode` and everything else to `xavEncode`.

Why split rather than branch: the paths are mutually exclusive at the process
level — `script` gives the child a PTY on **stdin**, which is precisely what
`is_pipe()` tests — so a single plugin would carry two spawn shapes, two
progress-parsing regimes, and a quality mode that is guaranteed on one path and
contingent on the other. Splitting keeps each plugin's contract honest and makes
the routing decision visible in the flow where it can be seen and changed.

Shared logic (argv construction, progress tracking, validation, size gate) lives
in `src/shared/xav.js` so the two plugins cannot drift.

### Native path — `xavEncode`

The plugin writes `xav-run.sh` into `workDir` holding the full argv, then spawns:

    script -qec <workDir>/xav-run.sh /dev/null

with `TERM=xterm-256color` and `cwd = workDir`. The generated script means
filenames like `Movie (2009) [Remux-1080p][TrueHD Atmos 7.1].mkv` never traverse
a shell-quoting layer.

Keeps xav's native decode (~227 fps), autocrop, scene detection, TQ search and
resume — everything the bake-off measured.

**Without a TTY xav does not fail loudly.** `src/y4m.rs` defines
`is_pipe() == !stdin().is_terminal()`, with no flag or env override. Given no
TTY it assumes piped Y4M, reads nothing, writes an ~870-byte file, prints
`DONE 100.00%` and exits 0. `/dev/null` and closed stdin fail identically.

### Pipe path — `xavPipeEncode`

ffmpeg applies the scale filter and feeds Y4M to xav's stdin. No intermediate
file, and no PTY needed — `is_pipe()` becomes true naturally. This plugin never
uses `script`.

Both open questions were answered from xav's source by hometower, 2026-08-12:

- **`-t` does work on piped input.** `enc_all()` hands `pipe_reader` straight to
  `enc_tq()` → `spawn_tq_dec()` with no pipe-specific branch. It does not need
  random access because the decoder pushes each chunk as a fully-decoded
  in-memory `WorkPkg` and probes re-encode *that buffer*. The no-score check
  below stays as a guard in case this changes upstream.
- **The TUI does render to a non-PTY stdout** — there is no `is_terminal` gate on
  stdout anywhere. Progress parsing is identical on both paths.

Three constraints this path inherits:

1. **The source file is still required as `<INPUT>`.** xav reads scene
   detection, crop detection and the frame count from the file; only the frames
   themselves arrive on stdin. Omitting it leaves xav with no scene list.
   Geometry is taken from the Y4M header, with the detected crop rescaled.
2. **`--hwdec` combined with a pipe is a hard error**, so this plugin never
   offers it.
3. **Piped jobs are not resumable.** Pipe resume is vspipe-only upstream — it
   appends `-s N` to the producer's argv, which is meaningless for ffmpeg. A
   restarted job re-encodes from zero.

Scale filter mirrors the existing `downscale.js` presets:
`scale=<w>:-2:flags=lanczos`.

## Dashboard reporting

`createXavTracker` in `src/shared/progressTracker.js`, fed line-by-line from the
child's stdout. Strip CSI escapes, split on `\r` and `\n`.

xav's real output, captured from bake-off logs:

    00:00 CROP: [####----------------] 7%, 1 FPS, -00:00, 1/13
    00:00 SCD:  [######--------------] 31%, 912 FPS, -00:00, 912/2899
    00:03 [22/25] [###############-----] 79% 2316/2899 (12.59, -00:00, 57527k, 869.5m)
    00:00 MUX:  [####################] 100%, 2899 FPS, -00:00, 2899/2899

The encode master line carries chunks done/total, percent, frames done/total,
FPS, ETA, kb/s and MB written — every dashboard field in one line, no file
polling (unlike the av1an tracker, which parses `scenes.json` + `done.json`).

A per-worker line exposes each chunk's chosen CRF:

    [0000 / F 27.50 /      ] [####################] 100%, 141.56,  56/ 56

Pushed via `updateWorker`, matching the existing trackers' field set:
`percentage`, `fps`, `ETA`, `outputFileSizeInGbytes`,
`estimatedFinalFileSizeInGbytes` / `estimatedFinalSize` / `estSize`.
`status` follows the phase: `Detecting crop` → `Scene detection` → `Encoding`
→ `Muxing`.

Two deliberate deviations from xav's own numbers:

- **ETA is computed locally** from remaining frames ÷ smoothed FPS. xav's ETA is
  HH:MM granular and reads `-00:00` under a minute.
- **Estimated final size = projected video + measured non-video bytes.** Because
  sanitizeFile always stages, the audio and subtitle streams merged back are
  exactly those in the staged file, so `probeNonVideoSize` sums them once up
  front and adds an exact constant rather than an estimate.

## Size gate

Same contract as today: if the projected output exceeds `maxEncodedPercent` of
the source, kill the encode and pass through.

One correction forced by the data: **xav's size curve is front-loaded.** At 79%
of frames the output was already 97% of its final size, because TQ spends
unevenly across chunks. A naive projection therefore reads high early and would
abort good encodes. The gate requires **both** frames ≥ 30% **and** a projection
that is stable or falling across consecutive samples before it fires.

## Validation gate

The failure mode is silent success, so this is the part that must not be sloppy.
After exit, assert:

- output exists and is larger than **1 MB** (the no-TTY artefact is ~870 bytes)
- `ffprobe` reports non-zero width/height and codec `av1`
- frame count is **within 1 frame** of the source
- duration is **within 0.5 s** of the source

Dimensions are deliberately *not* compared to the source: xav autocrops, so
1920x1080 legitimately becomes e.g. 1920x1040. Only the frame count and duration
are source-relative.

Any failure **throws**, so Tdarr's own handler runs and the original is never
discarded. No error output port.

The ~870-byte no-TTY signature is detected and named explicitly in the error
rather than surfacing as a generic size failure.

Separately, the per-worker CRF lines are parsed and a loud warning logged if
every chunk landed on the `-f` floor or ceiling — the "fixed-CRF encode wearing
a target-quality costume" trap that made xav's own defaults look like an 8x win.
This is a warning, not a failure: the encode is valid, it just did not do what
was asked.

## Cancellation

`processManager` already does detached process-group kills with SIGTERM→SIGKILL
escalation, watches for IPC disconnect, and spawns a detached reaper that kills
the encoder group if the worker dies. With `script` in the middle the group
leader is `script` and xav is its child, so `process.kill(-pid)` reaches both.

Only addition: the tracker's poll returns `cancelled` on IPC disconnect, as the
av1an tracker does.

No temp-dir cleanup is needed. xav's `.<hash>` dir is created next to its input,
which is inside `workDir`, and Tdarr cleans workDir itself.

## sanitizeFile staging change

`src/sanitizeFile/index.js:357` currently returns `args.inputFileObj` unchanged
on the "already clean" path, leaving the working file on the media share. Since
xav's temp dir is hard-wired next to its input, that would scatter hashed temp
dirs across the library — and fail outright on a read-only share (`os error 30`).

The already-clean path now stages to workDir: `fs.linkSync` when source and
workDir share a device, `fs.copyFileSync` otherwise. Both output ports keep
their current meaning so saved flows do not break.

This establishes an invariant everything downstream can rely on: **after
sanitizeFile, the working file is always in workDir.**

Cost: an already-clean remux now pays a copy whenever workDir is on a different
filesystem from the media share, which it usually is. Accepted deliberately —
it is the only lever available given xav's fixed temp-dir behaviour.

## Testing

- **Parser unit tests against golden fixtures.** Six real `.xavlog` captures
  exist from the bake-off (1080p, 4 workers, TQ), so the progress parser is
  tested against genuine xav output with no binary and no GPU.
- **Plugin functest** with stubbed binaries, using the established keep-alive
  pattern (bare-node functests need a keep-alive timer because `spawnAsync`
  `unref()`s children).
- **Shared-module unit tests** — argv construction for both plugins, scale
  filter derivation, validation thresholds, size-gate convergence rule.

## Blocked on others

- ~~io_uring must be permitted on the node container.~~ **Resolved 2026-08-13 —
  this was never a production blocker.** `tdarr_node_hometower` runs
  `privileged: true`, which disables seccomp confinement entirely
  (`Seccomp: 0, Seccomp_filters: 0`), so `io_uring_setup` already succeeds
  there. Measured with controls by hometower: default profile → `errno 1`
  (exactly our symptom), `seccomp=unconfined` → OK, production node → OK.

  Our original observation came from **ad-hoc `docker run` one-shots**, which are
  un-privileged and do get the default profile. The fix is one flag in *test*
  invocations, not a change to the stack:

      docker run --rm --security-opt seccomp=unconfined --entrypoint <cmd> ...

  **Forward-looking risk worth knowing:** the plugin's io_uring dependency is
  satisfied only by that `privileged: true` flag, which is carried over from the
  retired ryzen node and exists for `/dev/dri`, not for us. If anyone ever
  tidies it away, xav encodes will start muxing-failing with `errno 1` and
  nothing will point at the cause. If that happens, the container needs
  `seccomp=unconfined` or a profile allowing
  `io_uring_setup` / `_enter` / `_register`.
- **GPU access in the node container** for Vship, which TQ depends on.
- **Which build to mount** — `hdr` and `mainline` both exist at
  `/mnt/cache_nvme_two/xav-{hdr,mainline}`. Measured at matched quality: hdr
  needs 14.6% fewer bytes (CRF 23.83 vs 18.63) with a better worst case, for 85%
  more encode time.

## Operational constraints

- **One xav job at a time.** At `-w 4 -v 2` on 1080p it peaked ~19.8 GB, steady
  state 23.2 GB, and uncapped it drove the host into global OOM — the kernel
  killed the VM's qemu process. Footprint scales with workers × buffered chunks
  × frame size, not with the CRF range.
- **TQ restricts preset to 0-7**; 8+ is rejected.
- **No aomenc.** Adopting xav for a tier commits that tier to SVT-AV1.
