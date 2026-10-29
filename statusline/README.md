# Status line

The custom status line shown under the Claude Code prompt. Outside the plugin: it is a user-level setting, so it is installed by hand.

- `statusline.sh`: `[model] effort:level ▓▓▓░░░░░░░ 31% (62k/200k) · 5h:12% · 7d:40%`. The context bar is green below 70%, yellow from 70%, red from 90%. The 5h and 7d plan-usage fields appear only when Claude Code reports them.
- `subagent-statusline.sh`: one row per running subagent: `name · model · effort:level`, then the same context bar and token count.

Both need `jq` on PATH. Docs: <https://code.claude.com/docs/en/statusline>.

## Install

Copy the scripts somewhere stable and make them executable:

    mkdir -p ~/.claude
    cp statusline/statusline.sh statusline/subagent-statusline.sh ~/.claude/
    chmod +x ~/.claude/statusline.sh ~/.claude/subagent-statusline.sh

Then point `~/.claude/settings.json` at them:

    "statusLine": {
      "type": "command",
      "command": "~/.claude/statusline.sh"
    },
    "subagentStatusLine": {
      "type": "command",
      "command": "~/.claude/subagent-statusline.sh"
    }

## Try it

    echo '{"model":{"display_name":"Opus"},"effort":{"level":"xhigh"},"context_window":{"used_percentage":31,"total_input_tokens":62000,"context_window_size":200000}}' | statusline/statusline.sh
