#!/usr/bin/env bash
# Run by the sandbox probe session that `dispatch/setup-agents.sh check` starts (see
# dispatch/setup/check.ts), as one Bash call inside that session's sandbox: it tries what a
# sandboxed session must not do (and what it must) and appends one line per item to
# RESULT_FILE, `SANDBOX-PROBE PASS|FAIL <item>: <detail>`. The session adds the items a script
# cannot test, then the END line.
# Usage: dispatch/setup/sandbox-probe.sh RESULT_FILE OWNER/REPO [KEY_FILE...]
# Items: home-write, network, `key <KEY_FILE>` for each key, ssh-config, gh.
# Key files are only tested with `test -r`; nothing reads or prints their contents.
# Exits 0 whatever the items show: the result file carries the outcome.
set -u

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 RESULT_FILE OWNER/REPO [KEY_FILE...]" >&2
  exit 2
fi
result=$1
repo=$2
shift 2

# line STATUS ITEM DETAIL: appends one result line.
line() {
  printf 'SANDBOX-PROBE %s %s: %s\n' "$1" "$2" "$3" >>"$result"
}

# The first non-empty line of $1, or "(no output)".
first() {
  local l
  l=$(printf '%s\n' "$1" | grep -m 1 -v '^[[:space:]]*$')
  printf '%s' "${l:-(no output)}"
}

# home-write: a sandboxed command cannot write in the home directory.
probe_file="$HOME/sandbox-probe"
if out=$(touch "$probe_file" 2>&1); then
  rm -f "$probe_file"
  line FAIL home-write "touch $probe_file succeeded (the file was removed again)"
else
  line PASS home-write "touch $probe_file refused: $(first "$out")"
fi

# network: a host outside the allowlist is refused.
out=$(curl -sS --max-time 20 -o /dev/null https://example.com 2>&1)
status=$?
if [ "$status" -eq 0 ]; then
  line FAIL network "curl https://example.com succeeded"
elif [ "$status" -eq 127 ]; then
  line FAIL network "curl was not found on PATH, so nothing was tested"
else
  line PASS network "curl https://example.com refused: $(first "$out")"
fi

# key <path>: a denied key is not readable.
for key in "$@"; do
  if test -r "$key"; then
    line FAIL "key $key" "readable"
  else
    line PASS "key $key" "not readable"
  fi
done

# ssh-config: stays readable, since sandboxed gh reads it to resolve a host alias.
if test -r "$HOME/.ssh/config"; then
  line PASS ssh-config "$HOME/.ssh/config is readable"
else
  line FAIL ssh-config "$HOME/.ssh/config is not readable"
fi

# gh: reaches GitHub with the token (a GraphQL call) and resolves the repo from this
# directory's remote.
if out=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>&1); then
  if printf '%s\n' "$out" | grep -qixF -- "$repo"; then
    line PASS gh "gh repo view printed $repo (compared case-insensitively)"
  else
    line FAIL gh "gh repo view printed $(first "$out"), not $repo"
  fi
else
  line FAIL gh "gh repo view failed: $(first "$out")"
fi

exit 0
