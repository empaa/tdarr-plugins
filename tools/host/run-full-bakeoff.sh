#!/usr/bin/env bash
# Full Avatar bakeoff, all encodes under ONE set of conditions, run back-to-back on the host.
#
#   bash run-full-bakeoff.sh
#
# WHY THIS EXISTS: the first pass measured av1an with the workstation VM alive (36 GB) and
# the xav runs after the host OOM-killed that VM, so xav had ~36 GB and the VM's vCPU
# threads to itself. Sizes and achieved scores were unaffected (per-chunk, deterministic)
# but wall-clock was not comparable. The VM is now pinned at 8 GB, so everything below runs
# in one stable condition, sequentially, with nothing else competing.
#
# Memory: xav at -w 4 -v 2 peaked ~19.8 GB and previously took the VM down. MEMLIMIT keeps
# it inside its own cgroup. With the VM at 8 GB the host has ~44 GB available, so 24g is
# safe headroom rather than a squeeze.
set -uo pipefail

BENCH=/mnt/cache_nvme_two/vm_data/xav-work/bench
XAV=/mnt/cache_nvme_one/appdata/xav/target/release/xav
HOSTDIR=/mnt/user/vm_data/xav-work/host
LOGS=/mnt/user/vm_data/xav-work/logs

export MEMLIMIT=24g WORKERS=4 VSHIP=2 BUFF=4

echo "############ FULL BAKEOFF START $(date -Is) ############"
free -g | head -2

# ---- 1. av1an baseline, tdarr-plugins' production invocation, unmodified ----
echo; echo "######## av1an baseline ########"
docker run --rm --name av1an_avatar2 \
  --memory=24g --memory-swap=24g \
  -v /mnt/cache_nvme_two/vm_data/xav-work:/work -w /work \
  --entrypoint bash ghcr.io/empaa/tdarr_node:latest /work/bench/run-av1an-avatar.sh

# Preserve it under a distinct name so the first-pass output is not clobbered.
[ -f "${BENCH}/out_av1an_avatar.mkv" ] && cp -f "${BENCH}/out_av1an_avatar.mkv" "${BENCH}/out_av1an_avatar_p2.mkv"

# ---- 2. xav TQ sweep, three targets, same machine state ----
echo; echo "######## xav TQ sweep ########"
bash "${HOSTDIR}/run-tq-sweep.sh" "${XAV}" "${BENCH}/avatar_fna_sample.mkv" \
  4 5-50 79.8-80.2 84.8-85.2 89.8-90.2

echo; echo "############ FULL BAKEOFF DONE $(date -Is) ############"
echo "== outputs =="
ls -la "${BENCH}"/out_*.mkv 2>/dev/null
