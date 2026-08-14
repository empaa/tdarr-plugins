#!/usr/bin/env bash
# VMAF scoring for the Avatar bakeoff, on the COMMON CONTENT REGION.
#
#   bash score-vmaf.sh <reference.mkv> <dist1.mkv> [dist2.mkv ...]
#
# Runs in tdarr-plugins' node image, which has ffmpeg 8.1.2 built --enable-libvmaf.
#
# GEOMETRY -- the thing that silently ruins this comparison if ignored:
#   reference    1920x1080  (letterboxed 1.85:1, 20px mattes)
#   av1an output 1920x1080  (uncropped, mattes encoded)
#   xav output   1920x1040  (mandatory autocrop, mattes removed)
# So everything is cropped to the common region 1920x1040@y=20 before scoring. Scoring a
# 1040-line xav output against a full 1080 reference produces a catastrophic VMAF that
# looks like a real result.
#
# Both streams are forced to the same pix_fmt: the source is 8-bit, every encode is 10-bit.
#
# ALIGNMENT IS VERIFIED, NOT ASSUMED: before scoring, PSNR is probed at several crop offsets
# and the peak must land on the expected y. A misaligned crop degrades scores smoothly and
# would otherwise pass unnoticed.
set -uo pipefail

REF="${1:?usage: score-vmaf.sh <reference.mkv> <dist...>}"
shift
IMG="${IMG:-ghcr.io/empaa/tdarr_node:latest}"
CROP_W=1920 CROP_H=1040 CROP_Y=20
WORK="$(cd "$(dirname "$REF")" && pwd)"
REFN="$(basename "$REF")"

DISTS=()
for d in "$@"; do DISTS+=("$(basename "$d")"); done

docker run --rm --memory=16g \
  -v "${WORK}":/work -w /work --entrypoint bash "${IMG}" -c "
set -u
REF=/work/${REFN}
CW=${CROP_W}; CH=${CROP_H}; CY=${CROP_Y}

echo '===== ALIGNMENT CHECK (PSNR must peak at the expected offset) ====='
for D in ${DISTS[*]}; do
  DH=\$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 /work/\$D)
  echo \"-- \$D (height \$DH) --\"
  for Y in 0 10 20 30 40; do
    # Crop the reference at candidate offset Y; crop the distorted only if it is still 1080.
    if [ \"\$DH\" -eq 1080 ]; then DFILT=\"crop=\${CW}:\${CH}:0:\${Y}\"; else DFILT=\"null\"; fi
    # NB: do NOT pass -v error here. The psnr/libvmaf filters report their result at INFO
    # level, so -v error silently suppresses the very line being parsed and every score
    # comes back empty while ffmpeg still exits 0.
    P=\$(ffmpeg -hide_banner -i /work/\$D -i \$REF -lavfi \\
         \"[0:v]\${DFILT},format=yuv420p10le[d];[1:v]crop=\${CW}:\${CH}:0:\${Y},format=yuv420p10le[r];[d][r]psnr\" \\
         -frames:v 60 -f null - 2>&1 | grep -oE 'average:[0-9.]+' | tail -1 | cut -d: -f2)
    echo \"     y=\${Y}  PSNR=\${P:-n/a}\"
  done
done

echo
echo '===== VMAF + PSNR on the common region ====='
for D in ${DISTS[*]}; do
  DH=\$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 /work/\$D)
  if [ \"\$DH\" -eq 1080 ]; then DFILT=\"crop=\${CW}:\${CH}:0:\${CY}\"; else DFILT=\"null\"; fi
  VB=\$(ffprobe -v error -select_streams v:0 -show_entries packet=size -of csv=p=0 /work/\$D | awk '{s+=\$1} END{print s}')
  FR=\$(ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames -of csv=p=0 /work/\$D)
  OUT=\$(ffmpeg -hide_banner -i /work/\$D -i \$REF -lavfi \\
        \"[0:v]\${DFILT},format=yuv420p10le[d];[1:v]crop=\${CW}:\${CH}:0:\${CY},format=yuv420p10le[r];[d][r]libvmaf=n_threads=16\" \\
        -f null - 2>&1 | grep -oE 'VMAF score: [0-9.]+' | grep -oE '[0-9.]+')
  echo \"### \$D | frames=\$FR | video_bytes=\$VB | VMAF=\${OUT:-FAILED}\"
done
"
