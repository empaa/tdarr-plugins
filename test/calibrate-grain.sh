#!/usr/bin/env bash
# calibrate-grain.sh — Empirically derive DENOISE_CURVE and PHOTON_CURVE
#
# Uses real source files with VS AddGrain for synthetic noise, Laplacian
# spatial estimation for sigma measurement, ternary search for NLMeans h,
# and binary search for photon-noise. Everything runs inside VapourSynth —
# no y4m intermediates, no bit depth conversion issues.
#
# Usage:
#   Run inside the tdarr-interactive-node Docker container:
#     ./test/calibrate-grain.sh <source_file> [workdir]
#
#   source_file: path to a clean video file (CGI/animation ideal)
#   workdir: defaults to /tmp/grain-calibration
#
# Requirements (all on PATH):
#   vspipe, av1an
#   VapourSynth with lsmas, nlm_ispc, grain plugins
#
# Runtime: ~15-25 minutes depending on hardware

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <source_file> [workdir]"
  echo "  source_file: path to a clean video file"
  echo "  workdir: defaults to /tmp/grain-calibration"
  exit 1
fi

SOURCE="$1"
WORKDIR="${2:-/tmp/grain-calibration}"
mkdir -p "$WORKDIR"

if [ ! -f "$SOURCE" ]; then
  echo "Error: source file not found: $SOURCE"
  exit 1
fi

# Sigma levels to test (AddGrain var values)
SIGMAS=(1 2 3 4 6 8 10 15)

# Search bounds
H_MIN=0.1
H_MAX=10.0
H_TOLERANCE=0.1

PN_MIN=1
PN_MAX=64

# Encoding settings (fast for calibration)
SVT_PRESET=8
CRF=30

# Frames to use (sample from middle of source)
SAMPLE_FRAMES=120

# CSV output files — include source name for multi-file aggregation
SOURCE_NAME=$(basename "$SOURCE" | sed 's/\.[^.]*$//' | tr ' ' '_' | cut -c1-30)
DENOISE_CSV="$WORKDIR/denoise_${SOURCE_NAME}.csv"
PHOTON_CSV="$WORKDIR/photon_${SOURCE_NAME}.csv"
SUMMARY_CSV="$WORKDIR/summary_${SOURCE_NAME}.csv"

# ── Helpers ──────────────────────────────────────────────────────────────

log() { echo "[calibrate] $*"; }

esc() { echo "$1" | sed "s/'/\\\\'/g"; }

# Measure Laplacian sigma of a VS clip (source file + optional AddGrain).
# All processing happens inside VapourSynth — no intermediates.
# Args: source_path, start_frame, num_frames, grain_var (0 = no noise)
measure_laplacian_sigma() {
  local src="$1" start="$2" frames="$3" grain_var="$4"
  local vpy="$WORKDIR/_measure.vpy"
  local src_esc=$(esc "$src")

  cat > "$vpy" <<VPYEOF
import vapoursynth as vs
import sys, math
core = vs.core
clip = core.lsmas.LWLibavSource(source='${src_esc}')
clip = clip[${start}:${start}+${frames}]
$([ "$grain_var" != "0" ] && echo "clip = core.grain.Add(clip, var=${grain_var}, uvar=${grain_var}/2, seed=42)")
luma = core.std.ShufflePlanes(clip, planes=0, colorfamily=vs.GRAY)
luma32 = core.resize.Point(luma, format=vs.GRAYS)
lap = core.std.Convolution(luma32, matrix=[1, -2, 1, -2, 4, -2, 1, -2, 1])
absLap = core.std.Expr(lap, expr=['x abs'])
stats = core.std.PlaneStats(absLap)

def emit(n, f):
    avg = f.props['PlaneStatsAverage']
    sigma = math.sqrt(math.pi / 2.0) * (1.0 / 6.0) * avg * 255.0
    sys.stderr.write('SIGMA:{:.6f}\n'.format(sigma))
    sys.stderr.flush()
    return f

out = core.std.ModifyFrame(stats, stats, emit)
out.set_output()
VPYEOF

  local output
  output=$(vspipe -p "$vpy" -- 2>&1 || true)
  rm -f "$vpy"

  # Return median sigma
  echo "$output" | grep -oP 'SIGMA:\K[\d.]+' | sort -n | awk '
    { vals[NR] = $1; n = NR }
    END {
      if (n == 0) { print 0; exit }
      mid = int((n+1)/2)
      if (n % 2 == 1) print vals[mid]
      else print (vals[mid] + vals[mid+1]) / 2
    }'
}

