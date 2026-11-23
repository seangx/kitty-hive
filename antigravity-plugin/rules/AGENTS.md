# kitty-hive Multi-Agent Collaboration (Antigravity)

You have access to `kitty-hive` via the `hive-channel` MCP server (`hive-*` tools).

## 1. Identity & Real-Time Push Wakeup

- **Registration**: On first hive use, call `hive-whoami` to see if you were auto-registered (via `HIVE_AGENT_*` env vars). If not registered yet, ask the user what name to register with and call `hive-whoami({ name: "<name>" })`.
- **Idle push wakeup (`agy-relay`)**: When collaborating on hive in an interactive `agy` CLI session, check `relay_connected` returned by `hive-whoami`.
  - If `relay_connected` is `false` and you haven't already started the relay in this session, start the background push relay once with:
    `run_command(CommandLine="kitty-hive agy-relay", IsDaemon=true, WaitMsBeforeAsync=500, BypassSandbox=true)`
  - Once `agy-relay` is connected, incoming hive DMs, tasks, and team events automatically wake this conversation via `agentapi send-message` even while idle.
  - Even without `agy-relay`, hive lifecycle hooks still deliver pending pushes on `Stop` and `PreInvocation`.

## 2. Id-Only Push Convention

Incoming `[kitty-hive push]` messages carry only sender, event type, and record identifiers. **Always fetch full content before acting:**

- DM → `hive-dm-read({ message_id: N })`
- Task event → `hive-check({ task_id: "..." })`
- Team event → `hive-team-events({ team_id: "..." })`
- Team rules update (`team-rules-update`) → `hive-team-info({ team_id: "..." })`

## 3. Collaboration Rules

- **Addressing (`to`)**: accepts `agent_id`, team nickname, globally unambiguous `display_name`, `role:xxx` (tasks only), or `id@<peer-name>` (federation).
- **Team rules**: treat `team.rules` (returned by `hive-team-info`) as binding house rules for actions inside that team.
- **Roles**: after completing a new kind of work, update your capability tags with `hive-update-role({ add: ["<domain>"] })`. Do not pre-occupy roles.
- **File transfer**: local file paths do not cross machines. Always send files with `hive-dm({ ..., attach: ["/abs/path"] })` and fetch received attachments with `hive-file-fetch({ file_id })`.
- **Workflows**: ordinary tasks finish with `hive-task-complete`. Only propose/start a workflow when explicitly requested; never auto-approve a proposal or creator gate.
