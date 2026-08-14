# tdarr-xav

AV1 encoding FlowPlugins for [Tdarr](https://tdarr.io), built on
**[xav](https://github.com/emrakyz/xav) by [emrakyz](https://github.com/emrakyz)** — a
scene-chunked AV1 encoder with a built-in SSIMULACRA2 target-quality search. These plugins are
a Tdarr integration around xav; the encoder, its chunking, its metric search and the hard parts
are emrakyz's work.

## Plugins

### AV1 Encode (xav)

> **Upstream:** [emrakyz/xav](https://github.com/emrakyz/xav). The binaries in production were
> built from `6896aeb`. This repo contains no encoder code — see
> [`tools/xav-build/`](tools/xav-build/) for the build container.

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

### Sanitize File

All-in-one pre-encode sanitizer, in a single ffmpeg call. It determines the original language
via Radarr/Sonarr (falling back to the first audio track), keeps the best audio track per
wanted language, filters subtitles, strips image streams (cover art and thumbnails), reorders
streams and remuxes to MKV. "Best" is decided by channel count, with codec quality
(TrueHD → DTS-HD MA → FLAC → DTS → E-AC3 → AC3 → AAC) breaking ties.

Run it before an encode node so the encoder only ever sees the tracks you intend to keep.

**Inputs:**

| Setting | Default | Description |
|---------|---------|-------------|
| Radarr URL | | e.g. `http://radarr:7878`. Empty skips Radarr |
| Radarr API Key | | Required if Radarr URL is set |
| Sonarr URL | | e.g. `http://sonarr:8989`. Empty skips Sonarr |
| Sonarr API Key | | Required if Sonarr URL is set |
| Path Mappings | | JSON array of `"tdarrPath:arrPath"` pairs, e.g. `["/media:/mnt/media"]`. Empty if the paths already match |
| Additional Audio Languages | | Comma-separated ISO 639-2 codes to keep beyond the original, e.g. `eng,swe`. The original language is always kept |
| Subtitle Languages | | Comma-separated ISO 639-2 codes. Original-language subtitles are always kept |
| Keep Commentary Tracks | false | Commentary is detected by the comment disposition or a "commentary" title; SDH and forced tracks are not commentary. When off, commentaries are dropped even if they are the only track in a wanted language |

**Outputs:** `1` sanitized (streams filtered, reordered, remuxed to MKV) · `2` already clean.

### Arr Rename

Triggers Radarr/Sonarr to rename a file according to their naming scheme. Place it after the
Replace Original node — it detects which service owns the file by querying both APIs.

**Inputs:**

| Setting | Default | Description |
|---------|---------|-------------|
| Radarr URL | | e.g. `http://radarr:7878`. Empty skips Radarr |
| Radarr API Key | | Required if Radarr URL is set |
| Sonarr URL | | e.g. `http://sonarr:8989`. Empty skips Sonarr |
| Sonarr API Key | | Required if Sonarr URL is set |
| Path Mappings | | JSON array of `"tdarrPath:arrPath"` pairs, e.g. `["/media:/mnt/media"]` |
| Poll Timeout (s) | 120 | Max seconds to wait for the Arr rescan/rename commands to finish |

**Outputs:** `1` renamed by Radarr or Sonarr · `2` no match found, or no rename needed.

## Removed in v3.0.0

`av1anEncode`, `abAv1Encode` and `crfSearchEncode` were removed in v3.0.0, along with the
thread-strategy tuning chapter and benchmark harness that existed to serve them.

They needed av1an, ab-av1, VapourSynth/`vspipe` and the libvmaf model — a stack that only ever
came from [empaa/tdarr-av1](https://github.com/empaa/tdarr-av1), which was deprecated and
archived on 2026-08-14. Upstream Tdarr images ship none of it, so those plugins cannot run on
the images production now uses.

The last commit containing them is tagged
[`legacy-encoders-final`](https://github.com/empaa/tdarr-xav/tree/legacy-encoders-final):

```bash
git checkout legacy-encoders-final -- src/av1anEncode src/abAv1Encode src/crfSearchEncode
```

They still run against the frozen `ghcr.io/empaa/tdarr_node` images, which stay published on
GHCR indefinitely.

## Providing the xav binary

The xav plugins do **not** require a purpose-built image. xav is a single self-contained
binary, so it can be mounted into a stock upstream `ghcr.io/haveagitgat/tdarr` image — the
plugin only needs the executable to exist.

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

1. Download the latest release zip from the [Releases](https://github.com/empaa/tdarr-xav/releases) page.
2. Extract into your Tdarr server config directory under `Plugins/FlowPlugins/`:
   ```
   <tdarr-config>/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/
   ```
3. Restart the Tdarr server. Nodes auto-sync plugins from the server.

### Requirements

**All four plugins run on stock upstream `ghcr.io/haveagitgat/tdarr` images.** They call only
`ffmpeg`, `ffprobe`, `mkvmerge` and `script`, all of which upstream ships, and fall back from
`/usr/local/bin` to `/usr/bin` to cover either layout.

The two xav plugins additionally need the xav binary mounted and GPU access for the
SSIMULACRA2 metric — see [Providing the xav binary](#providing-the-xav-binary). No custom
image is required for any of them.

## Development

```bash
npm install
npm run build          # Bundle plugins to dist/
npm run deploy         # Build + copy to local test instance
npm run test:unit      # Pure-logic tests, no Tdarr needed
npm run test:smoke     # Validate plugin metadata (needs running Tdarr)
npm run test:e2e       # Full integration tests (needs running Tdarr)
```

Requires [Node.js](https://nodejs.org/) 18+.