# Denoise a source clip with NLMeans at given h, measure PSNR vs clean source.
# Uses VapourSynth internally — compares noisy+denoised against clean frames.
denoise_and_measure_psnr() {
  local src="$1" start="$2" frames="$3" grain_var="$4" h="$5"
  local vpy="$WORKDIR/_psnr.vpy"
  local src_esc=$(esc "$src")

  cat > "$vpy" <<VPYEOF
import vapoursynth as vs
import sys, math
core = vs.core

clip = core.lsmas.LWLibavSource(source='${src_esc}')
clip = clip[${start}:${start}+${frames}]

# Clean reference (original source)
clean = core.std.ShufflePlanes(clip, planes=0, colorfamily=vs.GRAY)
clean32 = core.resize.Point(clean, format=vs.GRAYS)

# Noisy version
noisy = core.grain.Add(clip, var=${grain_var}, uvar=${grain_var}/2, seed=42)

# Denoise
denoised = core.nlm_ispc.NLMeans(noisy, d=1, a=2, s=4, h=${h}, channels='Y')
denoised = core.nlm_ispc.NLMeans(denoised, d=1, a=2, s=4, h=${h}*0.5, channels='UV')
den_luma = core.std.ShufflePlanes(denoised, planes=0, colorfamily=vs.GRAY)
den_luma32 = core.resize.Point(den_luma, format=vs.GRAYS)

# MSE between clean and denoised
diff_sq = core.std.Expr([clean32, den_luma32], expr=['x y - dup *'])
stats = core.std.PlaneStats(diff_sq)

def emit(n, f):
    mse = f.props['PlaneStatsAverage']
    if mse > 0:
        # PSNR in dB (signal range is 1.0 for float)
        psnr = 10.0 * math.log10(1.0 / mse)
    else:
        psnr = 99.0
    sys.stderr.write('PSNR:{:.4f}\n'.format(psnr))
    sys.stderr.flush()
    return f

out = core.std.ModifyFrame(stats, stats, emit)
out.set_output()
VPYEOF

  local output
  output=$(vspipe -p "$vpy" -- 2>&1 || true)
  rm -f "$vpy"

  # Return mean PSNR
  echo "$output" | grep -oP 'PSNR:\K[\d.]+' | awk '
    { sum += $1; n++ }
    END { if (n > 0) printf "%.4f", sum/n; else print 0 }'
}

# Encode with av1an + photon noise, decode, measure Laplacian sigma of output.
encode_and_measure_sigma() {
  local src="$1" start="$2" frames="$3" grain_var="$4" best_h="$5" pn="$6"
  local vpy_encode="$WORKDIR/_encode.vpy"
  local encoded="$WORKDIR/_encoded.mkv"
  local tmpdir="$WORKDIR/_av1an_tmp"
  local vpy_measure="$WORKDIR/_measure_out.vpy"
  local src_esc=$(esc "$src")

  mkdir -p "$tmpdir"

  # Create denoised source for encoding
  cat > "$vpy_encode" <<VPYEOF
import vapoursynth as vs
core = vs.core
clip = core.lsmas.LWLibavSource(source='${src_esc}')
clip = clip[${start}:${start}+${frames}]
clip = core.grain.Add(clip, var=${grain_var}, uvar=${grain_var}/2, seed=42)
clip = core.nlm_ispc.NLMeans(clip, d=1, a=2, s=4, h=${best_h}, channels='Y')
clip = core.nlm_ispc.NLMeans(clip, d=1, a=2, s=4, h=${best_h}*0.5, channels='UV')
clip.set_output()
VPYEOF

  av1an -i "$vpy_encode" -o "$encoded" \
    --temp "$tmpdir" \
    --encoder svt-av1 \
    --pix-format yuv420p \
    --workers 1 \
    --photon-noise "$pn" --chroma-noise \
    --video-params "--crf ${CRF} --preset ${SVT_PRESET} --film-grain 0 --film-grain-denoise 0" \
    2>/dev/null || { echo "0"; rm -f "$vpy_encode" "$encoded"; rm -rf "$tmpdir"; return; }

  rm -f "$vpy_encode"

  # Measure Laplacian sigma of the encoded+decoded output
  local encoded_esc=$(esc "$encoded")
  cat > "$vpy_measure" <<VPYEOF
import vapoursynth as vs
import sys, math
core = vs.core
clip = core.lsmas.LWLibavSource(source='${encoded_esc}')
luma = core.std.ShufflePlanes(clip, planes=0, colorfamily=vs.GRAY)
luma32 = core.resize.Point(luma, format=vs.GRAYS)
lap = core.std.Convolution(luma32, matrix=[1, -2, 1, -2, 4, -2, 1, -2, 1])
absLap = core.std.Expr(lap, expr=['x abs'])
stats = core.std.PlaneStats(absLap)

def emit(n, f):
    avg = f.props['PlaneStatsAverage']
    sigma = math.sqrt(math.pi / 2.0) * (1.0 / 6.0) * avg * 255.0
    sys.stderr.write('SIGMA:{:.6f}\n'.format(sigma))
    sys.stderr.flush()
    return f

out = core.std.ModifyFrame(stats, stats, emit)
out.set_output()
VPYEOF

  local output
  output=$(vspipe -p "$vpy_measure" -- 2>&1 || true)
  rm -f "$vpy_measure" "$encoded"
  rm -rf "$tmpdir"

  echo "$output" | grep -oP 'SIGMA:\K[\d.]+' | sort -n | awk '
    { vals[NR] = $1; n = NR }
    END {
      if (n == 0) { print 0; exit }
      mid = int((n+1)/2)
      if (n % 2 == 1) print vals[mid]
      else print (vals[mid] + vals[mid+1]) / 2
    }'
}

