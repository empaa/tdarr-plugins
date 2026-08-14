#!/usr/bin/env bash
cd /w || exit 9
SRC=/w/captain_hdr12s.mkv
P='--preset 8 --tune 1 --enable-qm 1 --qm-min 0'

probe() { ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name,width,height,pix_fmt,color_primaries,color_transfer,color_space,chroma_location \
  -of default=nw=1 "$1" 2>&1; }

echo "########## SOURCE ##########"; probe "$SRC"

echo; echo "########## NATIVE (xav reads the file directly) ##########"
rm -f out_native.mkv captain_hdr12s.json
script -qec "/usr/local/bin/xav $SRC /w/out_native.mkv -w 1 -v 1 -t 79.8-80.2 -f 5-63 -p '$P'" /dev/null > native.log 2>&1
echo "exit=$?"
probe /w/out_native.mkv

echo; echo "########## PIPE (ffmpeg scale->Y4M->stdin, source still passed as INPUT) ##########"
rm -f out_pipe.mkv captain_hdr12s.json
ffmpeg -v error -i "$SRC" -an -sn -vf scale=1920:-2 -pix_fmt yuv420p10le -strict -1 -f yuv4mpegpipe - 2>/dev/null \
  | script -qec "/usr/local/bin/xav $SRC /w/out_pipe.mkv -w 1 -v 1 -t 79.8-80.2 -f 5-63 -p '$P'" /dev/null > pipe.log 2>&1
echo "exit=$?"
probe /w/out_pipe.mkv

echo; echo "--- pipe log tail ---"; tail -5 pipe.log | tr -d '\015' | sed 's/\x1b\[[0-9;]*m//g'
