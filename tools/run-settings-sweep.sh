#!/usr/bin/env bash
# Research-driven settings sweep. Replaces the first param sweep, whose arms were
# derived from our own inherited flags and so could only ever re-litigate settings
# we already used.
#
#   bash run-settings-sweep.sh <xav-binary> <source.mkv> [tier...]
#
# WHY THE ARMS ARE WHAT THEY ARE
#
# Every arm below traces to docs/svt-av1-settings-research.md, which established
# that we ship MAINLINE SVT-AV1 v4.2.0 while our parameter set was a psy-FORK
# recipe applied to it. The arms test the specific claims that research made and
# our own measurements cannot yet confirm.
#
# MEASUREMENT VEHICLE, AND ITS CAVEAT
#
# The flags under test belong to the av1an path, but av1an targets VMAF, which is
# saturated at our operating point (every bake-off encode scored 99.05-99.96
# across a 4.4x bitrate range). It cannot compare at matched quality. So we use
# xav's SSIMULACRA2 target-quality search as the measuring instrument, against
# the MAINLINE xav build.
#
# Caveat to state in any write-up: that build is SVT v4.2.0-73-gfb0ed7e59, while
# production is v4.2.0 release. Close, not identical.
#
# WHAT XAV WILL NOT LET US TEST
#
# xav's validator rejects --keyint, --scm and --enable-overlays outright, so those
# three cannot be measured here at all:
#   --keyint / --scm     xav owns them; harmless, they are absent by design
#   --enable-overlays    CANNOT be tested through xav. Its removal rests on the
#                        upstream default being off and on it roughly doubling
#                        picture buffers (min_parent *= 2). If we want that
#                        measured, it needs an av1an run with RSS sampling, not
#                        this script.
set -uo pipefail

XAV="${1:?usage: run-settings-sweep.sh <xav-binary> <source.mkv> [tier...]}"
SRC="${2:?usage: run-settings-sweep.sh <xav-binary> <source.mkv> [tier...]}"
shift 2
TIERS=("$@")
[ ${#TIERS[@]} -eq 0 ] && TIERS=("mid" "top" "low")

IMG="${IMG:-ghcr.io/haveagitgat/tdarr:2.86.01}"
WORK="$(cd "$(dirname "$SRC")" && pwd)"; NAME="$(basename "$SRC")"; BASE="${NAME%.*}"
XAVNAME="$(basename "${XAV}" | tr -cd 'A-Za-z0-9_')"
RESULTS="${RESULTS:-${WORK}/settings-sweep-results.tsv}"

# Identical across every run compared on wall-clock. The cap is not optional.
WORKERS="${WORKERS:-2}"; VSHIP="${VSHIP:-1}"; MEMLIMIT="${MEMLIMIT:-16g}"
# 5-50 is TOO NARROW for easy content. On the Jurassic sample (mean CRF ~36.8)
# it pinned 2 chunks at the ceiling and landed ABOVE the target band (72.73 for a
# 72.3-72.7 target) -- i.e. it stopped measuring the encoder and started measuring
# the bound. 5-63 lands clean at 72.48 with zero pinned.
#
# Always read at_floor/at_ceiling per row rather than trusting the mean: a pinned
# run is a fixed-CRF encode wearing a target-quality costume.
CRF_RANGE="${CRF_RANGE:-5-63}"
CRF_LO="${CRF_RANGE%-*}"; CRF_HI="${CRF_RANGE#*-}"

# WARNING: `--sc-only` combined with `-t` prints FAIL regardless of whether the
# arguments are valid. Do not use that combination to preflight a CRF range --
# confirm against a known-good range first, or you will reject a good one.

tier_target() {
  case "$1" in
    low) echo "67.8-68.2" ;;
    mid) echo "72.3-72.7" ;;
    top) echo "84.8-85.2" ;;
    *)   echo "" ;;
  esac
}

# Current production set, minus what xav owns.
#
# HISTORY, because it matters for reading older result files: this carried
# `--qm-min 4` when the Avatar sweep and the first Jurassic launch ran. That
# sweep measured qm-min as monotonic in the other direction (0 beat 4 by
# 1.2-2.1%, 6 lost by 1.2-1.8%), so production reverted to 0 and this followed.
#
# Consequence: in result files written BEFORE 2026-08-13, `new_set` means
# qm-min 4 and `qm_min_0` is the winner. In files written after, `new_set`
# already IS qm-min 0 and the alternatives are qm_min_4 / qm_min_6. Check the
# `params` column rather than trusting the arm name across files.
NEW_SET="--preset 4 --tune 1 --enable-variance-boost 1 --enable-qm 1 --qm-min 0 --tf-strength 1 --sharpness 1 --tile-columns 1"

