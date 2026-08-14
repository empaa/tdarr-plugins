# Host-side research scripts

One-off harnesses that ran on the Unraid host during the xav investigation, kept because they
document *how* the measurements in `docs/` were produced. They are not part of the build or
test loop and nothing in the repo calls them.

They lived only in a scratch directory on the host (`xav-work/host/`) and would have gone with
it during cleanup.

| script | what it did |
|---|---|
| `cut-prod-clips.sh` | **cut the four sample clips** in `test/samples/` from full films — the provenance of closeenc/harrypotter/topgun/westworld |
| `cut-jurassic-motion.sh` | cut the high-motion jurassic sample |
| `score-ssimu2.sh` / `score-vmaf.sh` | score an encode against a source with FFVship / libvmaf |
| `run-param-sweep.sh` / `run-settings-sweep.sh` / `run-tq-sweep.sh` | the SVT parameter sweeps behind `docs/encoder-recommendations.md` |
| `run-tq-bench.sh` / `run-full-bakeoff.sh` | target-quality benchmark and the av1an-vs-xav bake-off |
| `drive-settings-sweep.sh` / `drive-jurassic-sweep.sh` | drivers that fed the sweeps |
| `mem-sampler.sh` | peak-RSS sampling — the source of the "4 workers peaked ~20 GB" figure |
| `hdr-test.sh` / `hdr-pipe-test.sh` | HDR metadata survival through the native and pipe paths |

They assume host paths (`/mnt/cache_nvme_two/vm_data/xav-work/...`) that no longer exist, so
treat them as reference rather than something to run unchanged.
