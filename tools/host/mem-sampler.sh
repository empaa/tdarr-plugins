#!/usr/bin/env bash
# Sample the throwaway node container's memory while a job runs, so the 4K-worker question is
# answered with a measured peak rather than an assumption. Records the highest usage seen and
# the cgroup limit. Exits when no xav process has been seen for 60s.
OUT=${1:-/mnt/user/tdarr-job5-cache/mem-samples.txt}
: > "$OUT"
peak=0; peak_h=""; lastseen=$(date +%s); limit=""
while true; do
  line=$(docker stats --no-stream --format '{{.MemUsage}}' tdarr_job5_node 2>/dev/null)
  used_h=${line%% /*}; limit=${line##*/ }
  # normalise to MiB
  n=$(echo "$used_h" | sed 's/[A-Za-z]*$//')
  u=$(echo "$used_h" | grep -oE '[A-Za-z]+$')
  case "$u" in
    GiB) mib=$(awk -v n="$n" 'BEGIN{printf "%.0f", n*1024}') ;;
    MiB) mib=$(awk -v n="$n" 'BEGIN{printf "%.0f", n}') ;;
    KiB) mib=$(awk -v n="$n" 'BEGIN{printf "%.0f", n/1024}') ;;
    *)   mib=0 ;;
  esac
  running=$(docker exec tdarr_job5_node sh -c 'ps ax -o comm | grep -c "^xav$"' 2>/dev/null || echo 0)
  now=$(date +%s)
  [ "${running:-0}" -gt 0 ] && lastseen=$now
  if [ "${mib:-0}" -gt "$peak" ]; then peak=$mib; peak_h=$used_h; fi
  echo "$(date +%H:%M:%S) used=$used_h limit=$limit xav_procs=$running peak=${peak}MiB" >> "$OUT"
  if [ $((now - lastseen)) -gt 60 ]; then
    echo "PEAK=${peak}MiB (${peak_h})  LIMIT=${limit}" >> "$OUT"
    break
  fi
  sleep 5
done