# The pre-cleanup set, minus what xav rejects. The before/after control.
LEGACY_SET="--preset 4 --tune 1 --enable-variance-boost 1 --variance-boost-strength 2 --variance-octile 6 --enable-qm 1 --qm-min 0 --qm-max 15 --chroma-qm-min 8 --chroma-qm-max 15 --tf-strength 1 --sharpness 1 --tile-columns 1"

# Each arm is a COMPLETE parameter string, not an override appended to a baseline.
# The first sweep appended overrides, which works only because SVT takes the last
# occurrence -- a silent dependency on argument-order semantics. Full strings mean
# each row says exactly what it ran.
#
# name<TAB>params
read -r -d '' VARIANTS <<EOF
new_set	${NEW_SET}
legacy_set	${LEGACY_SET}
bare_defaults	--preset 4
qm_min_4	${NEW_SET/--qm-min 0/--qm-min 4}
qm_min_6	${NEW_SET/--qm-min 0/--qm-min 6}
no_qm	${NEW_SET/--enable-qm 1 --qm-min 0/--enable-qm 0}
tune4	${NEW_SET/--tune 1/--tune 4}
tile_cols_0	${NEW_SET/--tile-columns 1/--tile-columns 0}
sharpness_2	${NEW_SET/--sharpness 1/--sharpness 2}
sharpness_0	${NEW_SET/--sharpness 1/--sharpness 0}
no_varboost	${NEW_SET/--enable-variance-boost 1/--enable-variance-boost 0}
tf_strength_3	${NEW_SET/--tf-strength 1/--tf-strength 3}
EOF

# NOTES ON SPECIFIC ARMS
#
# tune4          SSIMULACRA2-optimised and video-capable. Nobody in the community
#                has published a test of it for video, and it is the obvious fit
#                for an SSIMULACRA2 gate. BUT it SILENTLY OVERRIDES qm-min,
#                sharpness and variance-boost to qm 4/10, sharpness 7, strength 3,
#                curve 2 -- so this row is "tune 4's opinion" wholesale, not our
#                set with one knob moved. Read it that way.
# bare_defaults  Does ANY of our tuning beat stock mainline? Cheap, and if stock
#                wins the whole parameter discussion changes shape.
# tf_strength_3  Mainline's default. We override to 1 on JET's advice about tf
#                blocking; this checks what that override costs in bytes.
# sharpness_0/2  Sharpness is tier C -- asserted, never measured publicly. These
#                rows measure only the BYTE cost; whether 1 or 2 looks better is
#                not a question SSIMULACRA2 can answer. Do not conclude from a
#                small delta that sharpness "does nothing".

[ -f "${RESULTS}" ] || printf 'tier\tbinary\tvariant\texit\tseconds\tvideo_bytes\ttotal_bytes\tchunks\tmean_score\tmin_score\tmax_score\tmean_crf\tat_floor\tat_ceiling\tgeom\tverdict\tparams\tfinished_at\n' > "${RESULTS}"

echo "== xav settings sweep =="
echo "  binary  : ${XAV}"
echo "  source  : ${WORK}/${NAME}"
echo "  tiers   : ${TIERS[*]}"
echo "  results : ${RESULTS}"
echo

