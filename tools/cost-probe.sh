#!/usr/bin/env bash
# Content cost probe -- a grain/texture proxy that sidesteps the problem we
# already proved unsolvable.
#
#   bash cost-probe.sh <source> [windows] [seconds-per-window] [crf]
#
# BACKGROUND: WHY NOT MEASURE NOISE DIRECTLY
#
# We built noise estimation once and reverted it (commit b1ff86c, "noise
# estimation unsolved"). The archived finding: no automated metric distinguishes
# fine texture from noise without a clean ground-truth reference -- a known
# unsolved blind-image-processing problem. Spatial methods read clean textured
# content as noisy; temporal differencing reads motion as noise; MVTools
# compensation residuals on complex content are the same magnitude as film
# grain. Do not re-attempt sigma estimation. This script deliberately does not.
#
# WHAT THIS MEASURES INSTEAD
#
# Not "is it grainy" but "is it expensive" -- bits per pixel at a FIXED CRF.
# That is the property that actually drives parameter choice, and it is directly
# measurable rather than inferred.
#
# THE ONE DESIGN DECISION THAT MATTERS: MINIMUM, NOT MEAN
#
# Bits/pixel conflates grain with motion and scene complexity -- the same
# confound family that sank the old approach. The fix is to take the MINIMUM
# across windows sampled uniformly through the film, not the mean.
#
# Rationale: motion is intermittent, grain is everywhere. A clean film has cheap
# static scenes, so its minimum is very low. A grainy film has NO cheap scenes,
# because grain is temporally uncorrelated noise that defeats inter prediction
# even on a locked-off shot -- so its minimum stays high. The minimum is a cost
# FLOOR, and the floor is where grain shows up unmixed with motion.
#
# Note this needs no motion measurement of its own, which avoids the circularity
# of "measure motion to find static scenes, when grain inflates the motion
# metric".
#
# OUTPUT: one TSV line -- min / p10 / median / max bits-per-pixel-per-frame, plus
# the per-window values. The MIN is the intended discriminator; the others are
# for calibration and sanity.
#
# STATUS 2026-08-13: NOT NEEDED FOR PARAMETER SELECTION. PREMISE STILL UNVALIDATED.
#
# The motivation for this script was routing grainy vs clean content to different
# encoder settings. The grain sweep removed that motivation: the same parameter
# set wins on both a clean digital source and a 35mm-era one, at every tier. There
# are no different settings to route to, so no classifier is required. Calibration
# was cancelled rather than run.
#
# It stays in the tree because two live use cases would justify calibrating it,
# both with clearer success criteria than the original: predicting ENCODE TIME for
# scheduling, and picking a quality TIER per title. Neither is scoped yet.
#
# The measurement notes below remain accurate and are why a threshold must not be
# set from the two samples we have.
#
# First run on our two samples came out INVERTED -- the grainy 35mm source
# probed 3-5x CHEAPER than the clean digital one, at CRF 12, 22 and 30 alike:
#
#   CRF 12   avatar (clean)  min 0.232  median 0.421
#            jurassic (grain) min 0.050  median 0.101
#   CRF 22   avatar          min 0.089  median 0.193
#            jurassic        min 0.014  median 0.046
#
# Ruled out along the way: CRF regime (ratio is stable across 12/22/30, so the
# encoder is not simply quantising grain away at high CRF) and the encoder's own
# temporal filter (enable-tf=0 moved jurassic 0.040 -> 0.050 and avatar not at
# all, so TF is not denoising the signal away).
#
# The actual problem is that THE COMPARISON IS CONFOUNDED. The Avatar sample was
# deliberately selected as the busiest sustained-motion 120s window in the film;
# the Jurassic excerpt is an arbitrary 300s. At t=60s they measure 1.386 vs
# 0.040 bpp -- 34x -- which is a content difference, not a grain difference.
# These two samples cannot answer the question, in either direction.
#
# So the cost-floor hypothesis is UNTESTED, not disproven. Calibration needs
# several titles sampled by ONE uniform rule, spanning eras, with known-grainy
# and known-clean examples treated identically. Two points cannot define a
# threshold regardless.
#
# ONE REFINEMENT WORTH TESTING during calibration: the CRF-RESPONSE SLOPE rather
# than absolute cost. Grain is high-frequency and should be discarded faster as
# CRF rises, so a grainy source's cost should fall more steeply. Being a ratio,
# it self-normalises against motion and scene complexity -- exactly the confound
# above. Weak supporting hint in the data (min falls 4.5x for avatar vs 7.1x for
# jurassic across CRF 12->30) but the medians disagree, so this is a hypothesis
# to test, not a finding.
set -uo pipefail

