# tdarr-plugins

AV1 encoding FlowPlugins for [Tdarr](https://tdarr.io), powered by [xav](#av1-encode-xav), [av1an](https://github.com/master-of-zen/Av1an) and [ab-av1](https://github.com/alexheretic/ab-av1).

## Plugins

### AV1 Encode (xav)

Scene-based chunked AV1 encoding driven by a **SSIMULACRA2** target-quality search, rather
than VMAF. Each scene gets its own CRF search until the chunk hits the requested score, so
bitrate follows what the content actually needs. Live progress, FPS, ETA, current and
projected output size on the Tdarr dashboard; cancelling the job kills the encoder.

Two plugins share the engine:

- **AV1 Encode (xav)** — encodes at the source resolution.
- **AV1 Encode (xav, scaled)** — ffmpeg downscales and pipes Y4M into xav, for 4K → 1080p.
  xav has no resize option of its own, which is why this is a separate plugin.

**Inputs:**

| Setting | Default | Description |
|---------|---------|-------------|
| xav Binary Path | | Empty = search `/usr/local/bin/xav`, then `/opt/xav/xav`. See [Providing the xav binary](#providing-the-xav-binary) |
| Target Quality | 74.8-75.2 | SSIMULACRA2 band. Tier targets: top 74.8-75.2, mid 70.8-71.2, low 66.8-67.2 |
| TQ Aggregation Mode | mean | Aggregate chunk scores by mean, or by percentile to protect worst-case frames |
| CRF Range | 5-63 | Bounds for the per-scene search. Keep it wide — chunks pinned at a bound are a fixed-CRF encode in disguise, and the plugin warns when that happens |
| Preset | 6 | SVT-AV1 preset, 0-7 only in target-quality mode. 6 on every tier: preset 4 measured 0.9% smaller for ~25% more time |
| Workers | 2 | Parallel encoder instances. The primary memory driver — 4 workers on 1080p peaked ~20 GB |
| Metric Workers | 1 | Vship (SSIMULACRA2) workers. **Needs GPU access in the container** |
| Encoder Parameter Set | auto | `auto` picks by binary name: a mainline build gets the researched SVT set, an `hdr` build gets preset only because its own defaults are the recipe |
| Extra Encoder Params | | Appended after the set above and win over it. Params xav rejects are stripped and logged |
| Max Encoded Percent | 80 | Abort if the projected output exceeds this % of source; 100 disables the gate |

**Measured at the top tier** (target 75, preset 6, 2-minute samples): 63% of source on
grain-heavy 1080p film, 47% on clean 1080p, 16% on high-motion digital, and 16% on a 4K HDR
remux downscaled to 1080p.

Do not raise the target much above ~76. SSIMULACRA2 scores against the *source*, so a high
target pays to reproduce the source's own grain and compression artifacts, and the cost curve
turns steeply non-linear: one grain-heavy film needed 100.5% of its source at SSIMU2 80 to buy
1.44 VMAF points over SSIMU2 74.

### AV1 Encode (av1an)

Scene-based chunked AV1 encoding with VMAF-targeted quality. Supports aomenc and SVT-AV1 encoders. Live progress, FPS, and ETA on the Tdarr dashboard.

**Inputs:**

| Setting | Default | Description |
|---------|---------|-------------|
| Encoder | svt-av1 | `aom` (quality, slower) or `svt-av1` (speed, faster) |
| Target VMAF | 93 | VMAF score to target (0-100). Typically 90-96 |
| QP Range | 10-50 | Quality bounds for the CRF/QP search |
| Preset | 4 | aomenc: cpu-used 0-8 (lower=slower). SVT-AV1: preset 0-13 |
| Max Encoded Percent | 80 | Abort if output exceeds this % of source size. 100 to disable |
| Enable Downscale | false | Downscale input via VapourSynth Lanczos3 pre-filter |
| Downscale Resolution | 1080p | Target: 720p, 1080p, or 1440p |
| Thread Strategy | safe | Controls thread/worker budget (see [Performance Tuning](#performance-tuning)) |
| Thread Overrides | | JSON overrides for custom strategy (see [Custom Overrides](#custom-overrides)) |

### AV1 Encode (ab-av1)

Automatic VMAF-targeted CRF search using SVT-AV1. Simpler single-pass approach with ab-av1's built-in quality optimization.

**Inputs:**

| Setting | Default | Description |
|---------|---------|-------------|
| Target VMAF | 93 | VMAF score to target (0-100) |
| Min CRF | 10 | CRF floor for quality search |
| Max CRF | 50 | CRF ceiling for quality search |
| Preset | 4 | SVT-AV1 preset (0-13, lower=slower/better) |
| Max Encoded Percent | 80 | Abort if output exceeds this % of source size |
| Enable Downscale | false | Downscale via ab-av1 native vfilter |
| Downscale Resolution | 1080p | Target: 720p, 1080p, or 1440p |
| Thread Strategy | safe | Controls SVT-AV1 thread parallelism (see [Performance Tuning](#performance-tuning)) |
| Thread Overrides | | JSON overrides for custom strategy |

## Performance Tuning

The default `safe` strategy is conservative — on high-core-count systems you may see CPU utilization as low as 40%. The thread strategy system lets you push utilization higher for faster encodes.

### Thread Strategy Presets

| Strategy | Target CPU | Best for |
|----------|-----------|----------|
| `safe` | ~40% | Default. Safe on any hardware, minimal memory pressure |
| `balanced` | ~70% | Good middle ground for most systems |
| `aggressive` | ~90% | High-core-count systems with plenty of RAM |
| `max` | ~100% | Saturate all cores. Watch memory usage |

**What each preset controls (example for a 32-thread system):**

| Preset | av1an aomenc | av1an SVT-AV1 | ab-av1 lp | VMAF threads |
|--------|-------------|---------------|-----------|-------------|
| safe | 8 workers × 4 threads | 5 workers × 5 threads | 6 | 4 |
| balanced | 12 workers × 2 threads | 6 workers × 5 threads | 12 | 8 |
| aggressive | 16 workers × 2 threads | 6 workers × 5 threads | 20 | 10 |
| max | 20 workers × 1 thread | 8 workers × 4 threads | 28 | 16 |

### SVT-AV1 Thread Limits

SVT-AV1 has preset-dependent parallelization limits. Lower presets use algorithms with dependencies that prevent effective threading beyond a certain point:

| SVT-AV1 Preset | Effective max lp |
|-----------------|-----------------|
| 0-1 | ~4 threads |
| 2-3 | ~6 threads |
| 4 | ~8 threads |
| 5 | ~12 threads |
| 6 | ~16 threads |
| 7+ | 32+ threads |

The plugins automatically cap `lp` based on the encoder preset. This means **ab-av1 at preset 3 won't benefit from thread strategies beyond `safe`** — the encoder simply can't use the extra threads.

For maximum multicore utilization at low presets, use **av1an** instead — it runs multiple independent encoder instances in parallel via scene-based chunking, bypassing SVT-AV1's per-instance thread limits.

### Custom Overrides

Set **Thread Strategy** to `custom` and paste a JSON object into **Thread Overrides**:

```json
{"workers": 16, "threadsPerWorker": 2, "vmafThreads": 12}
```

Omitted keys fall back to the `aggressive` preset. For ab-av1, `workers` is ignored (single-process encoder) and `threadsPerWorker` sets the SVT-AV1 `lp` value.

### Finding Your Optimal Config

Use the benchmark tool to test different configurations against your actual hardware and content:

```bash
# Place sample files in test/samples/ (.mkv, .mp4, .ts)
# Then run:

npm run benchmark -- --help                          # see all options

# Test all 4 presets with aomenc at preset 3
npm run benchmark -- --encoder aom --cpu-used 3

# Test all presets with SVT-AV1 at preset 4
npm run benchmark -- --encoder svt-av1 --cpu-used 4

# Test ab-av1
npm run benchmark -- --encoder ab-av1 --cpu-used 3

# Test with downscaling
npm run benchmark -- --encoder aom --cpu-used 3 --downscale 720p

# Test only one preset
npm run benchmark -- --encoder aom --preset aggressive

# Custom worker × thread grid (power users)
npm run benchmark -- --encoder aom --grid
```

The benchmark runs encodes inside the Tdarr node Docker container via `docker exec`. Each config runs for a fixed duration (default 2 minutes, configurable with `--duration`), then measures total encoded bytes. More MiB/min = better multicore utilization. Scene detection runs once upfront and is cached for all configs so it doesn't skew the results.

**Environment variables:**

- `TDARR_CONTAINER` — container name (default: `tdarr-node`)

**Output example:**

```
+------------+---------+---------+--------+---------+-----------+--------+-------+----------+--------+
| Config     | Workers | Threads | VMAF-T | MiB/min | Total MiB | Chunks | CPU % | Peak RAM | Status |
+------------+---------+---------+--------+---------+-----------+--------+-------+----------+--------+
| safe       | 8       | 4       | 4      | 12.3    | 24.6      | 8      | 42%   | 6.1 GiB  | OK     |
| balanced   | 12      | 2       | 8      | 22.1    | 44.2      | 14     | 71%   | 8.4 GiB  | OK     |
| aggressive | 16      | 2       | 12     | 28.5    | 57.0      | 19     | 88%   | 11.2 GiB | OK     |
| max        | 20      | 1       | 16     | 30.2    | 60.4      | 21     | 96%   | 14.2 GiB | OK     |
+------------+---------+---------+--------+---------+-----------+--------+-------+----------+--------+

Recommended: aggressive
Set Thread Strategy to "aggressive" in the plugin settings.
```

If a named preset wins, just select it from the **Thread Strategy** dropdown. The `custom` + JSON override route is only needed for grid mode results that don't map to a preset.

## Providing the xav binary

Unlike the av1an and ab-av1 plugins, the xav plugins do **not** require a purpose-built image.
xav is a single self-contained binary, so it can be mounted into the
[empaa/tdarr-av1](https://github.com/empaa/tdarr-av1) image **or into an upstream
`ghcr.io/haveagitgat/tdarr` image** — the plugin only needs the executable to exist.

Point the plugin at it in one of two ways:

- **Mount it where the plugin looks.** With no `xav Binary Path` set, the plugin searches
  `/usr/local/bin/xav` and then `/opt/xav/xav`.
- **Mount it anywhere and set `xav Binary Path`** to the in-container path. This is how you
  run several builds side by side.

```yaml
# docker-compose, upstream Tdarr node image
services:
  tdarr-node:
    image: ghcr.io/haveagitgat/tdarr_node:latest
    runtime: nvidia                     # required: Vship scores on the GPU
    environment:
      - NVIDIA_DRIVER_CAPABILITIES=all
    security_opt:
      - seccomp=unconfined              # xav muxes via io_uring
    mem_limit: 30g                      # xav is memory-hungry; see Workers
    volumes:
      - /host/xav/xav-mainline:/usr/local/bin/xav:ro
```

Running more than one build is just more mounts — keep them in a directory and select per
flow node with `xav Binary Path`:

```yaml
      - /host/xav:/opt/xav:ro           # xav-mainline, xav-hdr, ...
```

Then set `xav Binary Path` to `/opt/xav/xav-mainline` or `/opt/xav/xav-hdr` on each node.
With `Encoder Parameter Set` on `auto` the plugin picks the parameters to match: a build whose
filename contains `hdr` gets preset only, because that fork's own defaults are the recipe;
anything else gets the researched mainline set.

### Requirements and gotchas

- **GPU access is required** for the SSIMULACRA2 metric (Vship). Without it the
  target-quality search cannot score chunks.
- **`seccomp=unconfined`** — without it the encode succeeds and the *mux* fails with
  `io_uring_setup failed`.
- **Cap container memory.** xav at 4 workers on 1080p peaked around 20 GB; uncapped it can
  drive the host into OOM. Start at 2 workers.
- **The plugin fails fast with a clear error** if no binary is found, rather than silently
  falling back — the stock Tdarr images do not ship xav.

## Install

1. Download the latest release zip from the [Releases](https://github.com/empaa/tdarr-plugins/releases) page.
2. Extract into your Tdarr server config directory under `Plugins/FlowPlugins/`:
   ```
   <tdarr-config>/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/
   ```
3. Restart the Tdarr server. Nodes auto-sync plugins from the server.

### Which plugins run where

The **xav** plugins need only the xav binary plus GPU access — see
[Providing the xav binary](#providing-the-xav-binary). They call `ffmpeg`, `ffprobe`,
`mkvmerge` and `script`, all of which upstream ships, and fall back from `/usr/local/bin` to
`/usr/bin`. **They run on a stock `ghcr.io/haveagitgat/tdarr_node` image with a single bind
mount.**

The **av1an, ab-av1 and crf-search** plugins need the full encoding stack (av1an, ab-av1,
VapourSynth/`vspipe`, the libvmaf model). **Upstream images do not ship any of it.** That
stack came from [empaa/tdarr-av1](https://github.com/empaa/tdarr-av1), which was **deprecated
2026-08-14** — encoding moved to xav on official images, so the custom image no longer earns
its keep. Its published images stay on GHCR indefinitely and are frozen as they are, so these
plugins keep working there, but they will not run on an upstream image.

## Development

```bash
npm install
npm run build          # Bundle plugins to dist/
npm run deploy         # Build + copy to local tdarr-av1 test instance
npm run test:smoke     # Validate plugin metadata
npm run test:e2e       # Full integration tests (needs running Tdarr)
npm run benchmark      # Thread/worker performance benchmark
```

Requires [Node.js](https://nodejs.org/) 18+.
