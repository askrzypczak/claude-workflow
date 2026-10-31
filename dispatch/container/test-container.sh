#!/usr/bin/env bash
# Verifies the agent image: builds it as claude-workflow-agent:test, then checks the egress firewall and
# the privilege boundaries in throwaway containers started with the README's run flags. Prints
# "PASS|FAIL <check>: <detail>" per check. Exit 0 when every check passes, 1 when any fails, 2 when
# docker is unreachable. Removes the containers and the volume it creates and keeps the image.
# Runs on the bash 3.2 that macOS ships, as well as later versions.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
image=claude-workflow-agent:test

if ! command -v docker >/dev/null 2>&1 || ! docker version >/dev/null 2>&1; then
  echo "test-container: docker is not reachable. Start Colima, then run this again:" >&2
  echo "  colima start --cpu 4 --memory 4 --disk 40 --mount none" >&2
  exit 2
fi

prefix=claude-workflow-agent-test-$(date +%s)-$$
volume=$prefix-home
main=$prefix-main
containers=""
checks=0
failures=0
detail=""
tmp=$(mktemp -d)

cleanup() {
  local c
  for c in $containers; do
    docker rm -f "$c" >/dev/null 2>&1
  done
  docker volume rm "$volume" >/dev/null 2>&1
  rm -rf "$tmp"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# --- helpers -------------------------------------------------------------------------------------

# run <check> <function> [args...]: the function sets $detail and succeeds when the check passes.
run() {
  local name=$1
  shift
  detail=""
  checks=$((checks + 1))
  if "$@"; then
    printf 'PASS %s: %s\n' "$name" "$detail"
  else
    printf 'FAIL %s: %s\n' "$name" "$detail"
    failures=$((failures + 1))
    return 1
  fi
}

finish() {
  echo "test-container: $((checks - failures)) of $checks checks passed"
  [ "$failures" -eq 0 ] && exit 0
  exit 1
}

oneline() { printf '%s' "$1" | tr '\n' ' ' | sed -e 's/  */ /g' -e 's/ $//'; }
lastline() { printf '%s\n' "$1" | grep -v '^[[:space:]]*$' | tail -n 1; }

# start <name> <docker run flags...>: starts a container from the image on this run's home volume.
start() {
  local name=$1
  shift
  containers="$containers $name"
  docker run -d --name "$name" "$@" -v "$volume:/home/node" -e FIREWALL_REFRESH_SECONDS=5 "$image" >/dev/null
}

# The README's run flags.
run_flags=(--init --cap-add=NET_ADMIN --cap-add=NET_RAW --security-opt no-new-privileges)

# wait_applied <container> <count>: waits until the entrypoint has logged its readiness line <count>
# times, failing early if the container stops.
wait_applied() {
  local i n state
  for i in $(seq 1 180); do
    n=$(docker logs "$1" 2>&1 | grep -c 'entrypoint: firewall applied')
    [ "$n" -ge "$2" ] && return 0
    state=$(docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null) || return 1
    case $state in exited | dead) return 1 ;; esac
    sleep 1
  done
  return 1
}

# wait_exited <container>: waits for the container to stop and prints its exit code.
wait_exited() {
  local i state
  for i in $(seq 1 120); do
    state=$(docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null) || return 1
    case $state in
      exited | dead)
        docker inspect -f '{{.State.ExitCode}}' "$1"
        return 0
        ;;
    esac
    sleep 1
  done
  return 1
}

as_node() { docker exec -u node "$main" "$@"; }

# reachable <url>: node's request gets an HTTP answer, whatever its status.
reachable() {
  local out code
  out=$(as_node curl -q -sS -o /dev/null -w '%{http_code}' --max-time 20 "$1" 2>&1)
  code=$?
  if [ "$code" -eq 0 ] && [[ $out =~ ^[1-5][0-9][0-9]$ ]]; then
    detail="$1 answered HTTP $out"
    return 0
  fi
  detail="$1 was not reached (curl exit $code: $(oneline "$out"))"
  return 1
}

