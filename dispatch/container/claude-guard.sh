#!/usr/bin/env bash
# Installed as /usr/local/bin/claude, in front of the real binary. Claude Code never runs as root in the
# container: started as root, as a plain `docker exec <container> claude ...` is, this switches to node
# with every capability dropped and no-new-privs set, keeping the working directory. As node, it runs
# the binary directly. Every other command needs `docker exec -u node`.
set -euo pipefail

real=/usr/local/libexec/claude-code

if (( EUID == 0 )); then
  export HOME=/home/node USER=node LOGNAME=node
  exec /usr/bin/setpriv --reuid=node --regid=node --init-groups \
    --inh-caps=-all --bounding-set=-all --no-new-privs -- "$real" "$@"
fi
exec "$real" "$@"