# MANDATORY. Under a non-English locale awk's printf emits a decimal COMMA
# ("9,67"), which ffmpeg rejects as a seek time -- every probe window then fails
# with no useful error. This VM is sv_SE, so the bug is not hypothetical.
export LC_ALL=C

SRC="${1:?usage: cost-probe.sh <source> [windows] [secs] [crf]}"
WINDOWS="${2:-8}"
SECS="${3:-2}"
CRF="${4:-30}"

FFMPEG="${FFMPEG:-ffmpeg}"
FFPROBE="${FFPROBE:-ffprobe}"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

read -r W H DUR < <("${FFPROBE}" -v error -select_streams v:0 \
  -show_entries stream=width,height:format=duration \
  -of default=nw=1:nk=1 "${SRC}" | paste -sd' ' -)

if [ -z "${W:-}" ] || [ -z "${DUR:-}" ]; then
  echo "ERROR: could not probe ${SRC}" >&2; exit 1
fi

# Sample uniformly, skipping the first and last 8% -- logos, fades to black and
# credits are anomalously cheap and would drag the minimum down on any source.
START=$(awk -v d="${DUR}" 'BEGIN{printf "%.2f", d*0.08}')
END=$(awk -v d="${DUR}" 'BEGIN{printf "%.2f", d*0.92}')
SPAN=$(awk -v a="${START}" -v b="${END}" 'BEGIN{printf "%.2f", b-a}')

vals=()
for i in $(seq 0 $((WINDOWS - 1))); do
  T=$(awk -v s="${START}" -v sp="${SPAN}" -v i="${i}" -v n="${WINDOWS}" \
        'BEGIN{printf "%.2f", s + sp*i/(n>1?n-1:1)}')
  OUT="${TMP}/w${i}.mkv"

  # Fixed CRF, video only, fast preset. Absolute settings are irrelevant as long
  # as they are IDENTICAL across every source being compared -- this is a
  # relative measure.
  "${FFMPEG}" -v error -y -ss "${T}" -t "${SECS}" -i "${SRC}" \
    -an -sn -dn -c:v libsvtav1 -preset 8 -crf "${CRF}" \
    -svtav1-params "rc=0" -pix_fmt yuv420p10le "${OUT}" 2>/dev/null

  BYTES=$(stat -c%s "${OUT}" 2>/dev/null || echo 0)
  FRAMES=$("${FFPROBE}" -v error -select_streams v:0 -count_frames \
    -show_entries stream=nb_read_frames -of default=nw=1:nk=1 "${OUT}" 2>/dev/null || echo 0)

  if [ "${FRAMES:-0}" -gt 0 ] && [ "${BYTES:-0}" -gt 0 ]; then
    BPP=$(awk -v b="${BYTES}" -v f="${FRAMES}" -v w="${W}" -v h="${H}" \
            'BEGIN{printf "%.5f", (b*8)/(f*w*h)}')
    vals+=("${BPP}")
    printf 'window\t%d\t%.2fs\t%s bpp\n' "${i}" "${T}" "${BPP}" >&2
  else
    printf 'window\t%d\t%.2fs\tFAILED\n' "${i}" "${T}" >&2
  fi
done

if [ ${#vals[@]} -eq 0 ]; then
  echo "ERROR: every probe window failed for ${SRC}" >&2; exit 1
fi

printf '%s\n' "${vals[@]}" | sort -n | awk -v src="$(basename "${SRC}")" -v n="${#vals[@]}" '
  {a[NR]=$1}
  END{
    p10 = a[int(NR*0.1)+((NR*0.1)==int(NR*0.1)?0:1)]
    med = (NR%2) ? a[(NR+1)/2] : (a[NR/2]+a[NR/2+1])/2
    printf "%s\t%d\t%.5f\t%.5f\t%.5f\t%.5f\n", src, n, a[1], p10, med, a[NR]
  }'
