#!/bin/bash
# Correctness gate for the scoped lsmas cold-seek run-up
# (docs/followup-grey-frame-fix-efficiency.md §6 + §10).
#
# Run INSIDE a container that has vspipe/ffmpeg/jq/shuf (tdarr_server or a node
# image). READ-ONLY on the source; all scratch goes to the workdir.
#
#   validate-scoped-runup.sh <source.vpy> <scenes.json> [workdir]
#
#   <source.vpy>  generated from the CURRENT builder: node tools/gen-vpy.js ...
#                 (container-visible paths for both source and .lwi cache)
#   <scenes.json> av1an scene list for the same source, produced the way the
#                 plugins do it: av1an -i source.vpy --sc-only --scenes ...
#
# Phases (self-calibrating -- no per-source known-bad list needed):
#   B  control sweep: EVERY chunk start, fresh vspipe per start, RANDOMISED
#      order, wrapper pushed past EOF via TDARR_RUNUP_START_OVERRIDE.
#      Discovers this source's actual bad set. Expect >= SENS_MIN grey on a
#      proven-bad source -- this is the harness-sensitivity check; a clean
#      control sweep means the source cannot validate anything.
#   A  candidate sweep: same starts, randomised again, real wrapper -> expect 0.
#   C  chunk-worker shape (`vspipe -s N -e N+59`) over the phase-B bad set,
#      real wrapper -> expect 0 grey frames.
#   D  bit-exactness: framemd5 frames 0-499, candidate vs control -> identical.
#
# Ascending probe order would keep lsmas warm and hide the bug (doc §6) --
# both sweeps shuffle. Every probe is its own vspipe process, so PAR-way
# parallelism (default 4) cannot warm anything either.
set -uo pipefail

VPY="${1:?usage: validate-scoped-runup.sh <source.vpy> <scenes.json> [workdir]}"
SCENES="${2:?need scenes.json for chunk starts}"
W="${3:-/tmp/scoped-runup-validate}"
PAR="${PAR:-4}"
SENS_MIN="${SENS_MIN:-10}"
mkdir -p "$W"

# Window start far past any real clip => wrapper covers nothing == no run-up.
OFF=1000000000

FMT=$(vspipe --info "$VPY" | awk -F': *' '/Format Name/{print $2}')
case "$FMT" in
  *P12*) MID=2048 ;;
  *P10*) MID=512  ;;
  *)     MID=128  ;;
esac
echo "source format: ${FMT:-unknown}  grey-midpoint: $MID  parallelism: $PAR"

# probe <start> [end] : decode with the current TDARR_RUNUP_START_OVERRIDE
# ("" = candidate wrapper), print "GREY <start> <n>" when grey frames decoded.
probe() {
  local s="$1" e="${2:-$1}" g
  g=$(TDARR_RUNUP_START_OVERRIDE="${OV:-}" vspipe -s "$s" -e "$e" -c y4m "$VPY" - 2>/dev/null \
    | ffmpeg -nostdin -v error -f yuv4mpegpipe -i - \
        -vf signalstats,metadata=print:file=- -an -sn -f null - 2>/dev/null \
    | awk -F= -v mid="$MID" '
        /YMIN=/{mn=$2} /YAVG=/{av=$2}
        /YMAX=/{mx=$2; if (mn==mx && av > mid*0.98 && av < mid*1.02) n++}
        END{print n+0}')
  case "$g" in ''|*[!0-9]*) g=0 ;; esac
  [ "$g" -gt 0 ] && echo "GREY $s $g"
  return 0
}
export -f probe
export VPY MID

# sweep <override> <outfile> : probe every chunk start, shuffled, PAR-wide.
sweep() {
  jq -r '.scenes[].start_frame' "$SCENES" | sort -n | uniq | shuf \
    | OV="$1" xargs -P "$PAR" -n 1 -I{} bash -c 'probe {}' > "$2"
}

