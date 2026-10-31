#!/usr/bin/env bash
# Default-deny egress firewall for the agent container. Root only.
#
#   init-firewall.sh apply    lock the network down, then allow DNS to the resolvers in /etc/resolv.conf,
#                             SSH to GitHub's git ranges and HTTPS to the allowlist below; verify by
#                             trying a refused and an allowed host
#   init-firewall.sh refresh  re-resolve the allowlist and re-add every entry, which resets its timeout;
#                             the rules are left alone, and on a failure the current entries stay
#
# Entries expire 12 refresh intervals (FIREWALL_REFRESH_SECONDS, default 300) after they were last
# added, so an address that stops resolving drops out, and a refresher that keeps failing closes the
# firewall instead of leaving stale addresses open. Exit 0 on success; non-zero with a message on
# stderr otherwise.
set -euo pipefail
shopt -s inherit_errexit
umask 077

# Reached over HTTPS, as well as GitHub's web, api and git ranges from https://api.github.com/meta.
https_hosts=(
  registry.npmjs.org
  results-receiver.actions.githubusercontent.com
  api.anthropic.com
  claude.ai
  claude.com
  platform.claude.com
  downloads.claude.ai
  raw.githubusercontent.com
)
github_api=api.github.com
git_set=fw-github-git # tcp 22 and 443
https_set=fw-https    # tcp 443

# api.github.com allows 60 unauthenticated requests an hour per address, so refresh re-uses the last
# good copy of GitHub's ranges for up to an hour; apply always fetches them.
state_dir=/run/init-firewall
ranges_file=$state_dir/github-ranges
ranges_max_age=3600

ipset_max_timeout=2147483
ipv4='([0-9]{1,3}\.){3}[0-9]{1,3}'

fail() {
  echo "init-firewall: $*" >&2
  exit 1
}