# ── Setup ───────────────────────────────────────────────────────────────

log "Source: $SOURCE"
log "Workdir: $WORKDIR"
log "Output: ${SOURCE_NAME}"

# Get total frames and pick a sample region from the middle
TOTAL_FRAMES=$(vspipe --info <(cat <<VPYEOF
import vapoursynth as vs
core = vs.core
clip = core.lsmas.LWLibavSource(source='$(esc "$SOURCE")')
clip.set_output()
VPYEOF
) - 2>&1 | grep -oP 'Frames: \K\d+' || echo "0")

if [ "$TOTAL_FRAMES" -lt "$((SAMPLE_FRAMES + 100))" ]; then
  log "ERROR: source too short ($TOTAL_FRAMES frames, need $((SAMPLE_FRAMES + 100))+)"
  exit 1
fi

START_FRAME=$(( TOTAL_FRAMES / 2 - SAMPLE_FRAMES / 2 ))
log "Using frames ${START_FRAME}-$((START_FRAME + SAMPLE_FRAMES)) of ${TOTAL_FRAMES}"

# Measure baseline sigma of clean source
BASELINE=$(measure_laplacian_sigma "$SOURCE" "$START_FRAME" "$SAMPLE_FRAMES" 0)
log "Baseline sigma (clean source): $BASELINE"
echo ""

# ── Phase 1: Measure Laplacian sigma for each AddGrain level ───────────

log "Phase 1: Measuring Laplacian sigma for each noise level"
echo "added_var,laplacian_sigma" > "$DENOISE_CSV"
echo "0,$BASELINE" >> "$DENOISE_CSV"

declare -A MEASURED_SIGMA

for sigma in "${SIGMAS[@]}"; do
  measured=$(measure_laplacian_sigma "$SOURCE" "$START_FRAME" "$SAMPLE_FRAMES" "$sigma")
  MEASURED_SIGMA[$sigma]="$measured"
  echo "${sigma},${measured}" >> "$DENOISE_CSV"
  log "  AddGrain var=${sigma} -> Laplacian sigma=${measured}"
done
echo ""

# ── Phase 2: Calibrate NLMeans h (ternary search on PSNR) ──────────────

log "Phase 2: Calibrating NLMeans h (ternary search)"
echo "" >> "$DENOISE_CSV"
echo "added_var,h,psnr" >> "$DENOISE_CSV"

declare -A BEST_H

