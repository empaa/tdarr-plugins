# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is this?

Tdarr FlowPlugins built around **[xav](https://github.com/emrakyz/xav) by emrakyz**, bundled with esbuild into self-contained single-file plugins. This repo contains no encoder code.

The GitHub repo and npm package are named **`tdarr-xav`**; the local directory is still `tdarr-plugins` and must stay that way — Claude's memory, inbox and agent-runs are keyed to that path, as is the MemPalace wing.

Three plugins ship:

- **xavEncode** — scene-chunked AV1 via xav, per-scene SSIMULACRA2 target-quality search. Picks its own pipeline per file: above `Max Resolution` ffmpeg scales and pipes Y4M in (xav has no resize of its own), at or below it xav decodes natively under a PTY
- **sanitizeFile** — pre-encode track filter/reorder/remux to MKV, original language via Radarr/Sonarr
- **arrRename** — triggers Radarr/Sonarr to rename after Replace Original

Shared modules in `src/shared/` are inlined by esbuild at build time. Each plugin in `dist/` is a single `index.js` with no external dependencies beyond Node builtins.

**Staging belongs to xavEncode, not sanitizeFile.** xav creates a `.<hash>` temp dir next to its input with no way to relocate it, so the working file must be inside `workDir` before it runs. `src/shared/staging.js` hardlinks-or-copies it there on both encode paths; sanitizeFile hands an already-clean file on untouched. Note the hardlink is *attempted, never assumed*: on Unraid `shfs` two paths report the same `st_dev` and `link()` still fails `EXDEV` (observed 2026-08-14), so the copy fallback is load-bearing, not defensive.

**Retired in v4.0.0 (2026-08-14):** `xavPipeEncode`, merged into `xavEncode` behind the `Max Resolution` input. Choosing between them was one comparison against a width `ffProbeData` already carries, so it never needed to be a flow-authoring decision. Both spawn strategies survive unchanged inside `runNative()` / `runPiped()`.

**Retired in v3.0.0 (2026-08-14):** `av1anEncode`, `abAv1Encode`, `crfSearchEncode` and the five shared modules only they used (`downscale`, `encoderFlags`, `mezzanine`, `progressTracker`, `vsSource`). They needed a stack upstream images do not ship. Last commit containing them: tag **`legacy-encoders-final`**; a self-contained copy was adopted into `../tdarr-av1` under `legacy-tdarr-plugins/`. Do not re-add them without a reason that survives that fact.

## Build

```bash
npm install          # once
npm run build        # bundle plugins to dist/
npm run deploy       # build + copy to local test instance
```

## Project structure

- `src/shared/` — shared modules (xav, logger, processManager, audioMerge, arrApi, pathMapper)
- `src/<pluginName>/index.js` — plugin source, imports from `../shared/`
- `dist/LocalFlowPlugins/<pluginName>/1.0.0/index.js` — bundled output (gitignored)
- `build.sh` — esbuild bundler; discovers plugins by iterating `src/*/`, so adding or deleting a plugin directory needs no build change. `--deploy` copies to the test instance
- `.github/workflows/release.yml` — builds + creates GitHub Release on push to main

## Runtime binary dependencies

All three plugins run on **stock upstream `ghcr.io/haveagitgat` images**. They call only:

- `/usr/local/bin/ffmpeg`, `/usr/local/bin/ffprobe`
- `/usr/bin/mkvmerge` (mkvtoolnix apt package; `/usr/local/bin/mkvmerge` does not exist — plugins' `findBin` checks both)
- `/usr/bin/script`

The xav plugins additionally need the **xav binary mounted** (searched at `/usr/local/bin/xav`, then `/opt/xav/xav`, or set `xav Binary Path`), **GPU access** for the Vship SSIMULACRA2 metric, and `seccomp=unconfined` — without it the encode succeeds and the mux fails with `io_uring_setup failed`.

## Testing

`npm run test:unit` is the only stage that runs without a live Tdarr (44 tests, pure logic). Smoke and e2e need a server; see the Sibling Protocol note below for why the local one may not exist. **There is no automated coverage of a real xav encode** — xav is verified by live production runs, because a real harness needs the GPU host. Known gap, deliberately deferred.

## Environment

This repo lives on a Linux VM (`10.0.0.76`) that is itself a guest on the Unraid server which also hosts production Tdarr. **Tdarr is not local here:** its API base is `http://10.0.0.3:8265/api/v2`, and the production containers (`tdarr_node_hometower`, `tdarr_server`) run on the Unraid host — no `docker exec` from this VM, so read job logs over the HTTP API or ask the user. `localhost:8265` is valid only while a local `build.sh --interactive` test server is running on the sibling `../tdarr-av1`. For Unraid-host operations the user uses the sibling project `../hometower`.

## Memory

User feedback and preferences are tracked in the memory system and should inform all suggestions. Check memory at the start of sessions.

## Headless runs (claude -p)

When invoked non-interactively (an agentic `claude -p` call), keep ONE run record at
`~/.claude/projects/-mnt-vm-data-ClaudeProjects-tdarr-plugins/agent-runs/YYYY-MM-DD-HHMM-<slug>.md`.
**Write it FIRST** — before doing any work, create the file with the task line and
`status: started`; update it as significant actions complete and finalize it before finishing.
A killed or wedged run then still leaves a trail (2026-08-11: two headless runs died leaving
nothing — an end-of-run-only record cannot survive a kill). Contents:

- task received (one line)
- actions taken — files changed, commits/pushes, deploys, host/container commands that mutated state
- outcomes with the evidence (test results, verification output)
- loose ends the next session must pick up

Keep it under ~20 lines — a handoff note, not a transcript. If the run failed or was interrupted,
write the record anyway with what was attempted; a missing record after a mutating run is worse
than a failed run. This complements (does not replace) the mempalace diary when that tool is
available.

Interactive sessions: at session start, alongside the inbox, glance at `agent-runs/` for files
newer than your last session and fold anything relevant into your picture of current state.

## Sibling Protocol

The sibling repo at `../tdarr-av1` (Docker images with the AV1 encoding stack) was **deprecated and archived on 2026-08-14** — production moved to upstream Tdarr images, so the custom image no longer earns its keep. Its GHCR images stay published indefinitely, frozen.

**What that means in practice:** the sibling is dormant, not deleted. Its agent may still be reachable via the inbox, but expect no component bumps, no image rebuilds, and no binary-contract changes to react to. Archived GitHub repos are read-only — landing anything there needs a manual unarchive/re-archive by Emil. Everything below still applies if the sibling is ever revived; the local checkout remains for its test instance and history.

### Inbox

Agent-to-agent async messages between repos. Check your inbox at session start.

- Own inbox: `~/.claude/projects/-mnt-vm-data-ClaudeProjects-tdarr-plugins/inbox/`
- Sibling inbox: `~/.claude/projects/-mnt-vm-data-ClaudeProjects-tdarr-av1/inbox/`

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
