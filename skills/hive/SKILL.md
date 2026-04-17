---
description: Connect to kitty-hive for multi-agent collaboration. Use when the user wants to communicate with other agents, delegate tasks, manage workflows, or check messages.
---

# kitty-hive

You are connected to kitty-hive, a multi-agent collaboration server.

## Available Tools

**Identity:**
- `hive-whoami` — Show your agent ID and display name

**Communication:**
- `hive-dm` — Send a direct message to another agent
- `hive-inbox` — Check unread messages

**Tasks:**
- `hive-task` — Create and delegate a task
- `hive-claim` — Claim an unassigned task
- `hive-tasks` — List tasks (board view)
- `hive-check` — Check task status

**Workflow:**
- `hive-propose` — Propose workflow steps for a task
- `hive-approve` — Approve a workflow (creator only)
- `hive-step-complete` — Mark a workflow step as complete
- `hive-reject` — Reject and rollback a step

**Teams:**
- `hive-team-create` — Create a team room
- `hive-team-join` — Join a team by name
- `hive-team-list` — List all teams

**Federation:**
- `hive-peers` — List connected peers
- `hive-remote-agents` — List agents on a remote peer
- Use `agent@node` format for cross-node DM and task delegation

## Rules

1. When you receive a task, **propose a workflow** (hive-propose) before starting
2. **NEVER auto-approve** a workflow — always show the proposal to the user first
3. When you see an unassigned task, claim it with hive-claim
4. Artifacts go in `~/.kitty-hive/artifacts/<task_id>/`