# refused <url>: node's connection is refused at once (curl exit 7), not made and not timed out.
refused() {
  local out code
  out=$(as_node curl -q -sS -o /dev/null --max-time 10 "$1" 2>&1)
  code=$?
  if [ "$code" -eq 7 ]; then
    detail="$1 refused ($(lastline "$out"))"
    return 0
  fi
  detail="$1 was not refused (curl exit $code: $(oneline "$out"))"
  return 1
}

# The entrypoint's process: the child of --init's PID 1.
refresh_pid() { as_node pgrep -P 1 -f /usr/local/bin/entrypoint.sh; }

# --- checks --------------------------------------------------------------------------------------

check_build() {
  local server
  server=$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}' 2>&1)
  echo "test-container: building $image (a first build takes 10-20 minutes)" >&2
  if docker build -t "$image" "$here" >"$tmp/build.log" 2>&1; then
    detail="built $image on server $server"
    return 0
  fi
  detail="docker build failed on server $server: $(lastline "$(cat "$tmp/build.log")")"
  return 1
}

check_claude_version() {
  local want out code
  want=$(sed -n 's/^ARG CLAUDE_CODE_VERSION=\([^[:space:]]*\).*/\1/p' "$here/Dockerfile" | head -n 1)
  if [ -z "$want" ]; then
    detail="could not read the ARG CLAUDE_CODE_VERSION line from the Dockerfile"
    return 1
  fi
  out=$(as_node claude --version 2>&1)
  code=$?
  detail="expected $want; claude --version exit $code: $(oneline "$out")"
  [ "$code" -eq 0 ] || return 1
  case $out in *"$want"*) return 0 ;; esac
  return 1
}

check_dig() {
  local out code
  out=$(as_node dig +time=3 +tries=1 @1.1.1.1 example.com 2>&1)
  code=$?
  # Exit 9 is dig's "no reply from the server"; anything else, such as a missing dig, is a failure.
  if [ "$code" -eq 9 ] || printf '%s\n' "$out" | grep -q 'no servers could be reached'; then
    detail="dig exit $code ($(lastline "$out"))"
    return 0
  fi
  detail="dig @1.1.1.1 did not fail for want of a reply: exit $code: $(oneline "$out")"
  return 1
}

check_ssh() {
  local gitlab github
  local opts="-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"
  # shellcheck disable=SC2086 # $opts is a list of words
  gitlab=$(as_node ssh $opts -T git@gitlab.com 2>&1)
  # shellcheck disable=SC2086
  github=$(as_node ssh $opts -T git@github.com 2>&1)
  detail="gitlab.com: $(lastline "$gitlab"); github.com: $(lastline "$github")"
  case $gitlab in *"connect to host gitlab.com"*) ;; *) return 1 ;; esac
  case $github in *"Permission denied (publickey)"*) return 0 ;; esac
  return 1
}

check_iptables_flush() {
  local out code refusal blocked
  out=$(as_node iptables -F 2>&1)
  code=$?
  if [ "$code" -eq 0 ]; then
    detail="iptables -F succeeded"
    return 1
  fi
  refusal="iptables -F refused ($(lastline "$out"))"
  # A flush would leave the DROP policies alone, so example.com would time out instead of being
  # refused, and api.github.com would time out too.
  refused https://example.com || { detail="$refusal; then $detail"; return 1; }
  blocked=$detail
  reachable https://api.github.com/rate_limit || { detail="$refusal; then $detail"; return 1; }
  detail="$refusal; rules unchanged: $blocked, $detail"
}

