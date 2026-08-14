#!/usr/bin/env bash
# Detached driver for the settings sweep. Stops Plex for the duration so that
# background maintenance finishing mid-sweep cannot shift wall-clock between
# arms, and ALWAYS restarts it via trap -- including on kill/crash.
set -u
LOG=/mnt/cache_nvme_two/vm_data/xav-work/logs/19-settings-sweep.log
exec >>"${LOG}" 2>&1
echo "### settings sweep driver start $(date -Is)"

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
  docker stop plex >/dev/null 2>&1 && echo "### plex stopped" || echo "### plex stop failed, continuing"
fi

cd /mnt/cache_nvme_two/vm_data/xav-work/host || exit 9
bash run-settings-sweep.sh \
  /mnt/user/appdata/tdarr/xav/xav-mainline \
  /mnt/cache_nvme_two/vm_data/xav-work/bench/avatar_fna_sample.mkv \
  mid top low
echo "### settings sweep driver done $(date -Is) rc=$?"