TOTAL=$(jq -r '.scenes[].start_frame' "$SCENES" | sort -n | uniq | grep -c .)
[ "$TOTAL" -gt 0 ] || { echo "FATAL: no chunk starts found in $SCENES"; exit 2; }
echo "chunk starts: $TOTAL"

echo "=== phase B ($(date '+%T')): control sweep (no effective wrapper) -- discovering bad set ==="
sweep "$OFF" "$W/grey.control"
BAD=$(awk '{print $2}' "$W/grey.control" | sort -n)
NBAD=$(printf '%s\n' "$BAD" | grep -c .)
echo "phase B: $NBAD of $TOTAL chunk starts grey without wrapper (sensitivity floor: $SENS_MIN)"

echo "=== phase A ($(date '+%T')): candidate sweep (real wrapper) ==="
sweep "" "$W/grey.candidate"
GREY_A=$(grep -c . "$W/grey.candidate")
[ "$GREY_A" -gt 0 ] && sed 's/^/  /' "$W/grey.candidate"
echo "phase A: $GREY_A grey chunk starts (expect 0)"

# Cold-seek grey is INTERMITTENT (SM5 start 77745: 6/10 at depth 8), so one
# probe per start can miss a coin-flip failure. Hammer the discovered bad set.
REPEATS="${REPEATS:-10}"
echo "=== phase A2 ($(date '+%T')): candidate x$REPEATS over the $NBAD bad starts ==="
GREY_A2=0
for S in $BAD; do
  H=0
  for _ in $(seq 1 "$REPEATS"); do
    R=$(probe "$S")
    [ -n "$R" ] && H=$((H+1))
  done
  if [ "$H" -gt 0 ]; then GREY_A2=$((GREY_A2+1)); echo "  start $S grey $H/$REPEATS"; fi
done
echo "phase A2: $GREY_A2 of $NBAD bad starts ever grey across $REPEATS repeats (expect 0)"

echo "=== phase C ($(date '+%T')): chunk-worker shape (-s N -e N+59) over bad set ==="
GREY_C=0
for S in $BAD; do
  R=$(probe "$S" "$((S+59))")
  if [ -n "$R" ]; then GREY_C=$((GREY_C + $(echo "$R" | awk '{print $3}'))); echo "  $R"; fi
done
echo "phase C: $GREY_C grey frames total (expect 0)"

echo "=== phase D ($(date '+%T')): bit-exactness, framemd5 frames 0-499 ==="
TDARR_RUNUP_START_OVERRIDE="" vspipe -s 0 -e 499 -c y4m "$VPY" - 2>/dev/null \
  | ffmpeg -nostdin -v error -f yuv4mpegpipe -i - -f framemd5 - 2>/dev/null > "$W/cand.framemd5"
TDARR_RUNUP_START_OVERRIDE="$OFF" vspipe -s 0 -e 499 -c y4m "$VPY" - 2>/dev/null \
  | ffmpeg -nostdin -v error -f yuv4mpegpipe -i - -f framemd5 - 2>/dev/null > "$W/ctrl.framemd5"
if cmp -s "$W/cand.framemd5" "$W/ctrl.framemd5" && [ -s "$W/cand.framemd5" ]; then
  D=PASS
else
  D=FAIL
fi
echo "phase D: $D (md5 files in $W)"

echo
PASS=1
[ "$NBAD" -ge "$SENS_MIN" ] || { echo "FAIL: control sweep found only $NBAD grey -- harness not sensitive on this source"; PASS=0; }
[ "$GREY_A" -eq 0 ]         || { echo "FAIL: candidate sweep still grey"; PASS=0; }
[ "$GREY_A2" -eq 0 ]        || { echo "FAIL: candidate repeats still grey"; PASS=0; }
[ "$GREY_C" -eq 0 ]         || { echo "FAIL: chunk-worker shape still grey"; PASS=0; }
[ "$D" = PASS ]             || { echo "FAIL: wrapper altered pixels"; PASS=0; }
if [ "$PASS" -eq 1 ]; then echo "RESULT: PASS"; else echo "RESULT: FAIL"; exit 1; fi