check_ipset_flush() {
  local out code refusal github
  out=$(as_node ipset flush 2>&1)
  code=$?
  if [ "$code" -eq 0 ]; then
    detail="ipset flush succeeded"
    return 1
  fi
  refusal="ipset flush refused ($(lastline "$out"))"
  reachable https://api.github.com/rate_limit || { detail="$refusal; then $detail"; return 1; }
  github=$detail
  reachable https://registry.npmjs.org/ || { detail="$refusal; then $detail"; return 1; }
  detail="$refusal; entries kept: $github, $detail"
}

check_capeff() {
  local cap
  cap=$(as_node awk '$1 == "CapEff:" { print $2 }' /proc/self/status 2>&1)
  detail="CapEff $cap"
  [ "$cap" = 0000000000000000 ]
}

check_restart() {
  local blocked
  if ! docker restart "$main" >/dev/null 2>&1; then
    detail="docker restart failed"
    return 1
  fi
  if ! wait_applied "$main" 2; then
    detail="the entrypoint did not apply the firewall again: $(lastline "$(docker logs "$main" 2>&1)")"
    return 1
  fi
  refused https://example.com || return 1
  blocked=$detail
  reachable https://api.github.com/rate_limit || return 1
  detail="the entrypoint applied the firewall again; $blocked; $detail"
}

# exits_on_firewall_failure <container>: the container stops with a non-zero code after the
# entrypoint's failure line, and docker exec cannot run anything in it.
exits_on_firewall_failure() {
  local code out logs
  if ! code=$(wait_exited "$1"); then
    detail="still running after 120 s"
    return 1
  fi
  logs=$(docker logs "$1" 2>&1)
  if out=$(docker exec -u node "$1" true 2>&1); then
    detail="exited $code, yet docker exec ran a command in it"
    return 1
  fi
  detail="exited $code after \"$(printf '%s\n' "$logs" | grep -m 1 '^entrypoint:')\"; docker exec: $(lastline "$out")"
  [ "$code" != 0 ] && printf '%s\n' "$logs" | grep -q '^entrypoint: firewall failed; not starting$'
}

check_no_net_admin() {
  start "$prefix-no-net-admin" --init --cap-add=NET_RAW --security-opt no-new-privileges \
    || { detail="docker run failed"; return 1; }
  exits_on_firewall_failure "$prefix-no-net-admin"
}

check_no_network() {
  start "$prefix-no-network" "${run_flags[@]}" --network none || { detail="docker run failed"; return 1; }
  exits_on_firewall_failure "$prefix-no-network"
}

