#!/usr/bin/env bash
# Encoder-parameter research sweep for xav.
#
#   bash run-param-sweep.sh <xav-binary> <source.mkv> [tier...]
#
# OBJECTIVE -- read this before changing anything.
#
# This is NOT a hunt for "better quality". Under a quality target the encoder
# lands on the target regardless; a faster preset simply spends more bits to get
# there. The thing being optimised is BYTES AT MATCHED QUALITY PER UNIT TIME --
# a rate/time frontier, with quality pinned as a constraint rather than read as
# an output.
#
# So every run below targets an achieved SSIMULACRA2 band and we compare the
# bytes and the wall-clock it took to land there. A variant that produces a
# smaller file at the same score is better. A variant that produces the same
# file faster is better. Anything that lands outside its target band, or pins at
# a CRF bound, measured nothing and is reported as INVALID.
#
# DESIGN: one-factor-at-a-time from a baseline (our current production av1an
# SVT-AV1 params, minus the rate control that TQ now owns). Full factorial is
# untenable at ~3-5 min per run; OFAT finds the axes that carry the gain and is
# what the follow-up confirm run should combine.
#
# Results are appended to a TSV after EVERY run, so a kill at hour three still
# leaves everything up to that point. Re-running skips rows already present.
set -uo pipefail

XAV="${1:?usage: run-param-sweep.sh <xav-binary> <source.mkv> [tier...]}"
SRC="${2:?usage: run-param-sweep.sh <xav-binary> <source.mkv> [tier...]}"
shift 2
TIERS=("$@")
[ ${#TIERS[@]} -eq 0 ] && TIERS=("mid" "top" "low")

IMG="${IMG:-ghcr.io/haveagitgat/tdarr:2.86.01}"
WORK="$(cd "$(dirname "$SRC")" && pwd)"; NAME="$(basename "$SRC")"; BASE="${NAME%.*}"
XAVNAME="$(basename "${XAV}" | tr -cd 'A-Za-z0-9_')"
RESULTS="${RESULTS:-${WORK}/param-sweep-results.tsv}"

# Memory: keep IDENTICAL across every run compared on wall-clock. -w 2 -v 1 with
# xav's default buffering fits comfortably under 16g; -b 4 took peak RSS past
# 25 GB and tripped a 24g cap. The cap is not optional -- uncapped xav drove this
# host into global OOM and the kernel killed the workstation VM's qemu process.
WORKERS="${WORKERS:-2}"; VSHIP="${VSHIP:-1}"; MEMLIMIT="${MEMLIMIT:-16g}"

# CRF range wide enough that the search always has somewhere to go. A run that
# pins at either bound is a fixed-CRF encode wearing a target-quality costume.
CRF_RANGE="${CRF_RANGE:-5-50}"
CRF_LO="${CRF_RANGE%-*}"; CRF_HI="${CRF_RANGE#*-}"

# Tier targets, from measurement rather than taste:
#   low  68  -- where av1an AOM actually landed on Avatar (68.15)
#   mid  72.5 -- parity with the current av1an SVT tier (72.46)
#   top  85  -- solidly inside the "high" band (90+ = visually lossless)
tier_target() {
  case "$1" in
    low) echo "67.8-68.2" ;;
    mid) echo "72.3-72.7" ;;
    top) echo "84.8-85.2" ;;
    *)   echo "" ;;
  esac
}

