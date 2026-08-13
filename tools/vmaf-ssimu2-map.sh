#!/bin/bash
# Score every existing curve output with VMAF, so the SSIMULACRA2 numbers our
# tiers are defined in can be read against the metric with years of subjective
# calibration behind it (and the one Emil's production av1an runs targeted).
#
# The whole tier system targets SSIMULACRA2, but nobody has ever mapped those
# targets onto VMAF on our own content. Without that, "target 80" is a number
# with no relationship to observed quality, and the top tier was set by
# guesswork rather than evidence.
#
# The reference MUST be trimmed to the encode's length. libvmaf runs until the
# LONGER input ends and scores the missing tail as 0 -- which silently turned a
# real 98.5 into 50.86 on the first attempt here.
#
# Runs INSIDE the node container.
set -u

WORK=/mnt/library/aomcurve
OUT=${OUT:-$WORK/vmaf.tsv}
FRAMES=${FRAMES:-1440}
JOBS=${JOBS:-4}
MODEL=/usr/local/share/vmaf/vmaf_v0.6.1.json

[ -f "$OUT" ] || printf 'clip\tarm\tcrf\tvmaf_mean\tvmaf_min\tvmaf_1pct\tframes\n' > "$OUT"

score_one() {
  local f=$1
  local base clip arm crf src log
  base=$(basename "$f" .mkv)
  clip=${base%%.*}
  arm=$(echo "$base" | cut -d. -f2)
  crf=$(echo "$base" | cut -d. -f3 | sed 's/^crf//')
  src="$WORK/src/$clip.mkv"
  log="$WORK/out/$base.vmaf.json"

  timeout 900 ffmpeg -v error -i "$f" -i "$src" -lavfi \
    "[0:v]setpts=PTS-STARTPTS[d];[1:v]trim=end_frame=$FRAMES,setpts=PTS-STARTPTS[r];[d][r]libvmaf=model=path=$MODEL:n_threads=8:log_path=$log:log_fmt=json" \
    -f null - >/dev/null 2>&1

  python3 - "$log" "$clip" "$arm" "$crf" >> "$OUT" <<'PY'
import json, sys
log, clip, arm, crf = sys.argv[1:5]
try:
    d = json.load(open(log))
except Exception:
    print(f"{clip}\t{arm}\t{crf}\tNA\tNA\tNA\t0"); raise SystemExit
p = d["pooled_metrics"]["vmaf"]
v = sorted(f["metrics"]["vmaf"] for f in d["frames"])
# 1st percentile: VMAF's own pooled min is a single frame and very noisy.
p1 = v[max(0, int(len(v) * 0.01) - 1)] if v else 0
print(f"{clip}\t{arm}\t{crf}\t{p['mean']:.3f}\t{p['min']:.3f}\t{p1:.3f}\t{len(v)}")
PY
  echo "scored $base"
}

for f in "$WORK"/out/*.mkv; do
  [ -e "$f" ] || continue
  score_one "$f" &
  while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do wait -n; done
done
wait
echo "VMAF COMPLETE"
