#!/usr/bin/env bash
# SSIMULACRA2 scoring via FFVship (Vship's standalone CLI) on the GPU.
#
#   bash score-ssimu2.sh <reference.mkv> <dist1.mkv> [dist2.mkv ...]
#
# Uses FFVship's own crop options rather than an ffmpeg filter chain, so the frames handed
# to the metric are exactly the common content region:
#   reference    1920x1080 -> crop 20 top + 20 bottom -> 1920x1040
#   av1an output 1920x1080 -> crop 20 top + 20 bottom -> 1920x1040
#   xav output   1920x1040 -> no crop (already autocropped)
# Scoring a 1040-line xav output against an uncropped 1080 reference yields a catastrophic
# score that looks entirely plausible, so the crop is applied per-input by height.
set -uo pipefail

REF="${1:?usage: score-ssimu2.sh <reference.mkv> <dist...>}"
shift
BIN=/mnt/cache_nvme_two/vship-cli
WORK="$(cd "$(dirname "$REF")" && pwd)"
REFN="$(basename "$REF")"
MATTE="${MATTE:-20}"

DISTS=()
for d in "$@"; do DISTS+=("$(basename "$d")"); done

docker run --rm --gpus all -e NVIDIA_DRIVER_CAPABILITIES=all --memory=16g \
  -v "${BIN}":/bin_vship:ro -v "${WORK}":/work -w /work \
  --entrypoint bash xav-build -c "
export LD_LIBRARY_PATH=/bin_vship
# FFVship links ffms2 dynamically; the stock xav-build image has it only if the BUILD ran
# here. A fresh container needs the runtime lib or every invocation dies with
# 'libffms2.so.5: cannot open shared object file'.
ldconfig -p | grep -q libffms2 || { apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq --no-install-recommends libffms2-5 >/dev/null 2>&1; }
ldconfig -p | grep -q libffms2 && echo 'ffms2 runtime: ok' || { echo 'ffms2 runtime MISSING'; exit 1; }
M=${MATTE}
echo '-- GPU --'; /bin_vship/FFVship --list-gpu 2>&1 | head -3
for D in ${DISTS[*]}; do
  DH=\$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 /work/\$D 2>/dev/null)
  # Crop the encoded only when it still carries the mattes (1080). xav output is already 1040.
  if [ \"\$DH\" -eq 1080 ]; then EC=\"--cropTopEncoded \$M --cropBottomEncoded \$M\"; else EC=\"\"; fi
  echo
  echo \"=== \$D (height \$DH) ===\"
  /bin_vship/FFVship -s /work/${REFN} -e /work/\$D -m SSIMULACRA2 \
      --cropTopSource \$M --cropBottomSource \$M \$EC \
      --threads 2 --gpu-threads 3 2>&1 | tail -12
done
"
