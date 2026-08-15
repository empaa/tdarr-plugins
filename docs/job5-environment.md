# JOB5 test environment — inventory and teardown

> **TORN DOWN 2026-08-14, on Emil's instruction.** Containers, network, `xav-work/job5/` and
> `/mnt/user/tdarr-job5-cache` are all gone. Nothing below exists any more.
>
> Kept from it: the eight sample sources are now in `test/samples/` (gitignored), the host
> build toolchain is in `tools/xav-build/`, and the research harnesses — including
> `cut-prod-clips.sh`, which is how the four clips were cut — are in `tools/host/`.
>
> This file stays as the record of how the environment was built and, more usefully, the
> traps it taught. Rebuild from the "What exists" section if a throwaway is ever needed
> again; the trap list below still applies to any Tdarr instance.

Handed over from hometower 2026-08-13 when plugin testing moved to this repo. **This repo
owns it now, including destroying it.** Nothing here is load-bearing for production.

Full provenance is `docs/job5-handoff.md` in the hometower repo; this file is what we need
to drive it and to clean it up.

## Access

    ssh -i ~/.ssh/tower -o IdentitiesOnly=yes root@10.0.0.3     # host shell
    http://10.0.0.3:8275                                        # throwaway web UI

**Production is `:8265` / `tdarr_server` / `tdarr_node_hometower` and stays read-only.**
The throwaway is `:8275` / `tdarr_job5_server` / `tdarr_job5_node`. Never judge state from
the VM's `/mnt/vm_data` path — virtiofs lags 30+ minutes; read host paths over SSH.

## What exists

Containers, both `--restart no` (they do not survive a host reboot), network `tdarr_job5`:

| container | notes |
|---|---|
| `tdarr_job5_server` | `8275→8265`, `8276→8266`, `internalNode=false` so all work lands on JOB5 |
| `tdarr_job5_node` | node name `JOB5`, `--memory=28g`, 1 transcode worker, GPU all (Vship needs CUDA), **not** privileged |

Disk, base `/mnt/cache_nvme_two/vm_data/xav-work/job5/` — **8.4 G**, plus 218 M cache:

| path | size | what |
|---|---|---|
| `clips/` | 1.4 G | the four production clips — the good samples |
| `masters/` | 2.7 G | avatar, jurassic, captain, smile |
| `library/<runId>/` | 4.4 G | 27 run dirs from the matrix |
| `server/` | 9.6 M | Tdarr DB **and the deployed plugins** |
| `plugins-backup-20260813-1359/` | 284 K | pre-patch bundles |
| `/mnt/user/tdarr-job5-cache` | 218 M | transcode cache — deliberately a **different filesystem** (shfs vs xfs) so staging exercises the copy path and its free-space guard |

Job reports are **the only place plugin log lines survive**:
`<base>/server/Tdarr/DB2/JobReports/undefined/*.txt`.

`/mnt/user/appdata/tdarr/xav` (xav-mainline, xav-hdr, FFVship, libvship.so) is **shared with
production**, mounted read-only here. Do not overwrite those binaries without telling Emil.

## Deploying a build

Copy bundles to the **server** copy, then restart both containers — the node re-pulls plugins
from the server on start:

    scp dist/LocalFlowPlugins/video/<plugin>/1.0.0/index.js \
        root@10.0.0.3:<base>/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/video/<plugin>/1.0.0/index.js
    ssh ... docker restart tdarr_job5_server tdarr_job5_node

hometower's `killAll` patch on the deployed bundles is obsolete: the fix is in source as of
`ee1eb3a`, so a normal build carries it. Their handover §5 still says "your source has the
bug" — that was true when written, not now.

## Fast verification loop

The bundles are self-contained, so the quickest check skips Tdarr orchestration entirely:
copy the bundle plus a runner into `/temp/functest/` and call `plugin(args)` directly with a
hand-built `inputFileObj`. One 25 s clip verifies argv, probe and merge in ~25 s.

Two traps:

- The runner needs a **keep-alive timer** — `spawnAsync` unrefs children, so awaiting one lets
  the event loop drain and Node exits mid-encode reporting nothing.
- **Launch detached** (`docker exec -d ... > log 2>&1`, then poll). A plain `ssh docker exec`
  dies at the 2-minute tool timeout, killing the node process and orphaning ffprobe.

## Environment traps

> Rebuilt and re-destroyed 2026-08-14 to verify v4.0.0. Three traps cost real time on that
> rebuild, all of them new since this file was written:
>
> - **Do NOT pass `--init` to the Tdarr containers.** The images use s6-overlay, which must be
>   PID 1; `--init` inserts docker's own init and both containers die instantly with
>   `s6-overlay-suexec: fatal: can only run as pid 1`. (`--init` is still right for a bare
>   `node` functest container — that advice below applies there, not here.)
> - **Flows exist only in `cruddb`.** There is no `get-flow-plugins` / `list-flow-plugins`
>   REST route — the Flows page issues exactly one `POST /api/v2/cruddb` and nothing else, and
>   the routes are not extractable from the packaged `Tdarr_Server` binary. The Flows page also
>   offers no creation control until a library exists. Creating a library + flow
>   programmatically was not solved; budget for it or drive the UI.
> - **`shfs` lies about `st_dev`.** Two paths under `/mnt/user` report the *same* device
>   number and `link()` still fails `EXDEV`, because shfs is a FUSE union across disks. Any
>   same-filesystem check must therefore attempt the hardlink and catch the failure rather
>   than trusting `stat`. This is why `src/shared/staging.js` is written the way it is.

- Library dirs must be owned **99:100** or staging fails `EACCES`.
- **`rm -rf` on a bind-mounted directory** empties it inside the running containers until they
  restart. Restage in place, or restart both after.
- `--sc-only` **with `-t`** prints `FAIL` regardless of argument validity. As a linter use
  `--sc-only -p '<params>'` alone.
- Nested `ssh → docker → bash -c` mangles xav argv. Write a script file and `scp` it.

## Hostile sample worth keeping

`harrypotter.mkv` carries a **second, degenerate video stream** (`index=1 vc1 8132x2`) and
ffprobe warns `first frame is no keyframe`. Verified 2026-08-13 that we handle it: every
plugin picks the video stream with `find(codec_type === 'video')`, which takes index 0
(1920x1080), and the encode completes at 1920x1080.

**Latent fragility, not a current bug:** that selection is *stream-order dependent*, and
`sanitizeFile` maps all video streams through (`src/sanitizeFile/index.js:421`), so the
degenerate stream survives staging. A source presenting such a stream **first** would be
picked as "the video stream" — driving width, frame count and duration, and in
`xavPipeEncode` triggering a downscale off an 8132px width. Picking the largest non-image
video stream instead would close it.

## Still never run

- **Cancellation** mid-encode via Tdarr's own path — confirm no orphaned `xav`/`script`/
  `ffmpeg`. The process manager's group-kill and watchdog have only ever met unit stubs.
- **pct-80 passthrough** — output port 2 has never fired. The gate is disabled at `pct=100`
  (`maxEncodedPercent < 100`) and every run so far was at 100.

## Teardown — ours to run, ask Emil first

    docker rm -f tdarr_job5_server tdarr_job5_node
    docker network rm tdarr_job5
    rm -rf /mnt/cache_nvme_two/vm_data/xav-work/job5 /mnt/user/tdarr-job5-cache

Leave `<xav-work>/bench/` (~7 G) — older bake-off artifacts, not part of this. The clips took
real time to produce and this is the only place the plugins run against real media, so
**confirm with Emil before destroying**.
