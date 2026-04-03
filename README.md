# tdarr-plugins

AV1 encoding FlowPlugins for [Tdarr](https://tdarr.io), powered by [av1an](https://github.com/master-of-zen/Av1an) and [ab-av1](https://github.com/alexheretic/ab-av1).

## Plugins

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

## Install

1. Download the latest release zip from the [Releases](https://github.com/empaa/tdarr-plugins/releases) page.
2. Extract into your Tdarr server config directory under `Plugins/FlowPlugins/`:
   ```
   <tdarr-config>/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/
   ```
3. Restart the Tdarr server. Nodes auto-sync plugins from the server.

Both plugins require the AV1 encoding stack (av1an, ab-av1, FFmpeg, VapourSynth, SVT-AV1, aomenc, libvmaf) on the Tdarr node. The [empaa/tdarr_node](https://github.com/empaa/tdarr-av1) Docker image provides this stack.

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
