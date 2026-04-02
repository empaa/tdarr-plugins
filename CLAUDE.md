# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is this?

AV1 encoding FlowPlugins for Tdarr, bundled with esbuild into self-contained single-file plugins.

- **av1anEncode** — scene-based chunked AV1 encoding via av1an (aomenc or SVT-AV1)
- **abAv1Encode** — automatic VMAF-targeted CRF search via ab-av1 (SVT-AV1)

Shared modules in `src/shared/` are inlined by esbuild at build time. Each plugin in `dist/` is a single `index.js` with no external dependencies beyond Node builtins.

## Build

```bash
npm install          # once
npm run build        # bundle plugins to dist/
npm run deploy       # build + copy to tdarr-av1 test instance
```

## Project structure

- `src/shared/` — shared modules (logger, processManager, encoderFlags, downscale, audioMerge, progressTracker)
- `src/<pluginName>/index.js` — plugin source, imports from `../shared/`
- `dist/LocalFlowPlugins/<pluginName>/1.0.0/index.js` — bundled output (gitignored)
- `build.sh` — esbuild bundler, `--deploy` copies to test instance
- `.github/workflows/release.yml` — builds + creates GitHub Release on push to main

## Runtime binary dependencies

These binaries must exist on the Tdarr node at runtime (provided by the sibling `tdarr-av1` Docker images):

- `/usr/local/bin/av1an`
- `/usr/local/bin/ab-av1`
- `/usr/local/bin/ffmpeg`
- `/usr/local/bin/mkvmerge`
- `/usr/local/bin/vspipe`
- `/usr/local/share/vmaf/vmaf_v0.6.1.json`

## Memory

User feedback and preferences are tracked in the memory system and should inform all suggestions. Check memory at the start of sessions.

## Sibling Protocol

This repo is part of a two-repo project. The sibling repo is at `../tdarr-av1` (Docker images with the AV1 encoding stack).

### Inbox

Agent-to-agent async messages between repos. Check your inbox at session start.

- Own inbox: `~/.claude/projects/-Users-emilgrunden-ClaudeProjects-tdarr-plugins/inbox/`
- Sibling inbox: `~/.claude/projects/-Users-emilgrunden-ClaudeProjects-tdarr-av1/inbox/`

Message format (one file per message, `YYYY-MM-DD-from-<repo>-<slug>.md`):

    ---
    from: <repo-name>
    date: YYYY-MM-DD
    ---

    <precise description of what changed and what it affects>

Lifecycle:
1. Session start: read own inbox, summarize to user, clear after acknowledgment
2. Session end: if work affects sibling, write message to sibling inbox
3. User can also say "tell <sibling> that..." to write manually

### When to Message

- Binary path or version changes
- Deploy path or config structure changes
- Breaking changes affecting sibling
- New dependencies or removed features

### Deploy integration

`build.sh --deploy` copies bundled plugins to the sibling's test instance at:
`../tdarr-av1/test/tdarr_config/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/`
