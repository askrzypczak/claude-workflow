#!/usr/bin/env bash
# Self-test for update-prs.sh against a local bare origin and a fake gh. Usage: scripts/test-update-prs.sh
set -uo pipefail

update="$(cd "$(dirname "$0")" && pwd)/update-prs.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export PLUGIN_DIR=plugins/p GH_LOG=$tmp/gh.log
manifest=$PLUGIN_DIR/.claude-plugin/plugin.json

fail=0
expect() { # name expected actual
  if [ "$3" != "$2" ]; then echo "FAIL $1: expected '$2', got '$3'"; fail=1; else echo "ok   $1"; fi
}

# Fake gh: PR 7 is same-repo on branch feat, PR 8 a fork; logs every call.
mkdir "$tmp/bin"
cat >"$tmp/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "gh $*" >>"$GH_LOG"
case "$1 $2 $3" in
  "pr list "*) printf '7\n8\n' ;;
  "pr view 7") if [[ $* == *headRefName* ]]; then echo "false main feat"; else echo "Feature (0.15.0)"; fi ;;
  "pr view 8") echo "true main feat" ;;
esac
EOF
chmod +x "$tmp/bin/gh"

set_version() { mkdir -p "$PLUGIN_DIR/.claude-plugin" && printf '{\n  "version": "%s"\n}\n' "$1" >"$manifest"; }

# origin: feat raised 0.14.0 -> 0.15.0, then main took 0.15.0 too
git init -q --bare -b main "$tmp/origin.git"
git init -q -b main "$tmp/dev" && cd "$tmp/dev" || exit 1
set_version 0.14.0 && echo a >"$PLUGIN_DIR/skill.md" && git add . && git commit -qm base
git switch -qc feat && echo b >"$PLUGIN_DIR/skill.md" && set_version 0.15.0 && git commit -qam feat
git switch -q main && echo c >"$PLUGIN_DIR/other.md" && set_version 0.15.0 && git add . && git commit -qm other
git -C "$tmp/origin.git" fetch -q "$tmp/dev" main:main feat:feat

git clone -q "$tmp/origin.git" "$tmp/runner" && cd "$tmp/runner" || exit 1
PATH="$tmp/bin:$PATH" bash "$update" >"$tmp/out" 2>&1
expect "exits 0" 0 $?
expect "pushes feat with main merged in" 0 "$(git -C "$tmp/origin.git" merge-base --is-ancestor main feat; echo $?)"
expect "re-bumps feat past main" 0.16.0 "$(git -C "$tmp/origin.git" show "feat:$manifest" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')"
expect "retitles" 1 "$(grep -c -- 'pr edit 7 --title Feature (0.16.0)' "$GH_LOG")"
expect "comments" 1 "$(grep -c -- 'pr comment 7' "$GH_LOG")"
expect "dispatches ci on feat" 1 "$(grep -c -- 'workflow run ci.yml --ref feat' "$GH_LOG")"
expect "skips the fork" 1 "$(grep -c '#8: skipped' "$tmp/out")"
expect "removes its worktrees" 1 "$(git worktree list | wc -l | tr -d ' ')"

# second run: already up to date, nothing pushed or dispatched
cp "$GH_LOG" "$tmp/gh1.log"; : >"$GH_LOG"
before=$(git -C "$tmp/origin.git" rev-parse feat)
PATH="$tmp/bin:$PATH" bash "$update" >"$tmp/out" 2>&1
expect "rerun exits 0" 0 $?
expect "rerun leaves feat" "$before" "$(git -C "$tmp/origin.git" rev-parse feat)"
expect "rerun dispatches nothing" 0 "$(grep -c 'workflow run' "$GH_LOG")"

[ $fail -eq 0 ] || cat "$tmp/gh1.log" "$tmp/out"
exit $fail
