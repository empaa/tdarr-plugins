#!/bin/bash
# Fixed-CRF rate-quality curve: AOM vs SVT-AV1, scored with FFVship.
#
# WHY FIXED CRF. Every AOM-vs-SVT number we had came through a target-quality
# search, and those searches do not reproduce -- closeenc scored 74.88 then
# 70.43 on identical settings, with bytes moving the WRONG WAY. A codec
# comparison drawn through that measures the search, not the codec. Fixed CRF,
# single pass, no chunking is deterministic.
#
# Emits one TSV row per (clip, arm, crf). Compare by reading bytes at a matched
# SSIMULACRA2 off the two curves. Do NOT compare rows at equal CRF: the CRF
# scales of libaom and SVT-AV1 are unrelated and matching them proves nothing.
#
# WALL_S/FPS ARE NOT A SPEED BENCHMARK when JOBS>1 -- points contend for cores.
# libaom is effectively single-threaded per instance, so its real-world speed
# comes from running chunks in parallel (which is how av1an got 681s and how a
# forked xav would run it), not from -threads. Take speed from a dedicated
# single-instance run: tools/aom-curve-probe.sh.
#
# Runs INSIDE the node container. scp'd as a file: nested ssh -> docker -> bash -c
# mangles argv (docs/job5-environment.md).
set -u

WORK=/mnt/library/aomcurve
OUT=${OUT:-$WORK/curve.tsv}
FRAMES=${FRAMES:-1440}       # 0 = whole clip; otherwise exactly N frames from the start
CLIPS=${CLIPS:-"closeenc topgun"}
ARMS=${ARMS:-"aom_cu4 aom_cu4_tuned svt_p4 svt_p6"}
CRFS=${CRFS:-"6 10 14 18"}
JOBS=${JOBS:-4}              # concurrent encodes; 32 threads on this host

# The researched mainline set (src/shared/xav.js MAINLINE_PARAMS). Both sources
# are 8-bit yuv420p, which is exactly the case that ships mainline+tuned, so the
# SVT arms carry it -- benchmarking AOM against stock SVT would be measuring a
# configuration we have already decided not to ship.
SVT_PARAMS='tune=1:enable-variance-boost=1:enable-qm=1:qm-min=0:tf-strength=1:sharpness=1:tile-columns=1'

# AOM's answer to that set, flag for flag where an analogue exists:
#   enable-qm/qm-min 0   <- the strongest cross-source SVT finding
#   deltaq-mode=6        <- libaom's Variance Boost, analogue of enable-variance-boost
#   sharpness=1          <- direct analogue
#   -tune 1 (ssim)       <- perceptual rather than libaom's default psnr
# Without this arm a loss is attributable to under-tuning AOM rather than to AOM.
AOM_TUNED='-tune 1 -aom-params enable-qm=1:qm-min=0:deltaq-mode=6:enable-chroma-deltaq=1:sharpness=1'

FFVSHIP=/opt/xav/ffvship/FFVship

mkdir -p "$WORK/out"
[ -f "$OUT" ] || printf 'clip\tarm\tcrf\tframes\twall_s\tfps\tbytes\toffset\tssimu2_mean\tssimu2_5pct\tssimu2_min\n' > "$OUT"

# --help exits 1 by design; --list-gpu is the health check that exits 0.
$FFVSHIP --list-gpu >/dev/null 2>&1 || { echo "FATAL: FFVship not healthy" >&2; exit 1; }

# Frame alignment is per-file and MUST be measured, not assumed: an off-by-one
# pair scores large and negative, and the wrong crop scores plausible but wrong.
# closeenc needs -1 and topgun needs 0 on the same command, so a hardcoded table
# is a bug waiting to happen. Probe a cheap prefix at each candidate offset and
# keep the best; if even the best is absurd, something other than alignment is
# wrong, so refuse to emit a number rather than record a confident lie.
detect_offset() {
  local src=$1 enc=$2 best_off="" best_mean=-9999 m
  for off in 0 -1 1; do
    m=$($FFVSHIP -s "$src" -e "$enc" -m SSIMULACRA2 --end 48 --encoded-offset $off 2>/dev/null \
        | awk '/Average/{print $3}')
    [ -z "$m" ] && continue
    awk -v a="$m" -v b="$best_mean" 'BEGIN{exit !(a>b)}' && { best_mean=$m; best_off=$off; }
  done
  awk -v m="$best_mean" 'BEGIN{exit !(m>0)}' || { echo "BAD"; return; }
  echo "$best_off"
}

