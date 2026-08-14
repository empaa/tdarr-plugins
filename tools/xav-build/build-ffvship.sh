#!/usr/bin/env bash
# Build FFVship -- Vship's standalone FFmpeg-based CLI -- for SSIMULACRA2 scoring on the GPU.
#
#   bash build-ffvship.sh          # binary lands in /mnt/cache_nvme_two/vship-cli/FFVship
#
# WHY THIS IS AWKWARD: the two capabilities needed live in different images.
#   xav-build                     has nvcc (needed for BACKEND=Cuda) but FFmpeg 6.1
#   ghcr.io/empaa/tdarr_node      has FFmpeg 8.1.2 + VapourSynth but no nvcc
# FFVship references AVCOL_SPC_YCGCO_RO, added in FFmpeg 7 (libavutil 59). Building in
# xav-build therefore fails on that one enum. Rather than compile FFmpeg 7 from source just
# to get a header, guard the case by libavutil version -- it only drops handling for the
# YCgCo-Re/Ro colourspace, which nothing in this bakeoff uses (all bt709/unknown SDR).
#
# Also note: `BACKEND=Cuda`, NOT `CUDA`. The Makefile rejects the uppercase spelling with
# "CUDA is not a valid Backend, choose HIP, Cuda or Vulkan".
set -uo pipefail

OUT_DIR=/mnt/cache_nvme_two/vship-cli
mkdir -p "${OUT_DIR}"

docker run --rm --gpus all -e NVIDIA_DRIVER_CAPABILITIES=all \
  --memory=12g -v "${OUT_DIR}":/out --entrypoint bash xav-build -c '
set -u
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq --no-install-recommends \
    libffms2-dev libavformat-dev libavcodec-dev libavutil-dev libswscale-dev >/dev/null 2>&1
pkg-config --exists ffms2 && echo "ffms2: ok"

git clone --depth 1 https://codeberg.org/Line-fr/Vship /tmp/vship >/dev/null 2>&1 || exit 1
cd /tmp/vship

# Guard every FFmpeg 7+ colourspace enum this file uses, by libavutil version.
HDR=src/ffvship_utility/ffmpegToVshipColorFormat.hpp
for SYM in AVCOL_SPC_YCGCO_RO AVCOL_SPC_YCGCO_RE; do
    if grep -q "case ${SYM}:" "${HDR}" 2>/dev/null; then
        sed -i "s|^\( *\)case ${SYM}:|\1#if LIBAVUTIL_VERSION_INT >= AV_VERSION_INT(59,0,100)\n\1case ${SYM}:\n\1#endif|" "${HDR}"
        echo "guarded ${SYM}"
    fi
done

echo "=== stage 1: libvship (Cuda) ==="
make build BACKEND=Cuda 2>&1 | tail -4
ls -la libvship* 2>/dev/null | head -3

echo "=== stage 2: FFVship ==="
make buildFFVSHIP BACKEND=Cuda 2>&1 | tail -12

if [ -f FFVship ]; then
    # FFVship links libvship SHARED, so the .so must travel with the binary or it dies at
    # startup with "libvship.so: cannot open shared object file". Ship both and run with
    # LD_LIBRARY_PATH pointing at the same directory.
    cp FFVship libvship.so /out/ && echo "BUILT_OK"
    LD_LIBRARY_PATH=/out /out/FFVship --help 2>&1 | head -45
else
    echo "BUILD_FAILED"
fi
'
