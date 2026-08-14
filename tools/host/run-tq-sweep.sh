#!/usr/bin/env bash
# TQ sweep for the CUDA-built xav. Run on the Unraid host.
#
#   bash run-tq-sweep.sh <xav-binary> <source.mkv> [preset] [crf-range] [target...]
#
# WHY THIS EXISTS (rather than just using run-tq-bench.sh):
#
# run-tq-bench.sh defaults to `-t 10.0-10.2`, reading xav's help line
#     -t | --tq   TQ Range: <8=Butter, 8-10=CVVDP, >10=SSIMU2
# as "pick a value just above 10 to select SSIMULACRA2". But that range is the
# TARGET SCORE, and the magnitude only *incidentally* selects the metric.
# SSIMULACRA2 10 is atrocious quality (90+ = visually lossless, 70-90 = high,
# 50-70 = medium). Even the worst encode the CRF ceiling allowed scored ~49-81,
# i.e. far better than the target, so TQ raised CRF as high as it was permitted
# and stopped. Result: all 20 chunks pinned at crf=40.00, the top of `-f 20-40`.
#
# That run is not target-quality mode. It is a fixed CRF-40 encode that also
# paid for three probe encodes per chunk. Its 15.2 MB output is therefore NOT
# comparable to av1an targeting VMAF 95.
#
# This script sweeps genuine targets and widens the CRF range so the search has
# somewhere to go, then reports wall-clock, total bytes, video-stream bytes and
# the achieved mean/min score per target.
set -uo pipefail

XAV="${1:?usage: run-tq-sweep.sh <xav-binary> <source.mkv> [preset] [crf-range] [target...]}"
SRC="${2:?usage: run-tq-sweep.sh <xav-binary> <source.mkv> [preset] [crf-range] [target...]}"
PRESET="${3:-4}"
CRF_RANGE="${4:-10-40}"
shift 4 2>/dev/null || shift $#
TARGETS=("$@")
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=("84.8-85.2" "89.8-90.2")

IMG="${IMG:-ghcr.io/haveagitgat/tdarr:2.86.01}"
WORK="$(cd "$(dirname "$SRC")" && pwd)"; NAME="$(basename "$SRC")"; BASE="${NAME%.*}"
CRF_LO="${CRF_RANGE%-*}"; CRF_HI="${CRF_RANGE#*-}"

# Parallelism knobs. These are the memory drivers, not the CRF range: xav buffers whole
# decoded chunks in RAM, so footprint scales with WORKERS x BUFF x (chunk frames x frame
# size). At -w 4 -v 2 with default buffering on 1080p10 this host peaked at ~19.8 GB and
# OOM-killed the VM. -w 2 -v 1 -b 2 fits comfortably under a 16g cap.
# KEEP THESE IDENTICAL ACROSS EVERY RUN YOU INTEND TO COMPARE ON WALL-CLOCK.
WORKERS="${WORKERS:-2}"; VSHIP="${VSHIP:-1}"
# BUFF empty => omit -b entirely and let xav use its own default. Do not set this casually:
# -b 4 took peak RSS from ~19.8 GB to >25 GB and tripped a 24g cap on every target.
BUFF="${BUFF:-}"
BUFF_ARG=""; [ -n "${BUFF}" ] && BUFF_ARG="-b ${BUFF}"

echo "== xav TQ sweep =="
echo "  source    : ${WORK}/${NAME}"
echo "  preset    : ${PRESET}    crf range: ${CRF_RANGE}"
echo "  targets   : ${TARGETS[*]}"
echo