# Baseline = current production av1an SVT flags, minus --crf/--rc (TQ owns rate)
# and --scd (xav owns scene detection).
#
# 2026-08-12 (hometower): five more of the production flags are HARD-REJECTED by
# xav's own validator (src/svterr.rs) -- it aborts with "argument parsing failed"
# before encoding anything, so the first launch produced 40 consecutive FAILED
# rows in 20 seconds. Removed, with xav's stated reason:
#   --input-depth 10    xav only ever encodes yuv420p10le; setting it is an error
#   --lookahead 48      svt-av1 locks lookahead internally; xav says remove it
#   --keyint -1         xav sets keyint itself (chunk starts ARE keyframes)
#   --irefresh-type 2   on xav's NOT_RELEVANT list
#   --enable-overlays 1 xav rejects overlays as "always dangerous" with svt-av1
#   --scm 0             "XAV already disables SCM by default; duplication not needed"
# That is itself a portability finding for the plugin: an av1an param string
# cannot be handed to xav unfiltered.
#
# Every variant below was parse-validated against BOTH binaries with --sc-only
# before this sweep was launched; all 10 are accepted by both.
BASELINE="--preset 4 --tune 1 --enable-variance-boost 1 --variance-boost-strength 2 --variance-octile 6 --enable-qm 1 --qm-min 0 --qm-max 15 --chroma-qm-min 8 --chroma-qm-max 15 --tf-strength 1 --sharpness 1 --tile-columns 1"

# OFAT variants. Name<TAB>params. Each differs from baseline on ONE axis.
# Params unsupported by a given fork make xav fail; that is recorded as FAILED
# and the sweep continues -- which is itself a finding about fork portability.
read -r -d '' VARIANTS <<'EOF'
baseline
preset2	--preset 2
preset6	--preset 6
tune0	--tune 0
tune2	--tune 2
no_varboost	--enable-variance-boost 0
varboost_s3	--variance-boost-strength 3
varboost_oct4	--variance-octile 4
no_qm	--enable-qm 0
no_psy	--tf-strength 0 --sharpness 0
EOF
# NOTE: the former 'lookahead_def --lookahead -1' variant was removed -- xav
# rejects --lookahead outright (see BASELINE comment), so that axis does not
# exist under xav and the variant could only ever have recorded FAILED.

# Apply an override on top of baseline: later occurrences of a key win, so we
# simply append. aomenc/SVT both take the last occurrence.
apply_override() {
  local base="$1" ovr="$2"
  [ -z "${ovr}" ] && { echo "${base}"; return; }
  echo "${base} ${ovr}"
}

[ -f "${RESULTS}" ] || printf 'tier\tbinary\tvariant\texit\tseconds\tvideo_bytes\ttotal_bytes\tchunks\tmean_score\tmin_score\tmax_score\tmean_crf\tat_floor\tat_ceiling\tgeom\tverdict\tparams\n' > "${RESULTS}"

echo "== xav parameter sweep =="
echo "  binary  : ${XAV}"
echo "  source  : ${WORK}/${NAME}"
echo "  tiers   : ${TIERS[*]}"
echo "  crf rng : ${CRF_RANGE}   workers=${WORKERS} vship=${VSHIP} mem=${MEMLIMIT}"
echo "  results : ${RESULTS}"
echo

