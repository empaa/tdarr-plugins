#!/bin/bash
# Speed probe for the AOM-vs-SVT rate-quality curve. Encodes a short segment with
# each candidate arm and reports fps, so the full curve can be sized before we
# commit hours of encoding to it. Runs INSIDE the node container.
#
# Written as a file and scp'd rather than passed through ssh -> docker -> bash -c,
# which mangles argv (docs/job5-environment.md). Uses awk rather than bc, which
# the Tdarr image does not ship, and derives the frame count from duration
# because matroska reports nb_frames=N/A.
set -u

WORK=/mnt/library/aomcurve
SECS=${SECS:-10}
SVT_PARAMS='tune=1:enable-variance-boost=1:enable-qm=1:qm-min=0:tf-strength=1:sharpness=1:tile-columns=1'

mkdir -p "$WORK/probe"

for clip in closeenc topgun; do
  SRC="$WORK/src/$clip.mkv"
  [ -f "$SRC" ] || { echo "MISSING $SRC"; continue; }

  DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$SRC")
  RATE=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate \
    -of csv=p=0 "$SRC")
  NB=$(awk -v d="$DUR" -v r="$RATE" 'BEGIN{split(r,a,"/"); printf "%d", d*a[1]/a[2]}')
  echo "SOURCE $clip dur=${DUR}s rate=$RATE frames=~$NB"

  for arm in aom_cu4 svt_p4 svt_p6; do
    OUT="$WORK/probe/$clip.$arm.mkv"
    rm -f "$OUT"
    T0=$(date +%s)
    case $arm in
      aom_cu4)
        ffmpeg -v error -y -t "$SECS" -i "$SRC" -map 0:v:0 -an -sn \
          -c:v libaom-av1 -crf 30 -b:v 0 -cpu-used 4 -row-mt 1 -tiles 2x1 \
          -threads 16 "$OUT" ;;
      svt_p4)
        ffmpeg -v error -y -t "$SECS" -i "$SRC" -map 0:v:0 -an -sn \
          -c:v libsvtav1 -crf 30 -preset 4 -svtav1-params "$SVT_PARAMS" "$OUT" ;;
      svt_p6)
        ffmpeg -v error -y -t "$SECS" -i "$SRC" -map 0:v:0 -an -sn \
          -c:v libsvtav1 -crf 30 -preset 6 -svtav1-params "$SVT_PARAMS" "$OUT" ;;
    esac
    RC=$?
    T1=$(date +%s)
    FRAMES=$(ffprobe -v error -select_streams v:0 -count_frames \
      -show_entries stream=nb_read_frames -of csv=p=0 "$OUT" 2>/dev/null)
    BYTES=$(stat -c %s "$OUT" 2>/dev/null || echo 0)
    awk -v c="$clip" -v a="$arm" -v f="${FRAMES:-0}" -v w="$((T1-T0))" \
        -v b="$BYTES" -v nb="$NB" -v rc="$RC" 'BEGIN{
      wall = (w < 1 ? 1 : w); fps = f / wall;
      printf "PROBE %-9s %-8s rc=%s frames=%-5s wall=%4ds fps=%6.2f bytes=%-10s full_clip=~%.1f min\n",
        c, a, rc, f, wall, fps, b, (fps > 0 ? nb / fps / 60 : -1);
    }'
  done
done
echo "PROBE COMPLETE"