check_refresh() {
  local session removed addr i entries missing waited=""
  if ! docker exec -d -u node "$main" sleep 3600; then
    detail="could not start a node session"
    return 1
  fi
  session=$(as_node pgrep -n -u node -x sleep)
  if [ -z "$session" ]; then
    detail="the node session is not running"
    return 1
  fi
  # Root, to stand in for addresses that have gone stale: remove npm's current entries.
  removed=$(docker exec "$main" sh -c '
    for a in $(dig +short A registry.npmjs.org | grep -E "^[0-9.]+$"); do
      ipset del fw-https "$a" 2>/dev/null && echo "$a"
    done' | tr '\n' ' ')
  removed=${removed% }
  if [ -z "$removed" ]; then
    detail="no registry.npmjs.org address was in the allowlist to remove"
    return 1
  fi
  for i in $(seq 1 60); do
    entries=$(docker exec "$main" ipset list fw-https 2>/dev/null)
    missing=""
    for addr in $removed; do
      printf '%s\n' "$entries" | awk -v a="$addr" '$1 == a { found = 1 } END { exit !found }' \
        || missing="$missing $addr"
    done
    if [ -z "$missing" ]; then
      waited=$i
      break
    fi
    sleep 1
  done
  if [ -z "$waited" ]; then
    detail="removed $removed; still missing after 60 s:$missing"
    return 1
  fi
  if ! as_node kill -0 "$session" 2>/dev/null; then
    detail="removed $removed and the refresh restored them, but the node session $session stopped"
    return 1
  fi
  reachable https://registry.npmjs.org/ || return 1
  detail="removed $removed; restored within ${waited}s; node session $session still running; $detail"
}

# member_timeout <address>: the timeout fw-https reports for that member, empty when it is absent.
member_timeout() {
  docker exec "$main" ipset list fw-https 2>/dev/null | awk -v a="$1" '$1 == a && $2 == "timeout" { print $3 }'
}

check_entry_timeout() {
  # 12 times the 5 s refresh interval the containers here start with.
  local max=60 addr first second
  # Root, because only root can list the allowlist: its first member that is a single address.
  addr=$(docker exec "$main" ipset list fw-https 2>/dev/null \
    | awk '/^Members:/ { members = 1; next } members && !found && $1 !~ /\// { print $1; found = 1 }')
  if [ -z "$addr" ]; then
    detail="fw-https has no member that is a single address"
    return 1
  fi
  first=$(member_timeout "$addr")
  sleep 12
  second=$(member_timeout "$addr")
  detail="fw-https member $addr: timeout ${first:-absent}, then ${second:-absent} 12 s later (expected 0 < N <= $max, the second >= 50)"
  [[ $first =~ ^[0-9]+$ ]] && [[ $second =~ ^[0-9]+$ ]] || return 1
  [ "$first" -gt 0 ] && [ "$first" -le "$max" ] && [ "$second" -gt 0 ] && [ "$second" -le "$max" ] && [ "$second" -ge 50 ]
}

check_ipset_add() {
  local out code refusal
  out=$(as_node ipset add fw-https 1.1.1.1 2>&1)
  code=$?
  if [ "$code" -eq 0 ]; then
    detail="ipset add succeeded"
    return 1
  fi
  refusal="ipset add fw-https 1.1.1.1 refused ($(lastline "$out"))"
  refused https://1.1.1.1 || { detail="$refusal; but $detail"; return 1; }
  detail="$refusal; $detail"
}

check_signal() {
  local pid sig target out refusals=""
  pid=$(refresh_pid)
  if [ -z "$pid" ]; then
    detail="no refresh process found"
    return 1
  fi
  for target in "$pid" 1; do
    for sig in TERM KILL; do
      if out=$(as_node kill "-$sig" "$target" 2>&1); then
        detail="kill -$sig $target succeeded"
        return 1
      fi
      refusals="$refusals kill -$sig $target: $(lastline "$out");"
    done
  done
  sleep 1
  if ! as_node test -d "/proc/$pid"; then
    detail="the refresh process $pid is gone"
    return 1
  fi
  detail="${refusals# } the refresh process $pid is still running"
}

check_not_writable() {
  local pid cwd path_dirs out
  pid=$(refresh_pid)
  if [ -z "$pid" ]; then
    detail="no refresh process found"
    return 1
  fi
  # Root, because only the owner can read another process's working directory.
  cwd=$(docker exec "$main" readlink "/proc/$pid/cwd")
  path_dirs=$(as_node printenv PATH | tr ':' ' ')
  if [ -z "$cwd" ] || [ -z "$path_dirs" ]; then
    detail="could not read the refresh process's working directory or PATH"
    return 1
  fi
  # shellcheck disable=SC2086 # $path_dirs is a list of words
  out=$(as_node sh -c 'for p; do if [ ! -e "$p" ]; then echo "missing $p"; elif [ -w "$p" ]; then echo "writable $p"; fi; done' sh \
    /usr/local/bin/entrypoint.sh /usr/local/bin/init-firewall.sh /usr/local/bin/claude \
    /usr/local/libexec/claude-code /usr/local/libexec $path_dirs "$cwd" /run /run/init-firewall /root 2>&1)
  if [ -n "$out" ]; then
    detail=$(oneline "$out")
    return 1
  fi
  detail="not writable: entrypoint.sh, init-firewall.sh, claude and the binary it runs, PATH ($path_dirs), working directory $cwd, the firewall's state directory /run/init-firewall and /run, the refresher's HOME /root"
}

# claude started as root must run as uid 1000 with empty effective and bounding capability sets,
# NoNewPrivs set and HOME /home/node.
check_claude_guard() {
  local c=$prefix-claude-guard out want
  # Without --security-opt no-new-privileges: docker applies it to every exec, so NoNewPrivs would
  # read 1 even if the wrapper did not set it.
  start "$c" --init --cap-add=NET_ADMIN --cap-add=NET_RAW || { detail="docker run failed"; return 1; }
  if ! wait_applied "$c" 1; then
    detail="the container did not start: $(lastline "$(docker logs "$c" 2>&1)")"
    return 1
  fi
  # Root, in this throwaway container only: the real binary gives way to a probe.
  if ! docker exec -i "$c" sh -c 'rm -f /usr/local/libexec/claude-code && cat >/usr/local/libexec/claude-code && chmod 0755 /usr/local/libexec/claude-code' <<'PROBE'
#!/bin/sh
id -u
awk '$1 == "CapEff:" { print $2 }' /proc/$$/status
awk '$1 == "CapBnd:" { print $2 }' /proc/$$/status
awk '$1 == "NoNewPrivs:" { print $2 }' /proc/$$/status
echo "$HOME"
PROBE
  then
    detail="could not install the probe"
    return 1
  fi
  out=$(docker exec "$c" claude 2>&1)
  want=$(printf '1000\n0000000000000000\n0000000000000000\n1\n/home/node')
  detail="claude as root printed uid, CapEff, CapBnd, NoNewPrivs and HOME: $(oneline "$out")"
  [ "$out" = "$want" ]
}

# --- run -----------------------------------------------------------------------------------------

if ! run "docker build of dispatch/container succeeds and prints the server's OS and architecture" check_build; then
  tail -n 40 "$tmp/build.log" >&2
  finish
fi

if ! docker volume create "$volume" >/dev/null || ! start "$main" "${run_flags[@]}" || ! wait_applied "$main" 1; then
  echo "test-container: $main did not log 'entrypoint: firewall applied'; its last log lines:" >&2
  docker logs "$main" 2>&1 | tail -n 20 >&2
  exit 1
fi

run "as node, claude --version prints the pinned Claude Code version" check_claude_version
run "as node, api.github.com is reachable" reachable https://api.github.com/rate_limit
run "as node, registry.npmjs.org is reachable" reachable https://registry.npmjs.org/
run "as node, api.anthropic.com answers (any HTTP status)" reachable https://api.anthropic.com/
run "as node, https://example.com is refused" refused https://example.com
run "as node, dig @1.1.1.1 fails" check_dig
run "as node, ssh to gitlab.com cannot connect, while ssh to github.com connects and is refused for want of a key" check_ssh
run "as node, iptables -F is refused and the rules are unchanged" check_iptables_flush
run "as node, ipset flush is refused and the allowlist keeps its entries" check_ipset_flush
run "as node, CapEff in /proc/self/status is zero" check_capeff
run "after docker restart, example.com is still refused and api.github.com reachable, with nothing run from outside but the restart" check_restart
run "without NET_ADMIN, the container exits non-zero and docker exec cannot start a session in it" check_no_net_admin
run "with no network, the firewall fails and the container exits non-zero" check_no_network
run "after npm's addresses are removed from the allowlist, the next refresh restores them while a node session keeps running" check_refresh
run "allowlist entries expire 12 refresh intervals after they were last added, and each refresh resets the timeout" check_entry_timeout
run "as node, adding an address to the allowlist is refused" check_ipset_add
run "as node, signalling the refresh process is refused and it keeps running" check_signal
run "as node, the entrypoint, the firewall script, the claude wrapper, the directories on their PATH and the refresh process's working directory are not writable" check_not_writable
run "as root, claude runs as node with no capabilities and HOME /home/node" check_claude_guard

finish
