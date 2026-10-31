#!/usr/bin/env bash
# Container entrypoint, run as root under docker's --init. Applies the egress firewall and refuses to
# start without it, then stays as the container's main process to refresh the allowlist every
# FIREWALL_REFRESH_SECONDS (default 300). Sessions run separately, through `docker exec -u node`; node
# cannot signal or trace this process, and if it dies the container stops.
set -euo pipefail

if (( $# > 0 )); then
  echo "entrypoint: takes no arguments; sessions run with docker exec" >&2
  exit 2
fi
if (( EUID != 0 )); then
  echo "entrypoint: must start as root to apply the firewall" >&2
  exit 1
fi
interval=${FIREWALL_REFRESH_SECONDS:-300}
if [[ ! $interval =~ ^[1-9][0-9]*$ ]]; then
  echo "entrypoint: FIREWALL_REFRESH_SECONDS must be a positive integer, not '$interval'" >&2
  exit 2
fi
export FIREWALL_REFRESH_SECONDS=$interval

# Not the image's working directory, /home/node, which is the node-writable home volume.
cd /

if ! /usr/local/bin/init-firewall.sh apply; then
  echo "entrypoint: firewall failed; not starting" >&2
  exit 1
fi
echo "entrypoint: firewall applied"

# docker stop: leave at once instead of after the current sleep.
trap 'exit 0' TERM INT
while true; do
  sleep "$interval" &
  wait "$!"
  if ! /usr/local/bin/init-firewall.sh refresh; then
    echo "entrypoint: firewall refresh failed; current rules kept" >&2
  fi
done