entry_timeout() {
  local interval=${FIREWALL_REFRESH_SECONDS:-300}
  [[ $interval =~ ^[1-9][0-9]*$ ]] || fail "FIREWALL_REFRESH_SECONDS must be a positive integer, not '$interval'"
  if (( ${#interval} > 6 || interval * 12 > ipset_max_timeout )); then
    echo "$ipset_max_timeout"
  else
    echo $(( interval * 12 ))
  fi
}

# Default DROP everywhere, loopback and replies allowed, IPv6 refused, DNS only to the configured resolvers.
lock_down() {
  local cmd mode nameservers ns
  for cmd in iptables ip6tables; do
    "$cmd" -P INPUT DROP
    "$cmd" -P FORWARD DROP
    "$cmd" -P OUTPUT DROP
    # The filter table only: Docker's DNS redirection lives in the nat table.
    "$cmd" -F
    "$cmd" -X
    "$cmd" -A INPUT -i lo -j ACCEPT
    "$cmd" -A OUTPUT -o lo -j ACCEPT
  done
  iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  ip6tables -A OUTPUT -p tcp -j REJECT --reject-with tcp-reset
  ip6tables -A OUTPUT -j REJECT --reject-with icmp6-adm-prohibited

  mode=$(stat -L -c %a /etc/resolv.conf)
  if [[ $(stat -L -c %u /etc/resolv.conf) != 0 ]] || (( (8#$mode & 8#022) != 0 )); then
    fail "/etc/resolv.conf must be owned by root and writable by root only"
  fi
  nameservers=$(awk '$1 == "nameserver" { print $2 }' /etc/resolv.conf | grep -E "^${ipv4}\$") \
    || fail "no IPv4 nameserver in /etc/resolv.conf"
  for ns in $nameservers; do
    iptables -A OUTPUT -d "$ns" -p udp --dport 53 -j ACCEPT
    iptables -A OUTPUT -d "$ns" -p tcp --dport 53 -j ACCEPT
  done
}

# Empty allowlist sets, the rules that use them, and an immediate refusal for everything else.
create_sets() {
  local existing set
  existing=$(ipset list -n)
  for set in "$git_set" "$https_set"; do
    if grep -qx "$set" <<<"$existing"; then
      ipset destroy "$set"
    fi
    ipset create "$set" hash:net family inet timeout "$timeout"
  done
  iptables -A OUTPUT -p tcp --dport 22 -m set --match-set "$git_set" dst -j ACCEPT
  iptables -A OUTPUT -p tcp --dport 443 -m set --match-set "$git_set" dst -j ACCEPT
  iptables -A OUTPUT -p tcp --dport 443 -m set --match-set "$https_set" dst -j ACCEPT
  iptables -A OUTPUT -p tcp -j REJECT --reject-with tcp-reset
  iptables -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited
}

require_sets() {
  local existing set
  existing=$(ipset list -n)
  for set in "$git_set" "$https_set"; do
    grep -qx "$set" <<<"$existing" || fail "ipset $set is missing; the firewall has not been applied"
  done
}

# Prints the IPv4 addresses a host resolves to; fails when there are none.
resolve() {
  local answer addrs
  answer=$(dig +short +time=3 +tries=2 A "$1") || fail "DNS lookup of $1 failed"
  addrs=$(grep -E "^${ipv4}\$" <<<"$answer") || fail "$1 has no IPv4 address"
  printf '%s\n' "$addrs"
}

# Prints "<set> <cidr>" lines for GitHub's IPv4 ranges: web and api to the HTTPS set, git to the git set.
fetch_github_ranges() {
  local meta lines cidr
  meta=$(curl -q -fsS --max-time 30 "https://$github_api/meta") || fail "fetching https://$github_api/meta failed"
  lines=$(jq -er --arg git_set "$git_set" --arg https_set "$https_set" '
    def v4($key):
      if (.[$key] | type) == "array" then [.[$key][] | select(contains(":") | not)]
      else error("no \($key) list") end;
    (v4("web") + v4("api")) as $https | v4("git") as $git
    | if ($https | length) == 0 or ($git | length) == 0 then error("no IPv4 ranges")
      else ($https[] | "\($https_set) \(.)"), ($git[] | "\($git_set) \(.)") end
  ' <<<"$meta") || fail "https://$github_api/meta lacks IPv4 web, api or git ranges"
  while read -r _ cidr; do
    [[ $cidr =~ ^${ipv4}/[0-9]{1,2}$ ]] || fail "https://$github_api/meta has a malformed range: $cidr"
  done <<<"$lines"
  printf '%s\n' "$lines"
}

# GitHub's ranges as "<set> <cidr>" lines; on refresh, the last good copy while it is fresh enough.
github_ranges() {
  local lines now saved
  if [[ $1 == refresh && -f $ranges_file ]]; then
    now=$(date +%s)
    saved=$(stat -c %Y "$ranges_file")
    if (( now - saved < ranges_max_age )); then
      cat "$ranges_file"
      return
    fi
  fi
  lines=$(fetch_github_ranges)
  install -d -m 0700 "$state_dir"
  printf '%s\n' "$lines" >"$ranges_file.new"
  mv -f "$ranges_file.new" "$ranges_file"
  printf '%s\n' "$lines"
}

# Adds "<set> <entry>" lines from stdin; with -exist a re-added entry gets a fresh timeout.
add_entries() {
  awk -v timeout="$timeout" 'NF == 2 { print "add", $1, $2, "timeout", timeout }' | ipset -exist restore
}

# api.github.com goes in first, so the meta fetch reaches it even after its address changes. The rest is
# gathered before anything is added, so a failure adds nothing.
load_allowlist() {
  local addrs host entries=""
  addrs=$(resolve "$github_api")
  awk -v set="$https_set" '{ print set, $0 }' <<<"$addrs" | add_entries
  for host in "${https_hosts[@]}"; do
    addrs=$(resolve "$host")
    entries+=$(awk -v set="$https_set" '{ print set, $0 }' <<<"$addrs")$'\n'
  done
  entries+=$(github_ranges "$1")
  add_entries <<<"$entries"
}

verify() {
  if curl -q -sS -o /dev/null --max-time 10 https://example.com 2>/dev/null; then
    fail "https://example.com is reachable, so the firewall is not working"
  fi
  # /rate_limit does not count against api.github.com's rate limit.
  curl -q -sS -o /dev/null --max-time 20 "https://$github_api/rate_limit" \
    || fail "https://$github_api is unreachable through the firewall"
}

entries_in() {
  ipset list -t "$1" | awk -F': ' '$1 == "Number of entries" { print $2 }'
}

(( EUID == 0 )) || fail "must run as root"
timeout=$(entry_timeout)
case "${1:-}:$#" in
  apply:1)
    lock_down
    create_sets
    load_allowlist apply
    verify
    echo "init-firewall: applied; $(entries_in "$https_set") HTTPS and $(entries_in "$git_set") git entries, each expiring ${timeout}s after its last refresh"
    ;;
  refresh:1)
    require_sets
    load_allowlist refresh
    ;;
  *)
    echo "usage: init-firewall.sh apply|refresh" >&2
    exit 2
    ;;
esac