for TIER in "${TIERS[@]}"; do
  TQ="$(tier_target "${TIER}")"
  if [ -z "${TQ}" ]; then echo "!! unknown tier ${TIER}, skipping"; continue; fi

  while IFS=$'\t' read -r VNAME PARAMS; do
    [ -z "${VNAME}" ] && continue
    TAG="${XAVNAME}_${TIER}_${VNAME}"

    if grep -q "^${TIER}	${XAVNAME}	${VNAME}	" "${RESULTS}" 2>/dev/null; then
      echo "---- ${TAG} (already recorded, skipping)"; continue
    fi

    OUT="out_ss_${TAG}.mkv"
    echo "---- ${TAG}  target=${TQ}"
    echo "     ${PARAMS}"

    LINE=$(docker run --rm --gpus all \
      --memory="${MEMLIMIT}" --memory-swap="${MEMLIMIT}" \
      -e NVIDIA_DRIVER_CAPABILITIES=all \
      --security-opt seccomp=unconfined \
      -v "${XAV}:/usr/local/bin/xav:ro" \
      -v "${WORK}:/work" -w /work \
      --entrypoint bash "${IMG}" -c "
        rm -f /work/${OUT} /work/${BASE}.json
        for d in /work/.???????; do [ -w \"\$d\" ] && rm -rf \"\$d\"; done 2>/dev/null
        t0=\$(date +%s%N)
        script -qec \"/usr/local/bin/xav /work/${NAME} /work/${OUT} -w ${WORKERS} -v ${VSHIP} -t ${TQ} -f ${CRF_RANGE} -p '${PARAMS}'\" /dev/null > /work/.xavlog_ss_${TAG} 2>&1
        rc=\$?; t1=\$(date +%s%N)
        secs=\$(( (t1 - t0) / 1000000000 ))
        tot=\$(stat -c%s /work/${OUT} 2>/dev/null || echo 0)
        vb=\$(ffprobe -v error -select_streams v:0 -show_entries packet=size -of csv=p=0 /work/${OUT} 2>/dev/null | awk '{s+=\$1} END{print s+0}')
        geom=\$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 /work/${OUT} 2>/dev/null | tr -d '\n')
        cp -f /work/${BASE}.json /work/${BASE}_ss_${TAG}.json 2>/dev/null
        stats=\$(grep -oE '\"final\": \{ \"crf\": [0-9.]+, \"score\": [0-9.]+' /work/${BASE}.json 2>/dev/null \
                 | sed -E 's/.*crf\": ([0-9.]+), \"score\": ([0-9.]+)/\1 \2/' \
                 | awk -v lo=${CRF_LO} -v hi=${CRF_HI} '{ct+=\$1; st+=\$2; if(NR==1||\$2<mn)mn=\$2; if(NR==1||\$2>mx)mx=\$2; if(\$1<=lo+0.001)fl++; if(\$1>=hi-0.001)ce++} END{if(NR)printf \"%d\t%.2f\t%.2f\t%.2f\t%.2f\t%d\t%d\", NR, st/NR, mn, mx, ct/NR, fl+0, ce+0; else printf \"0\t0\t0\t0\t0\t0\t0\"}')
        printf '%s\t%s\t%s\t%s\t%s\t%s\n' \"\$rc\" \"\$secs\" \"\$vb\" \"\$tot\" \"\$stats\" \"\$geom\"
      " 2>/dev/null | tail -1)

    RC=$(echo "${LINE}" | cut -f1);      SECS=$(echo "${LINE}" | cut -f2)
    VB=$(echo "${LINE}" | cut -f3);      TOT=$(echo "${LINE}" | cut -f4)
    CHUNKS=$(echo "${LINE}" | cut -f5);  MEAN=$(echo "${LINE}" | cut -f6)
    MINS=$(echo "${LINE}" | cut -f7);    MAXS=$(echo "${LINE}" | cut -f8)
    MCRF=$(echo "${LINE}" | cut -f9);    FLOOR=$(echo "${LINE}" | cut -f10)
    CEIL=$(echo "${LINE}" | cut -f11);   GEOM=$(echo "${LINE}" | cut -f12)

    VERDICT="ok"
    [ "${RC:-1}" != "0" ] && VERDICT="FAILED"
    [ "${VB:-0}" = "0" ] && VERDICT="FAILED"
    if [ "${VERDICT}" = "ok" ] && [ "${CHUNKS:-0}" != "0" ]; then
      [ "${FLOOR:-0}" = "${CHUNKS}" ] && VERDICT="INVALID_pinned_floor"
      [ "${CEIL:-0}" = "${CHUNKS}" ] && VERDICT="INVALID_pinned_ceiling"
    fi

    # finished_at is appended LAST so files written by older versions of this
    # script stay parseable and the resume grep (leading columns) is unaffected.
    # Without it, identifying rows affected by external CPU contention needs log
    # forensics -- which is exactly what a contaminated run cost us on 2026-08-13.
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "${TIER}" "${XAVNAME}" "${VNAME}" "${RC:-?}" "${SECS:-0}" "${VB:-0}" "${TOT:-0}" \
      "${CHUNKS:-0}" "${MEAN:-0}" "${MINS:-0}" "${MAXS:-0}" "${MCRF:-0}" \
      "${FLOOR:-0}" "${CEIL:-0}" "${GEOM:-}" "${VERDICT}" "${PARAMS}" \
      "$(date -Iseconds)" >> "${RESULTS}"

    echo "     exit=${RC:-?} ${SECS:-0}s  video=${VB:-0}  score=${MEAN:-0}  crf=${MCRF:-0}  ${VERDICT}"
    rm -f "${WORK}/${OUT}"
    echo
  done <<< "${VARIANTS}"
done

echo "== sweep complete =="
column -t -s$'\t' "${RESULTS}" 2>/dev/null || cat "${RESULTS}"
