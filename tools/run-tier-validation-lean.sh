#!/bin/bash
# Emil's LEAN tier set -- the same structure as run-tier-validation.sh with every
# target pulled down, to find where quality stops being acceptable on a projector:
#
#   top-lean  target 72.5  crf 5-50   preset 4
#   mid-lean  target 70    crf 10-60  preset 4
#   low-lean  target 67.5  crf 10-60  preset 6
#
# Same SDR/HDR rule: mainline-tuned via the mainline binary, hdr-defaults via the
# fork (param_set=auto encodes this). Outputs are suffixed "-lean" so they sit
# beside the first set in _outputs/ and stay tellable apart at a glance.
#
# Appends to the SAME tsv and log as the first set, so the two are directly
# comparable and one monitor covers both.
set -u

cd /mnt/vm_data/ClaudeProjects/tdarr-plugins || exit 1
export TDARR_URL=http://10.0.0.3:8275

OUT=${OUT:-/mnt/vm_data/ClaudeProjects/tdarr-plugins/docs/data/job5-2026-08-13-tier-validation.tsv}
SDR_CLIPS=closeenc,harrypotter,topgun,westworld
HDR_CLIP=captain_remux_atmos_sample
MASTERS=/mnt/cache_nvme_two/vm_data/xav-work/job5/masters
MAINLINE=/opt/xav/xav-mainline
HDR=/opt/xav/xav-hdr

run() {
  echo "=================================================================="
  echo "TIER RUN (lean): $*"
  echo "=================================================================="
  node tools/job5-tdarr-bench.js "$@" --out "$OUT" --keep 2>&1
}

run --clips "$SDR_CLIPS" --arms 'top-lean|auto' --binary "$MAINLINE" \
    --target 72.3-72.7 --crf-range 5-50  --preset 4
run --clips "$SDR_CLIPS" --arms 'mid-lean|auto' --binary "$MAINLINE" \
    --target 69.8-70.2 --crf-range 10-60 --preset 4
run --clips "$SDR_CLIPS" --arms 'low-lean|auto' --binary "$MAINLINE" \
    --target 67.3-67.7 --crf-range 10-60 --preset 6

run --clips "$HDR_CLIP" --clipdir "$MASTERS" --arms 'top-lean|auto' --binary "$HDR" \
    --target 72.3-72.7 --crf-range 5-50  --preset 4 \
    --plugin xavPipeEncode --resolution 1080p
run --clips "$HDR_CLIP" --clipdir "$MASTERS" --arms 'mid-lean|auto' --binary "$HDR" \
    --target 69.8-70.2 --crf-range 10-60 --preset 4 \
    --plugin xavPipeEncode --resolution 1080p

echo "LEAN VALIDATION COMPLETE"
