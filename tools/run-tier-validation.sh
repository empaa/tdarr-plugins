#!/bin/bash
# Emil's revised tier strategy, run as REAL Tdarr jobs on JOB5 so the encodes are
# visible on the dashboard and the outputs can be eyeballed on a projector.
#
#   top  target 75  crf 5-50   preset 4
#   mid  target 75  crf 10-60  preset 4
#   low  target 70  crf 10-60  preset 6
#
# mainline-tuned for SDR, hdr-defaults for HDR. param_set=auto already encodes
# exactly that rule (src/shared/xav.js): the mainline binary gets MAINLINE_PARAMS,
# the hdr fork gets none because its own defaults are the recipe. So the SDR/HDR
# split is expressed by which BINARY each invocation uses, not by a flag.
#
# Top and mid differ ONLY in CRF range. That is not redundant: it matters exactly
# where content pins at a bound, which is what happened to captain (13 chunks at
# the floor) and closeenc.
#
# Runs on the VM, driving Tdarr over HTTP. Launched with setsid so it outlives
# the shell that started it -- background waiters here get reaped.
set -u

cd /mnt/vm_data/ClaudeProjects/tdarr-plugins || exit 1
export TDARR_URL=http://10.0.0.3:8275

OUT=${OUT:-/mnt/vm_data/ClaudeProjects/tdarr-plugins/docs/data/job5-2026-08-13-tier-validation.tsv}
SDR_CLIPS=closeenc,harrypotter,topgun,westworld
HDR_CLIP=captain_remux_atmos_sample
MASTERS=/mnt/cache_nvme_two/vm_data/xav-work/job5/masters
MAINLINE=/opt/xav/xav-mainline
HDR=/opt/xav/xav-hdr

rm -f "$OUT"

# The node reconnects a few seconds after a container restart; starting before it
# is online just burns a run on a queue that never drains.
echo "waiting for JOB5 node..."
for _ in $(seq 1 60); do
  if curl -s -m 10 "$TDARR_URL/api/v2/get-nodes" | grep -q '"nodeName":"JOB5"'; then
    echo "node online"; break
  fi
  sleep 5
done

run() {
  echo "=================================================================="
  echo "TIER RUN: $*"
  echo "=================================================================="
  node tools/job5-tdarr-bench.js "$@" --out "$OUT" --keep 2>&1
}

# SDR, mainline+tuned. Ordered so a full tier completes before the next starts --
# an interrupted run then still leaves a coherent, comparable set.
run --clips "$SDR_CLIPS" --arms 'top|auto' --binary "$MAINLINE" \
    --target 74.8-75.2 --crf-range 5-50  --preset 4
run --clips "$SDR_CLIPS" --arms 'mid|auto' --binary "$MAINLINE" \
    --target 74.8-75.2 --crf-range 10-60 --preset 4
run --clips "$SDR_CLIPS" --arms 'low|auto' --binary "$MAINLINE" \
    --target 69.8-70.2 --crf-range 10-60 --preset 6

# HDR: captain is 4K, so it takes the pipe path (ffmpeg scales, xav reads Y4M).
# Only top and mid -- a 4K HDR remux would never be assigned the low tier.
run --clips "$HDR_CLIP" --clipdir "$MASTERS" --arms 'top|auto' --binary "$HDR" \
    --target 74.8-75.2 --crf-range 5-50  --preset 4 \
    --plugin xavPipeEncode --resolution 1080p
run --clips "$HDR_CLIP" --clipdir "$MASTERS" --arms 'mid|auto' --binary "$HDR" \
    --target 74.8-75.2 --crf-range 10-60 --preset 4 \
    --plugin xavPipeEncode --resolution 1080p

echo "TIER VALIDATION COMPLETE"
