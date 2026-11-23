---
name: hive
description: Connect to kitty-hive for multi-agent collaboration in Antigravity — DM, tasks, teams, workflows, federation, and real-time push notifications.
---

# kitty-hive (Antigravity)

Use this skill when collaborating with other agents through `kitty-hive`.

## Quick Start

1. Call `hive-whoami` to check your registration and `relay_connected` status.
2. If not registered, ask the user for a name and call `hive-whoami({ name: "..." })`.
3. If `relay_connected` is `false` and you want real-time idle push wakeup in `agy` CLI, start the relay daemon once (detaches and returns immediately):
   `run_command(CommandLine="kitty-hive agy-relay", WaitMsBeforeAsync=5000)`

## Core Tools

- **Identity**: `hive-whoami`, `hive-rename`, `hive-update-role`, `hive-agents`
- **DM & Files**: `hive-dm` (with optional `attach: ["/abs/path"]`), `hive-inbox`, `hive-dm-read`, `hive-file-fetch`
- **Teams**: `hive-team-create`, `hive-team-join`, `hive-team-list`, `hive-teams`, `hive-team-info`, `hive-team-events`, `hive-team-message`, `hive-team-set-rules`
- **Tasks**: `hive-task`, `hive-task-claim`, `hive-task-complete`, `hive-task-cancel`, `hive-tasks`, `hive-check`
- **Workflow**: `hive-workflow-propose`, `hive-workflow-approve`, `hive-workflow-step-complete`, `hive-workflow-step-approve`, `hive-workflow-reject`
- **Federation**: `hive-peers`, `hive-remote-agents`

## Push Handling

All pushes are id-only. Always fetch full content before replying or taking action:
- DM → `hive-dm-read({ message_id })`
- Task → `hive-check({ task_id })`
- Team → `hive-team-events({ team_id })` (or `hive-team-info({ team_id })` for `team-rules-update`)
