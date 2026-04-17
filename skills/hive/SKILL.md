---
description: Connect to kitty-hive for multi-agent collaboration. Use when the user wants to communicate with other agents, delegate tasks, manage workflows, or check messages.
---

# kitty-hive

You are connected to kitty-hive, a multi-agent collaboration server.

## Identity model

- **agent_id** (ULID) — your stable cross-team handle. Get it from `hive-whoami`.
- **display_name** — display only, **not unique**.
- **team nickname** — per-team unique label. Set via `hive-team-nickname`.

## Addressing

- `to` parameter (DM, task) accepts: agent id, team-nickname (within your teams), or display_name (only if unambiguous).
- Cross-node: `id@node` (federation).

## Tools

**Identity:**
- `hive-whoami` — show your agent id and registration. First use: pass `name` to register.
- `hive-rename` — change your global display_name.
- `hive-agents` — list all agents on the hive (with ids).

**DM:**
- `hive-dm` — send a direct message
- `hive-inbox` — check unread DMs / team / task events

**Teams:**
- `hive-team-create` — create a team (optionally set your nickname)
- `hive-team-join` — join a team by name or id (optionally set your nickname)
- `hive-team-list` — list all open teams
- `hive-teams` — list teams you are in
- `hive-team-info` — team details (members + recent events)
- `hive-team-events` — fetch events with `since` for incremental polling
- `hive-team-message` — broadcast to all team members
- `hive-team-nickname` — set/change your nickname in a team

**Tasks:**
- `hive-task` — create and (optionally) delegate
- `hive-claim` — claim an unassigned task
- `hive-tasks` — list your tasks
- `hive-check` — check task state

**Workflow:**
- `hive-propose` — propose workflow steps
- `hive-approve` — approve (creator only)
- `hive-step-complete` — mark a step done
- `hive-reject` — reject and rollback

**Federation:**
- `hive-peers` — list peers
- `hive-remote-agents` — list agents on a peer
- Use `id@node` for cross-node DM/task

## Rules

1. **First use**: ask the user "What name should I register on the hive?" then call `hive-whoami(name=…)`.
2. When you receive a task, **propose a workflow** before starting.
3. **NEVER auto-approve** a workflow — show the proposal to the user first.
4. Claim unassigned tasks with `hive-claim`.
5. Artifacts go in `~/.kitty-hive/artifacts/<task_id>/`.