run_point() {
  local clip=$1 arm=$2 crf=$3
  local SRC="$WORK/src/$clip.mkv"
  local OUTF="$WORK/out/$clip.$arm.crf$crf.mkv"
  local JSON="$WORK/out/$clip.$arm.crf$crf.json"
  rm -f "$OUTF" "$JSON"

  local LIMIT="" END=""
  if [ "$FRAMES" != "0" ]; then LIMIT="-frames:v $FRAMES"; END="--end $FRAMES"; fi

  local T0 T1 RC
  T0=$(date +%s)
  case $arm in
    # -b:v 0 is required for true constant quality; without it libaom runs
    # constrained-quality and this is not a CRF curve at all.
    aom_cu4)
      ffmpeg -v error -y -i "$SRC" -map 0:v:0 -an -sn $LIMIT \
        -c:v libaom-av1 -crf "$crf" -b:v 0 -cpu-used 4 -row-mt 1 \
        -tiles 2x1 -threads 8 "$OUTF" ;;
    aom_cu4_tuned)
      ffmpeg -v error -y -i "$SRC" -map 0:v:0 -an -sn $LIMIT \
        -c:v libaom-av1 -crf "$crf" -b:v 0 -cpu-used 4 -row-mt 1 \
        -tiles 2x1 -threads 8 $AOM_TUNED "$OUTF" ;;
    svt_p4)
      ffmpeg -v error -y -i "$SRC" -map 0:v:0 -an -sn $LIMIT \
        -c:v libsvtav1 -crf "$crf" -preset 4 -svtav1-params "$SVT_PARAMS" "$OUTF" 2>/dev/null ;;
    svt_p6)
      ffmpeg -v error -y -i "$SRC" -map 0:v:0 -an -sn $LIMIT \
        -c:v libsvtav1 -crf "$crf" -preset 6 -svtav1-params "$SVT_PARAMS" "$OUTF" 2>/dev/null ;;
  esac
  RC=$?
  T1=$(date +%s)

  if [ $RC -ne 0 ] || [ ! -s "$OUTF" ]; then
    printf '%s\t%s\t%s\tENCODE_FAILED\trc=%s\n' "$clip" "$arm" "$crf" "$RC" >> "$OUT"
    return
  fi

  local NF BYTES OFF
  NF=$(ffprobe -v error -select_streams v:0 -count_frames \
    -show_entries stream=nb_read_frames -of csv=p=0 "$OUTF")
  BYTES=$(stat -c %s "$OUTF")

  OFF=$(detect_offset "$SRC" "$OUTF")
  if [ "$OFF" = "BAD" ]; then
    printf '%s\t%s\t%s\t%s\t%d\t\t%s\tUNALIGNED\tNA\tNA\tNA\n' \
      "$clip" "$arm" "$crf" "$NF" "$((T1-T0))" "$BYTES" >> "$OUT"
    return
  fi

  $FFVSHIP -s "$SRC" -e "$OUTF" -m SSIMULACRA2 --encoded-offset "$OFF" \
    $END --json "$JSON" >/dev/null 2>&1

  # Mean is what a tier targets. 5th percentile and min are where a codec that
  # averages well but collapses on hard frames gets caught -- that is the entire
  # argument for a quality-first tier, so it has to be measured, not assumed.
  local MEAN P5 MIN
  read -r MEAN P5 MIN <<EOF
$(python3 - "$JSON" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print("NA NA NA"); raise SystemExit
def flat(x):
    if isinstance(x, (int, float)): yield float(x)
    elif isinstance(x, list):
        for i in x: yield from flat(i)
    elif isinstance(x, dict):
        for i in x.values(): yield from flat(i)
v = sorted(flat(d))
print("NA NA NA" if not v else
      "%.3f %.3f %.3f" % (sum(v)/len(v), v[max(0, int(len(v)*0.05)-1)], v[0]))
PY
)
EOF

  awk -v c="$clip" -v a="$arm" -v r="$crf" -v f="$NF" -v w="$((T1-T0))" \
      -v b="$BYTES" -v o="$OFF" -v m="$MEAN" -v p="$P5" -v mn="$MIN" 'BEGIN{
    wall = (w < 1 ? 1 : w);
    printf "%s\t%s\t%s\t%s\t%d\t%.2f\t%s\t%s\t%s\t%s\t%s\n", c,a,r,f,wall,f/wall,b,o,m,p,mn;
  }' >> "$OUT"
  echo "done $clip $arm crf$crf -> $MEAN (5pct $P5, offset $OFF)"
}

for clip in $CLIPS; do
  [ -f "$WORK/src/$clip.mkv" ] || { echo "MISSING $clip" >&2; continue; }
  for arm in $ARMS; do
    for crf in $CRFS; do
      run_point "$clip" "$arm" "$crf" &
      while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do wait -n; done
    done
  done
done
wait
echo "CURVE COMPLETE"
