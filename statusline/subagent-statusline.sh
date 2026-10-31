#!/bin/bash
# Claude Code subagent row: agentType · model · effort · context bar (tokens)
# Reads {"tasks":[...]} on stdin; writes one {"id","content"} JSON line per row.
# See https://code.claude.com/docs/en/statusline#subagent-status-lines

jq -c '
  def human: if . >= 1000000 then "\((. / 100000 | floor) / 10)M"
             elif . >= 10000 then "\(. / 1000 | floor)k"
             elif . >= 1000 then "\((. / 100 | floor) / 10)k"
             else tostring end;
  def dim(s): "\u001b[2m" + s + "\u001b[0m";

  .tasks[]? | {
    id,
    content: ((
      [ (.name // .agentType // "agent"),
        (.model // "…" | sub("^claude-"; "")),
        (if .effort != null then dim("effort:") + (.effort | tostring) else empty end)
      ] | join(" · ")
    ) + (
      if (.contextWindowSize // 0) > 0 then
        (((.tokenCount / .contextWindowSize * 100) | floor) as $p
         | ($p / 10 | floor | if . > 10 then 10 else . end) as $f
         | " " + (if $p >= 90 then "\u001b[31m" elif $p >= 70 then "\u001b[33m" else "\u001b[32m" end)
           + ("▓" * $f) + ("░" * (10 - $f)) + "\u001b[0m \($p)% "
           + dim("(\(.tokenCount | human)/\(.contextWindowSize | human))"))
      else " " + dim("(\(.tokenCount // 0 | human))") end
    ))
  }'
