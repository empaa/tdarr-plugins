#!/usr/bin/env bash
# Job 3: same 12 arms, Jurassic motion-selected 120s sample. Distinct RESULTS file so
# Jurassic rows can never be confused with Avatar rows (the binary column is identical).
set -u
LOG=/mnt/cache_nvme_two/vm_data/xav-work/logs/20-jurassic-sweep.log
exec >>"${LOG}" 2>&1
echo "### jurassic sweep driver start $(date -Is)"

PLEX_WAS_RUNNING=0
[ "$(docker inspect -f '{{.State.Running}}' plex 2>/dev/null)" = "true" ] && PLEX_WAS_RUNNING=1
restore_plex() {
  if [ "${PLEX_WAS_RUNNING}" = "1" ]; then
    echo "### restoring plex $(date -Is)"
    docker start plex >/dev/null 2>&1 && echo "### plex started" || echo "### PLEX START FAILED -- restart manually"
  fi
}
trap restore_plex EXIT INT TERM
if [ "${PLEX_WAS_RUNNING}" = "1" ]; then
  echo "### stopping plex for sweep duration $(date -Is)"
  docker stop plex >/dev/null 2>&1 && echo "### plex stopped"
fi

cd /mnt/cache_nvme_two/vm_data/xav-work/host || exit 9
CRF_RANGE=5-63 \
  RESULTS=/mnt/cache_nvme_two/vm_data/xav-work/bench/jurassic-settings-sweep-results.tsv \
bash run-settings-sweep.sh \
  /mnt/user/appdata/tdarr/xav/xav-mainline \
  /mnt/cache_nvme_two/vm_data/xav-work/bench/jurassic_motion120.mkv \
  mid top low
echo "### jurassic sweep driver done $(date -Is) rc=$?"
