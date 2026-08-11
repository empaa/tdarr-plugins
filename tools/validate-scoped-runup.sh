#!/bin/bash
# Correctness gate for the scoped lsmas cold-seek run-up
# (docs/followup-grey-frame-fix-efficiency.md §6 + §10).
#
# Run INSIDE a container that has vspipe/ffmpeg/jq and can read the source
# (e.g. tdarr_server). READ-ONLY apart from the workdir.
#
#   validate-scoped-runup.sh <source.vpy> <scenes.json> [workdir]
#
#   <source.vpy>  generated from the CURRENT builder: node tools/gen-vpy.js ...
#   <scenes.json> av1an scene list for the same source (--sc-only output, or the
#                 scenes.json of a previous real run) -- supplies the chunk starts
#
# Phases (all must pass on a proven-bad source, e.g. The Conjuring AVC remux):
#   A  fresh `vspipe -s N -e N` per chunk start, RANDOMISED order  -> expect 0 grey
#      (ascending order keeps lsmas warm and hides the bug -- doc §6)
#   B  control arm: wrapper pushed past EOF via TDARR_RUNUP_START_OVERRIDE,
#      known-bad starts only                                       -> expect >=15 grey
#      (proves the harness still detects the failure; doc measured 20/21)
#   C  chunk-worker shape: `vspipe -s N -e N+59` on known-bad starts -> expect 0 grey
#   D  bit-exactness: framemd5 of frames 0-499, candidate vs control -> identical
set -uo pipefail

VPY="${1:?usage: validate-scoped-runup.sh <source.vpy> <scenes.json> [workdir]}"
SCENES="${2:?need scenes.json for chunk starts}"
W="${3:-/tmp/scoped-runup-validate}"
mkdir -p "$W"

# Window start far past any real clip => wrapper covers nothing == no run-up.
OFF=1000000000

# The Conjuring (2013) AVC remux burst starts (doc §6). Override for other sources.
KNOWN_BAD="${KNOWN_BAD:-12778 21822 27971 57594 63464 73527 86204 86302 86909 105337 105797 111451 112143 114218 116597 121735 137298 140693 144181 145544 145664}"

FMT=$(vspipe --info "$VPY" | awk -F': *' '/Format Name/{print $2}')
case "$FMT" in
  *P12*) MID=2048 ;;
  *P10*) MID=512  ;;
  *)     MID=128  ;;
esac
echo "source format: ${FMT:-unknown}  grey-midpoint: $MID"

# grey_count <start> <end> [override] -> number of flat-mid-grey frames decoded.
# An empty override is a no-op in the .vpy (unparsable -> cmdline value kept),
# so the candidate arm can pass "" instead of juggling env arrays under set -u.
grey_count() {
  local s="$1" e="$2" ov="${3:-}"
  TDARR_RUNUP_START_OVERRIDE="$ov" vspipe -s "$s" -e "$e" -c y4m "$VPY" - 2>/dev/null \
    | ffmpeg -nostdin -v error -f yuv4mpegpipe -i - \
        -vf signalstats,metadata=print:file=- -an -sn -f null - 2>/dev/null \
    | awk -F= -v mid="$MID" '
        /YMIN=/{mn=$2} /YAVG=/{av=$2}
        /YMAX=/{mx=$2; if (mn==mx && av > mid*0.98 && av < mid*1.02) n++}
        END{print n+0}'
}

STARTS=$(jq -r '.scenes[].start_frame' "$SCENES" 2>/dev/null | sort -n | uniq | shuf)
TOTAL=$(echo "$STARTS" | grep -c .)
[ "$TOTAL" -gt 0 ] || { echo "FATAL: no chunk starts found in $SCENES"; exit 2; }

echo "=== phase A: cold-seek probe, $TOTAL chunk starts, randomised, candidate wrapper ==="
GREY_A=0 I=0
for S in $STARTS; do
  I=$((I+1))
  G=$(grey_count "$S" "$S")
  case "$G" in ''|*[!0-9]*) G=0 ;; esac
  if [ "$G" -gt 0 ]; then GREY_A=$((GREY_A+1)); echo "  GREY at chunk start $S"; fi
  [ $((I % 100)) -eq 0 ] && echo "  ...$I/$TOTAL (grey so far: $GREY_A)"
done
echo "phase A: $GREY_A grey chunk starts (expect 0)"

echo "=== phase B: control arm (no effective wrapper), known-bad starts ==="
GREY_B=0
for S in $KNOWN_BAD; do
  G=$(grey_count "$S" "$S" "$OFF")
  case "$G" in ''|*[!0-9]*) G=0 ;; esac
  [ "$G" -gt 0 ] && GREY_B=$((GREY_B+1))
done
echo "phase B: $GREY_B of $(echo "$KNOWN_BAD" | wc -w) known-bad starts grey without wrapper (expect >=15; doc measured 20/21)"

echo "=== phase C: chunk-worker shape (-s N -e N+59), known-bad starts, candidate ==="
GREY_C=0
for S in $KNOWN_BAD; do
  G=$(grey_count "$S" "$((S+59))")
  case "$G" in ''|*[!0-9]*) G=0 ;; esac
  GREY_C=$((GREY_C+G))
done
echo "phase C: $GREY_C grey frames total (expect 0)"

echo "=== phase D: bit-exactness, framemd5 frames 0-499, candidate vs control ==="
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
[ "$GREY_A" -eq 0 ]  || PASS=0
[ "$GREY_B" -ge 15 ] || PASS=0
[ "$GREY_C" -eq 0 ]  || PASS=0
[ "$D" = PASS ]      || PASS=0
if [ "$PASS" -eq 1 ]; then echo "RESULT: PASS"; else echo "RESULT: FAIL"; exit 1; fi
