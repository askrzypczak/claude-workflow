#!/usr/bin/env bash
# PreToolUse hook (matcher: Bash). Enforces: agents may push their own branch, never main/master,
# never force-push, and never merge PRs. Text matching only, so it is a guardrail, not a security boundary.
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

# Treat quotes, subshells and backticks as separators so `sh -c 'git push ...'` and $(...) are still seen.
segments=$(printf '%s' "$cmd" | tr '\n' ';' | sed -E "s/&&|\|\||[|;&()\`\"']/;/g" | tr ';' '\n')

while IFS= read -r seg; do
  # shellcheck disable=SC2086
  set -- $seg
  [ $# -eq 0 ] && continue

  # --- PR merges: human only ---
  case " $seg " in
    *" gh pr merge "*) deny "merging PRs is human-only" ;;
    *" gh api "*merge*) deny "merging via the API is human-only" ;;
  esac

  # --- git push ---
  case " $seg " in *" git "*" push "*|*" git push "*) ;; *) continue ;; esac

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
