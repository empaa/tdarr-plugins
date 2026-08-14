#!/usr/bin/env bash
# Cut representative 120s clips from titles currently QUEUED in production Tdarr.
#
# Position is RANDOM-BY-POSITION, not motion-selected. That is the whole point: the Avatar
# sample was deliberately the busiest 120s in the film, which made every absolute ratio a
# worst case rather than an expectation. Offset is derived deterministically from the md5 of
# the filename so the set is reproducible without storing state, and constrained to
# [12%, 85%] of runtime to avoid titles/credits.
#
# Stream copy, and -map 0 keeps AUDIO AND SUBTITLES -- the earlier bench samples were
# video-only, so probeNonVideoSize returned 0 and mergeAudioVideo had nothing to merge.
set -uo pipefail
OUT=/w/job5/clips
mkdir -p "$OUT"

cut_one() {
  local src="$1" key="$2"
  local dur pct off
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$src" 2>/dev/null | cut -d. -f1)
  if [ -z "$dur" ] || [ "$dur" -lt 300 ]; then echo "SKIP $key (duration=$dur)"; return; fi
  # deterministic pseudo-random offset in [12%, 85%]
  local h
  h=$(printf '%s' "$(basename "$src")" | md5sum | cut -c1-6)
  pct=$(awk -v h="$((16#$h))" 'BEGIN{printf "%.4f", 0.12 + (h % 7300)/10000}')
  off=$(awk -v d="$dur" -v p="$pct" 'BEGIN{printf "%d", d*p}')
  echo "=== $key: duration=${dur}s  offset=${off}s (${pct} of runtime) ==="
  ffmpeg -v error -y -ss "$off" -i "$src" -t 120 -map 0 -c copy \
    -avoid_negative_ts make_zero "$OUT/${key}.mkv" 2>&1 | head -3
  ffprobe -v error -show_entries format=duration,size -of default=nw=1 "$OUT/${key}.mkv" 2>&1
  echo "  streams: $(ffprobe -v error -show_entries stream=codec_type -of csv=p=0 "$OUT/${key}.mkv" 2>/dev/null | sort | uniq -c | tr '\n' ' ')"
  echo
}

cut_one "/mnt/media/movies/Close Encounters of the Third Kind (1977) {imdb-tt0075860}/Close Encounters of the Third Kind (1977) - [Remux-1080p][TrueHD 5.1][AVC]-playBD.mkv" "closeenc"
cut_one "/mnt/media/movies/Top Gun Maverick (2022)/Top Gun Maverick (2022) - {IMAX} [Remux-1080p][TrueHD Atmos 7.1][AVC]-playBD.mkv" "topgun"
cut_one "/mnt/media/shows/Westworld/Season 04/Westworld (2016) - S04E02 - Well Enough Alone [AMZN][WEBDL-1080p][EAC3 5.1][h264]-NTb.mkv" "westworld"
# VC-1: a decode path nothing in this project has ever exercised. Free to include since the
# title is already in the production queue.
cut_one "/mnt/media/movies/Harry Potter and the Philosophers Stone (2001)/Harry Potter and the Philosophers Stone (2001) - {Theatrical} [Hybrid][Remux-1080p][DTS-X 7.1][VC1]-EPSiLON.mkv" "harrypotter"

echo "=== clips ==="
ls -la "$OUT"