for TIER in "${TIERS[@]}"; do
  TQ="$(tier_target "${TIER}")"
  if [ -z "${TQ}" ]; then echo "!! unknown tier ${TIER}, skipping"; continue; fi

  while IFS=$'\t' read -r VNAME VPARAMS; do
    [ -z "${VNAME}" ] && continue
    TAG="${XAVNAME}_${TIER}_${VNAME}"

    if grep -q "^${TIER}	${XAVNAME}	${VNAME}	" "${RESULTS}" 2>/dev/null; then
      echo "---- ${TAG} (already recorded, skipping)"
      continue
    fi

    PARAMS="$(apply_override "${BASELINE}" "${VPARAMS}")"
    OUT="out_ps_${TAG}.mkv"
    echo "---- ${TAG}  target=${TQ}"
    echo "     ${PARAMS}"

    # No -a: video-only, so bytes are comparable and no Opus is encoded that we
    # would only discard. Sources for this sweep are video-only anyway.
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
        script -qec \"/usr/local/bin/xav /work/${NAME} /work/${OUT} -w ${WORKERS} -v ${VSHIP} -t ${TQ} -f ${CRF_RANGE} -p '${PARAMS}'\" /dev/null > /work/.xavlog_ps_${TAG} 2>&1
        rc=\$?; t1=\$(date +%s%N)
        secs=\$(( (t1 - t0) / 1000000000 ))
        tot=\$(stat -c%s /work/${OUT} 2>/dev/null || echo 0)
        vb=\$(ffprobe -v error -select_streams v:0 -show_entries packet=size -of csv=p=0 /work/${OUT} 2>/dev/null | awk '{s+=\$1} END{print s+0}')
        geom=\$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 /work/${OUT} 2>/dev/null | tr -d '\n')
        cp -f /work/${BASE}.json /work/${BASE}_ps_${TAG}.json 2>/dev/null
        stats=\$(grep -oE '\"final\": \{ \"crf\": [0-9.]+, \"score\": [0-9.]+' /work/${BASE}.json 2>/dev/null \
                 | sed -E 's/.*crf\": ([0-9.]+), \"score\": ([0-9.]+)/\1 \2/' \
                 | awk -v lo=${CRF_LO} -v hi=${CRF_HI} '{ct+=\$1; st+=\$2; if(NR==1||\$2<mn)mn=\$2; if(NR==1||\$2>mx)mx=\$2; if(\$1<=lo+0.001)fl++; if(\$1>=hi-0.001)ce++} END{if(NR)printf \"%d\t%.2f\t%.2f\t%.2f\t%.2f\t%d\t%d\", NR, st/NR, mn, mx, ct/NR, fl+0, ce+0; else printf \"0\t0\t0\t0\t0\t0\t0\"}')
        printf '%s\t%s\t%s\t%s\t%s\t%s\n' \"\$rc\" \"\$secs\" \"\$vb\" \"\$tot\" \"\$stats\" \"\$geom\"
      " 2>/dev/null | tail -1)

    RC=$(echo "${LINE}" | cut -f1)
    SECS=$(echo "${LINE}" | cut -f2)
    VB=$(echo "${LINE}" | cut -f3)
    TOT=$(echo "${LINE}" | cut -f4)
    CHUNKS=$(echo "${LINE}" | cut -f5)
    MEAN=$(echo "${LINE}" | cut -f6)
    MINS=$(echo "${LINE}" | cut -f7)
    MAXS=$(echo "${LINE}" | cut -f8)
    MCRF=$(echo "${LINE}" | cut -f9)
    FLOOR=$(echo "${LINE}" | cut -f10)
    CEIL=$(echo "${LINE}" | cut -f11)
    GEOM=$(echo "${LINE}" | cut -f12)

    # A run is only comparable if it converged and did not pin.
    VERDICT="ok"
    [ "${RC:-1}" != "0" ] && VERDICT="FAILED"
    [ "${VB:-0}" = "0" ] && VERDICT="FAILED"
    if [ "${VERDICT}" = "ok" ] && [ "${CHUNKS:-0}" != "0" ]; then
      [ "${FLOOR:-0}" = "${CHUNKS}" ] && VERDICT="INVALID_pinned_floor"
      [ "${CEIL:-0}" = "${CHUNKS}" ] && VERDICT="INVALID_pinned_ceiling"
    fi

    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "${TIER}" "${XAVNAME}" "${VNAME}" "${RC:-?}" "${SECS:-0}" "${VB:-0}" "${TOT:-0}" \
      "${CHUNKS:-0}" "${MEAN:-0}" "${MINS:-0}" "${MAXS:-0}" "${MCRF:-0}" \
      "${FLOOR:-0}" "${CEIL:-0}" "${GEOM:-}" "${VERDICT}" "${PARAMS}" >> "${RESULTS}"

    echo "     exit=${RC:-?} ${SECS:-0}s  video=${VB:-0}  score=${MEAN:-0} (min ${MINS:-0})  crf=${MCRF:-0}  ${VERDICT}"
    rm -f "${WORK}/${OUT}"
    echo
  done <<< "${VARIANTS}"
done

echo "== sweep complete =="
column -t -s$'\t' "${RESULTS}" 2>/dev/null || cat "${RESULTS}"
