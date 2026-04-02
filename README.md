# tdarr-plugins

AV1 encoding FlowPlugins for [Tdarr](https://tdarr.io), powered by [av1an](https://github.com/master-of-zen/Av1an) and [ab-av1](https://github.com/alexheretic/ab-av1).

## Plugins

- **AV1 Encode (av1an)** — Scene-based chunked AV1 encoding with VMAF-targeted quality. Supports aomenc and SVT-AV1 encoders. Live progress, FPS, and ETA on the Tdarr dashboard.
- **AV1 Encode (ab-av1)** — Automatic VMAF-targeted CRF search using SVT-AV1. Simpler single-pass approach with ab-av1's built-in quality optimization.

Both plugins require the AV1 encoding stack (av1an, ab-av1, FFmpeg, VapourSynth, SVT-AV1, aomenc, libvmaf) to be installed on the Tdarr node. The [empaa/tdarr_node](https://github.com/empaa/tdarr-av1) Docker image provides this stack.

## Install

1. Download the latest release zip from the [Releases](https://github.com/empaa/tdarr-plugins/releases) page.
2. Extract into your Tdarr server config directory under `Plugins/FlowPlugins/`:
   ```
   <tdarr-config>/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/
   ```
3. Restart the Tdarr server. Nodes auto-sync plugins from the server.

## Development

```bash
npm install
npm run build          # Bundle plugins to dist/
npm run deploy         # Build + copy to local tdarr-av1 test instance
```

Requires [Node.js](https://nodejs.org/) 18+.
