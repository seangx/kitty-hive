#!/bin/bash
# PostToolUse hook: sync hive task to Apple Reminders
# stdin: {"tool_name":"...","tool_input":{...},"tool_response":{"content":[{"text":"..."}]}}

INPUT=$(cat)
RESPONSE_TEXT=$(echo "$INPUT" | jq -r '.tool_response.content[0].text // empty' 2>/dev/null)
[ -z "$RESPONSE_TEXT" ] && exit 0

TITLE=$(echo "$RESPONSE_TEXT" | jq -r '.title // empty' 2>/dev/null)
[ -z "$TITLE" ] && exit 0

STATUS=$(echo "$RESPONSE_TEXT" | jq -r '.status // "created"' 2>/dev/null)

osascript <<EOF
tell application "Reminders"
  if not (exists list "kitty-hive") then
    make new list with properties {name:"kitty-hive"}
  end if
  make new reminder in list "kitty-hive" with properties {name:"${TITLE} [${STATUS}]"}
end tell
EOF
