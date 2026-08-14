#!/usr/bin/env bash
# TQ benchmark for the CUDA-built xav. Run on the Unraid host.
#
#   bash run-tq-bench.sh <xav-binary> <source.mkv> [target-range] [preset]
#
# Default target 10.0-10.2 = SSIMULACRA2 band (>10). Use 8-10 for CVVDP (CUDA-only,
# also needs -d <display file>), or <8 for Butteraugli.
# TQ restricts preset to 0-7; 8+ is rejected as "real-time usage and inconsistent".
set -uo pipefail

XAV="${1:?usage: run-tq-bench.sh <xav-binary> <source.mkv> [target] [preset]}"
SRC="${2:?usage: run-tq-bench.sh <xav-binary> <source.mkv> [target] [preset]}"
TQ="${3:-10.0-10.2}"
PRESET="${4:-4}"
IMG="${IMG:-ghcr.io/haveagitgat/tdarr:2.86.01}"

WORK="$(cd "$(dirname "$SRC")" && pwd)"; NAME="$(basename "$SRC")"; BASE="${NAME%.*}"

echo "== xav TQ bench =="
echo "  source : ${WORK}/${NAME}"
echo "  target : ${TQ}   preset: ${PRESET}"
echo

docker run --rm --gpus all \
  -e NVIDIA_DRIVER_CAPABILITIES=all \
  --security-opt seccomp=unconfined \
  -v "${XAV}:/usr/local/bin/xav:ro" \
  -v "${WORK}:/work" -w /work \
  --entrypoint bash "${IMG}" -c "
    nvidia-smi -L 2>/dev/null || echo '(no nvidia-smi in image)'
    ldd /usr/local/bin/xav | grep -i cuda || echo 'WARNING: no libcuda -- not a CUDA build'
    rm -f /work/out_xav_tq.mkv /work/${BASE}_scd.txt
    for d in /work/.???????; do [ -w \"\$d\" ] && rm -rf \"\$d\"; done 2>/dev/null
    t0=\$(date +%s%N)
    script -qec \"/usr/local/bin/xav /work/${NAME} /work/out_xav_tq.mkv -w 4 -v 2 -t ${TQ} -f 20-40 -p '--preset ${PRESET}' -a 'auto 1'\" /dev/null
    rc=\$?; t1=\$(date +%s%N)
    echo \"### xav_tq EXIT \$rc SECONDS \$(( (t1 - t0) / 1000000000 )) BYTES \$(stat -c%s /work/out_xav_tq.mkv 2>/dev/null || echo 0)\"
  "
