#!/usr/bin/env bash
# PreToolUse hook (matcher: Bash). Enforces: agents may push their own branch, never main/master,
# never force-push, and never merge PRs. Text matching only, so it is a guardrail, not a security boundary.
# Known limits: `x=git; $x push ...` and `gh alias set` are not detected.
# Input: hook JSON on stdin. Deny = exit 2 with the reason on stderr; allow = exit 0.
set -uo pipefail

input=$(cat)
cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
cwd=$(jq -r '.cwd // empty' <<<"$input")
[ -z "$cmd" ] && exit 0

deny() {
  echo "guard-git: $1" >&2
  exit 2
}

# Raw checks: the segmenter below turns quotes/backticks into separators, which would hide refspecs
# like HEAD:ma''in or HEAD:$(echo main), quoted aliases and quoted API queries. Split only on command
# separators here. `git` counts only in command position (segment start after VAR=val prefixes, after
# `sh -c '`, `$(`, `(` or a backtick), so commit messages and PR titles that mention "git push" are fine.
raw=$(printf '%s' "$cmd" | tr '\n' ';' | sed -E 's/&&|\|\||[|;&]/;/g' | tr ';' '\n')
q="['\"]"
cmdpos="(^|\$\(|\`|[(]|(sh|bash|zsh)[[:space:]]+-c[[:space:]]+$q)[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*([^[:space:]]*/)?"
push_re="${cmdpos}git([[:space:]][^'\"\`\$]*)?[[:space:]]push([[:space:]](.*))?\$"
not_literal='[^[:alnum:][:space:]._/:@^~+=<>-]'
alias_re="(^|[ /])git .*(-c ?|--config(-env)?[= ])${q}?alias\\."
alias_env_re="GIT_CONFIG_KEY_[0-9]+=${q}?alias\\."
gh_api_re='(^|[ /])gh( [^ ]*)* api .*merge'
while IFS= read -r rseg; do
  if [[ "$rseg" =~ $push_re ]]; then
    tail="${BASH_REMATCH[${#BASH_REMATCH[@]} - 1]}"
    if [[ "$tail" =~ $not_literal ]]; then
      deny "push arguments must be plain literals (found '${BASH_REMATCH[0]}' in: $tail)"
    fi
  fi
  if [[ "$rseg" =~ $alias_re ]] || [[ "$rseg" =~ $alias_env_re ]]; then
    deny "git aliases via -c/--config/GIT_CONFIG_KEY are not allowed"
  fi
  shopt -s nocasematch
  if [[ "$rseg" =~ $gh_api_re ]]; then
    shopt -u nocasematch
    deny "merging via the API is human-only"
  fi
  shopt -u nocasematch
done <<<"$raw"

# Treat quotes, subshells and backticks as separators so `sh -c 'git push ...'` and $(...) are still seen.
segments=$(printf '%s' "$cmd" | tr '\n' ';' | sed -E "s/&&|\|\||[|;&()\`\"']/;/g" | tr ';' '\n')

is_cmd() { # token basename check: is_cmd gh /opt/homebrew/bin/gh
  [ "$2" = "$1" ] || [[ "$2" == */"$1" ]]
}

while IFS= read -r seg; do
  # shellcheck disable=SC2086
  set -- $seg
  [ $# -eq 0 ] && continue

  # --- PR merges: human only (gh by basename, global flags tolerated) ---
  toks=("$@")
  for ((i = 0; i < ${#toks[@]}; i++)); do
    is_cmd gh "${toks[i]}" || continue
    j=$((i + 1))
    while [ $j -lt ${#toks[@]} ]; do
      case "${toks[j]}" in
        -R|--repo|--hostname) j=$((j + 2)) ;;
        -*) j=$((j + 1)) ;;
        *) break ;;
      esac
    done
    if [ "${toks[j]:-}" = "pr" ]; then
      j=$((j + 1))
      while [ $j -lt ${#toks[@]} ]; do
        case "${toks[j]}" in
          -R|--repo|--hostname) j=$((j + 2)) ;;
          -*) j=$((j + 1)) ;;
          *) break ;;
        esac
      done
      [ "${toks[j]:-}" = "merge" ] && deny "merging PRs is human-only"
      continue
    fi
    if [ "${toks[j]:-}" = "api" ]; then
      for ((k = j + 1; k < ${#toks[@]}; k++)); do
        case "${toks[k]}" in *merge*) deny "merging via the API is human-only" ;; esac
      done
    fi
  done

  # --- git: find the binary by basename, drop everything before it ---
  gi=-1
  for ((i = 0; i < ${#toks[@]}; i++)); do
    if is_cmd git "${toks[i]}"; then gi=$i; break; fi
  done
  [ $gi -lt 0 ] && continue
  set -- "${toks[@]:gi}"

  # Aliases can hide a push from text matching.
  for tok in "$@"; do
    case "$tok" in
      alias.*|-calias.*|--config=alias.*) deny "git aliases via -c/--config are not allowed" ;;
    esac
  done

  # --- git push ---
  case " $* " in *" push "*) ;; *) continue ;; esac

  # Skip to the tokens after `push`.
  while [ $# -gt 0 ] && [ "$1" != "push" ]; do
    case "$1" in
      -C|--git-dir*|--work-tree*) deny "run git push from your own worktree without -C/--git-dir/--work-tree" ;;
    esac
    shift
  done
  shift || true

  positional=()
  for tok in "$@"; do
    case "$tok" in
      --force*|-f|--delete|-d|--mirror|--prune) deny "force/delete/mirror pushes are not allowed ($tok)" ;;
      +*) deny "force refspec (+) is not allowed ($tok)" ;;
      :*) deny "deleting remote refs is not allowed ($tok)" ;;
      -*) ;;
      *) positional+=("$tok") ;;
    esac
  done

  # positional[0] is the remote; the rest are refspecs.
  refspecs=("${positional[@]:1}")
  for ref in "${refspecs[@]+"${refspecs[@]}"}"; do
    if [[ "$ref" =~ (^|:)(refs/heads/)?(main|master)$ ]]; then
      deny "pushing to main/master is not allowed ($ref)"
    fi
  done

  # Bare push or HEAD push: check what branch we are actually on.
  if [ ${#refspecs[@]} -eq 0 ] || printf '%s\n' "${refspecs[@]}" | grep -qx 'HEAD'; then
    branch=$(git -C "${cwd:-.}" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
    case "$branch" in
      main|master|HEAD|"") deny "refusing to push from branch '${branch:-unknown}'; push a feature branch (issue-N-slug)" ;;
    esac
  fi
done <<<"$segments"

exit 0