for TQ in "${TARGETS[@]}"; do
    # The tag MUST include the CRF range. Deriving it from the target alone means
    # re-running the same target with a different range silently overwrites the
    # previous output and its JSON -- which is exactly how the invalid
    # `-f 10-40` target-90 run (17/20 pinned at the floor) was lost, leaving a
    # same-named file holding the valid `-f 1-40` run's data.
    # The tag must identify the BINARY too, not just target+range. Running a different xav
    # build (e.g. the mainline-SVT one) at the same target/range silently overwrote the
    # hdr-fork output and its JSON -- the numbers survived only because they had already
    # been scored. Same class of bug as the earlier target-only tag.
    TAG="$(basename "${XAV}" | tr -cd 'A-Za-z0-9_')_$(echo "${TQ}" | tr -d '.' | tr '-' '_')_f$(echo "${CRF_RANGE}" | tr '-' '_')"
    OUT="out_xav_tq_${TAG}.mkv"
    echo "---- target ${TQ} ----"

    # MEMORY CAP IS NOT OPTIONAL ON THIS HOST.
    # xav at -w 4 -v 2 on 1080p reached ~19.8 GB RSS and drove HomeTower into GLOBAL OOM.
    # The kernel's victim was the Ubuntu VM's qemu process (36 GB allocated) -- i.e. running
    # this unbounded killed the workstation VM, not just the encode. The host has 60 GB and
    # the VM reserves 36, leaving ~20-24 GB for everything else.
    # With --memory set, an over-budget xav is killed inside its own cgroup and nothing else
    # on the host is touched. Raise MEMLIMIT only after checking `free -g` and the VM's
    # allocation (`virsh dommemstat Ubuntu`).
    docker run --rm --gpus all \
      --memory="${MEMLIMIT:-16g}" --memory-swap="${MEMLIMIT:-16g}" \
      -e NVIDIA_DRIVER_CAPABILITIES=all \
      --security-opt seccomp=unconfined \
      -v "${XAV}:/usr/local/bin/xav:ro" \
      -v "${WORK}:/work" -w /work \
      --entrypoint bash "${IMG}" -c "
        rm -f /work/${OUT} /work/${BASE}_scd.txt /work/${BASE}.json
        for d in /work/.???????; do [ -w \"\$d\" ] && rm -rf \"\$d\"; done 2>/dev/null
        t0=\$(date +%s%N)
        script -qec \"/usr/local/bin/xav /work/${NAME} /work/${OUT} -w ${WORKERS} -v ${VSHIP} ${BUFF_ARG} -t ${TQ} -f ${CRF_RANGE} -p '--preset ${PRESET}' -a 'auto 1'\" /dev/null > /work/.xavlog_${TAG} 2>&1
        rc=\$?; t1=\$(date +%s%N)
        secs=\$(( (t1 - t0) / 1000000000 ))
        tot=\$(stat -c%s /work/${OUT} 2>/dev/null || echo 0)
        vb=\$(ffprobe -v error -select_streams v:0 -show_entries packet=size -of csv=p=0 /work/${OUT} 2>/dev/null | awk '{s+=\$1} END{print s+0}')
        geom=\$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height,pix_fmt -of csv=p=0 /work/${OUT} 2>/dev/null)
        cp -f /work/${BASE}.json /work/${BASE}_${TAG}.json 2>/dev/null
        # achieved score stats across chunk finals
        # Count pinning at BOTH bounds against the ACTUAL range in use. A run pinned at
        # either end is a fixed-CRF encode, not a target-quality result.
        stats=\$(grep -oE '\"final\": \{ \"crf\": [0-9.]+, \"score\": [0-9.]+' /work/${BASE}.json 2>/dev/null \
                 | sed -E 's/.*crf\": ([0-9.]+), \"score\": ([0-9.]+)/\1 \2/' \
                 | awk -v lo=${CRF_LO} -v hi=${CRF_HI} '{ct+=\$1; st+=\$2; if(NR==1||\$2<mn)mn=\$2; if(NR==1||\$2>mx)mx=\$2; if(\$1<=lo+0.001)fl++; if(\$1>=hi-0.001)ce++} END{if(NR)printf \"chunks=%d mean_score=%.2f min=%.2f max=%.2f mean_crf=%.2f at_floor=%d at_ceiling=%d\", NR, st/NR, mn, mx, ct/NR, fl+0, ce+0}')
        echo \"### RESULT target=${TQ} EXIT \$rc SECONDS \$secs TOTAL_BYTES \$tot VIDEO_BYTES \$vb GEOM \$geom \$stats\"
      "
    echo
done