for sigma in "${SIGMAS[@]}"; do
  log "--- AddGrain var=${sigma} (Laplacian sigma=${MEASURED_SIGMA[$sigma]}) ---"

  lo="$H_MIN"
  hi="$H_MAX"
  iterations=0

  while true; do
    range=$(awk "BEGIN { print $hi - $lo }")
    done_yet=$(awk "BEGIN { print ($range < $H_TOLERANCE) ? 1 : 0 }")
    if [ "$done_yet" = "1" ]; then break; fi

    m1=$(awk "BEGIN { printf \"%.2f\", $lo + ($hi - $lo) / 3 }")
    m2=$(awk "BEGIN { printf \"%.2f\", $hi - ($hi - $lo) / 3 }")

    p1=$(denoise_and_measure_psnr "$SOURCE" "$START_FRAME" "$SAMPLE_FRAMES" "$sigma" "$m1")
    p2=$(denoise_and_measure_psnr "$SOURCE" "$START_FRAME" "$SAMPLE_FRAMES" "$sigma" "$m2")

    echo "${sigma},${m1},${p1}" >> "$DENOISE_CSV"
    echo "${sigma},${m2},${p2}" >> "$DENOISE_CSV"
    log "  h=${m1} -> PSNR=${p1}  |  h=${m2} -> PSNR=${p2}"

    m1_better=$(awk "BEGIN { print ($p1 > $p2) ? 1 : 0 }")
    if [ "$m1_better" = "1" ]; then hi="$m2"; else lo="$m1"; fi
    iterations=$((iterations + 1))
  done

  best_h=$(awk "BEGIN { printf \"%.2f\", ($lo + $hi) / 2 }")
  best_psnr=$(denoise_and_measure_psnr "$SOURCE" "$START_FRAME" "$SAMPLE_FRAMES" "$sigma" "$best_h")
  echo "${sigma},${best_h},${best_psnr}" >> "$DENOISE_CSV"

  BEST_H[$sigma]="$best_h"
  log "  ** Best: h=${best_h} (PSNR=${best_psnr} dB) [${iterations} iters]"
  echo ""
done

log "Phase 2 complete"
echo ""

# ── Phase 3: Calibrate photon-noise (binary search) ────────────────────
#
# For each noise level: denoise optimally, encode with photon-noise N,
# decode, measure Laplacian sigma. Find N where output sigma matches
# the sigma of the original noisy source (before denoising).

log "Phase 3: Calibrating photon-noise (binary search)"
echo "added_var,noisy_sigma,photon_noise,output_sigma" > "$PHOTON_CSV"

declare -A BEST_PN

for sigma in "${SIGMAS[@]}"; do
  h="${BEST_H[$sigma]}"
  target="${MEASURED_SIGMA[$sigma]}"
  log "--- var=${sigma} (target sigma=${target}, NLMeans h=${h}) ---"

  lo="$PN_MIN"
  hi="$PN_MAX"
  best_pn="$lo"
  best_diff=999
  iterations=0

  while [ "$lo" -le "$hi" ]; do
    mid=$(( (lo + hi) / 2 ))

    measured=$(encode_and_measure_sigma "$SOURCE" "$START_FRAME" "$SAMPLE_FRAMES" "$sigma" "$h" "$mid")
    echo "${sigma},${target},${mid},${measured}" >> "$PHOTON_CSV"
    log "  pn=${mid} -> output sigma=${measured} (target=${target})"

    diff=$(awk "BEGIN { d = $measured - $target; print (d < 0 ? -d : d) }")
    is_closer=$(awk "BEGIN { print ($diff < $best_diff) ? 1 : 0 }")
    if [ "$is_closer" = "1" ]; then
      best_diff="$diff"
      best_pn="$mid"
    fi

    too_low=$(awk "BEGIN { print ($measured < $target) ? 1 : 0 }")
    if [ "$too_low" = "1" ]; then lo=$((mid + 1)); else hi=$((mid - 1)); fi
    iterations=$((iterations + 1))
  done

  BEST_PN[$sigma]="$best_pn"
  log "  ** Best: photon-noise=${best_pn} (diff=${best_diff}) [${iterations} iters]"
  echo ""
done

log "Phase 3 complete"
echo ""

# ── Summary ──────────────────────────────────────────────────────────────

log "Writing summary to $SUMMARY_CSV"
echo "added_var,laplacian_sigma,best_h,best_photon_noise" > "$SUMMARY_CSV"
for sigma in "${SIGMAS[@]}"; do
  echo "${sigma},${MEASURED_SIGMA[$sigma]},${BEST_H[$sigma]},${BEST_PN[$sigma]}" >> "$SUMMARY_CSV"
done

echo ""
echo "================================================================"
echo "  CALIBRATION RESULTS for: $SOURCE_NAME"
echo "  Baseline sigma: $BASELINE"
echo "================================================================"
echo ""
printf "%-10s %-16s %-10s %-14s\n" "AddGrain" "Laplacian sigma" "Best h" "Best pn"
printf "%-10s %-16s %-10s %-14s\n" "--------" "---------------" "------" "-------"
for sigma in "${SIGMAS[@]}"; do
  printf "%-10s %-16s %-10s %-14s\n" "$sigma" "${MEASURED_SIGMA[$sigma]}" "${BEST_H[$sigma]}" "${BEST_PN[$sigma]}"
done
echo ""
echo "================================================================"
echo "  Raw data saved to:"
echo "    $DENOISE_CSV"
echo "    $PHOTON_CSV"
echo "    $SUMMARY_CSV"
echo "================================================================"
