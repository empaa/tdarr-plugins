#!/usr/bin/env bash
# Cut the busiest sustained 120s from the existing 300s Jurassic excerpt, using the
# same selection principle applied to the Avatar sample: maximise sustained motion,
# and explicitly reject windows containing static stretches.
#
# Motion proxy: mean luma of the frame-to-frame difference image (tblend=difference
# -> signalstats YAVG), computed on a 480px downscale for speed. Per-frame values are
# aggregated to per-second means, then a 120s window is slid across the excerpt.
#
# Selection rule: maximise the WINDOW MINIMUM (per-second motion), tie-broken by the
# window mean. Maximising the minimum is what excludes static stretches -- the Avatar
# window was characterised by both (mean 16.29, minimum 9.98), and it is the minimum
# that guarantees "no static stretches".
set -uo pipefail

SRC=/w/jurassic_sample.mkv
OUT=/w/bench/jurassic_motion120.mkv
CSV=/w/bench/.jurassic_motion.csv
WIN=120

echo "== measuring per-frame motion =="
ffmpeg -v error -i "${SRC}" \
  -vf "scale=480:-2,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-" \
  -an -f null - 2>/dev/null \
  | awk -F'=' '/YAVG/{print $2}' > /tmp/yavg.txt

FPS=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "${SRC}" | awk -F/ '{printf "%.6f", $1/$2}')
N=$(wc -l < /tmp/yavg.txt)
echo "frames=${N} fps=${FPS}"

# per-second means
awk -v fps="${FPS}" '{ s=int((NR-1)/fps); sum[s]+=$1; cnt[s]++ }
     END{ for(i=0;i<=int((NR-1)/fps);i++) if(cnt[i]>0) printf "%d,%.4f\n", i, sum[i]/cnt[i] }' /tmp/yavg.txt > "${CSV}"
echo "seconds measured: $(wc -l < "${CSV}")"

# slide a 120s window; maximise the minimum per-second motion, tie-break on mean
BEST=$(awk -F',' -v w="${WIN}" '
  { m[NR-1]=$2; n=NR }
  END{
    bs=-1; bmin=-1; bmean=-1
    for(s=0; s+w<=n; s++){
      mn=1e18; sum=0
      for(i=s;i<s+w;i++){ if(m[i]<mn) mn=m[i]; sum+=m[i] }
      mean=sum/w
      if(mn>bmin || (mn==bmin && mean>bmean)){ bmin=mn; bmean=mean; bs=s }
    }
    printf "%d %.4f %.4f\n", bs, bmean, bmin
  }' "${CSV}")

START=$(echo "${BEST}" | awk '{print $1}')
WMEAN=$(echo "${BEST}" | awk '{print $2}')
WMIN=$(echo "${BEST}" | awk '{print $3}')
echo "== selected window: start=${START}s len=${WIN}s  mean_motion=${WMEAN}  min_motion=${WMIN} =="

# whole-excerpt stats, for the record
awk -F',' '{s+=$2; if(mn==""||$2<mn)mn=$2; n++} END{printf "== whole 300s excerpt: mean=%.4f min=%.4f ==\n", s/n, mn}' "${CSV}"

# Stream copy, NOT a re-encode. The Avatar sample is a lossy ~25 Mbit/s h264 cut from a
# remux; re-encoding Jurassic losslessly (~200 Mbit/s) would hand the encoder a materially
# easier source and confound exactly the comparison we are trying to make fair. -ss before
# -i snaps to the nearest preceding keyframe, so the realised window may start a little
# before START and run a little over/under 120s -- reported below rather than assumed.
echo "== cutting (stream copy, keyframe-aligned) =="
ffmpeg -v error -y -ss "${START}" -i "${SRC}" -t "${WIN}" \
  -c copy -an -sn "${OUT}"

echo "== result =="
ffprobe -v error -select_streams v:0 -count_frames \
  -show_entries stream=codec_name,width,height,pix_fmt,nb_read_frames \
  -show_entries format=duration,size -of default=nw=1 "${OUT}"
