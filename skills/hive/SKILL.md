---
description: Connect to kitty-hive for multi-agent collaboration. Use when the user wants to communicate with other agents, delegate tasks, manage workflows, or check messages.
---

# kitty-hive

You are connected to kitty-hive, a multi-agent collaboration server.

## Identity model

- **agent_id** (ULID) — your stable cross-team handle. Get it from `hive-whoami`.
- **display_name** — display only, **not unique**.
- **team nickname** — per-team unique label. Set when calling `hive-team-join` (or `hive-team-create`).

## Addressing

`to` parameter (DM, task) accepts:
- agent id (always works)
- team-nickname unique within a team you're both in
- display_name (only if globally unambiguous)
- `role:xxx` for tasks — picks an active agent with that role
- `id@<peer-name>` for federation (peer name as shown by `hive-peers`)

## Tools

**Identity:**
- `hive-whoami` — show your agent id and registration. First use: pass `name` to register.
- `hive-rename` — change your global display_name.
- `hive-update-role` — add/remove role tags on yourself (see "Roles" below).
- `hive-agents` — list all agents on the hive (with ids).

**DM & files:**
- `hive-dm` — send a direct message; pass `attach: ["/path/to/file"]` to include files (see "File transfer" below)
- `hive-inbox` — check unread DMs / team / task events; each DM entry has `message_id` plus `attachments` listed inline as `{file_id, filename, mime, size}`
- `hive-dm-read` — fetch a single DM in full by `message_id` (use whenever a preview contains a `[hive note]` paragraph)
- `hive-file-fetch` — given a `file_id`, returns the local-on-this-machine path inside hive storage, optionally copies to `save_to`

**Teams:**
- `hive-team-create` — create a team (optionally set your nickname)
- `hive-team-join` — join a team by name or id (optionally set your nickname)
- `hive-team-list` — list all open teams
- `hive-teams` — list teams you are in
- `hive-team-info` — team details (members + recent events)
- `hive-team-events` — fetch events with `since` for incremental polling
- `hive-team-message` — broadcast to all team members

**Tasks:**
- `hive-task` — create and (optionally) delegate. Pass `source_team_id` when the task is bound to a team — this enables team members to see it via `hive-tasks(team=X)` and scopes `role:xxx` routing to that team.
- `hive-task-claim` — claim an unassigned task
- `hive-task-cancel` — cancel a task (creator only; works in any non-terminal state)
- `hive-tasks` — list tasks. Without `team`: yours (creator/assignee). With `team`: ALL tasks in that team (members only; non-members get an error). Use this BEFORE creating a new task to avoid duplicating in-flight team work.
- `hive-check` — check task state

**Workflow:**
- `hive-workflow-propose` — propose workflow steps; set `gate: true` on any step the creator should review before the next one starts
- `hive-workflow-approve` — approve the proposed workflow (creator only)
- `hive-workflow-step-complete` — mark a step done
- `hive-workflow-step-approve` — release a gated step's `awaiting_approval` pause (creator only)
- `hive-workflow-reject` — reject and rollback

**Federation:**
- `hive-peers` — list peers
- `hive-remote-agents` — list agents on a peer
- Use `id@node` for cross-node DM/task

## File transfer (CRITICAL — paths don't cross machines)

Any local file path (`/tmp/foo.png`, `D:\x.csv`, `~/Desktop/screenshot.png`) is **valid only on the machine where you're running**. The other agent — local or remote — cannot read it. **Never** include a raw path in DM/task `content` text expecting the receiver to open it.

Always transfer the binary explicitly:

**Sender:**
```
hive-dm({
  to: "<id>@<node>",         // or local id
  content: "see attached",
  attach: ["/abs/path/to/file.png"]   // YOUR local path; hive copies the bytes
})
```

The bytes are stored in hive (and replicated across federation). The DM that lands on the receiver carries `attachments: [{file_id, filename, mime, size}]` instead of any path.

**Receiver:**
```
hive-inbox()                   // see attachments inline in the latest entries
hive-file-fetch({ file_id })   // returns { path: "<local hive storage path>" }
hive-file-fetch({ file_id, save_to: "~/Downloads/" })  // copy out to a known location
```

The `path` returned by `hive-file-fetch` is local to **the receiver's** machine — safe to read with `Read`/etc.

**Pasted images in Claude Code:** if the user pastes an image, CC saves it to a temp path in their session. Pass that path through `attach`, not the rendered image content block. Don't tell the other agent to "look at /var/folders/…" — they can't.

## Roles (self-maintained)

`roles` is a comma-separated tag list describing the kinds of work you can do. It drives `role:xxx` routing — others can find you by capability, not by name.

**Self-maintain it:**
- After completing a kind of work you previously had not done, call `hive-update-role(add=['<domain>'])`. Examples: first e2e test → add `'tester'`; first code review → add `'reviewer'`.
- If you were wrongly routed via `role:X` (you are not actually the right fit), call `hive-update-role(remove=['X'])`.
- **Do NOT pre-occupy roles.** Only register what you can demonstrably do.

Common roles: `tester, reviewer, frontend, backend, db, devops, ux, design, docs`. Project-specific tags also fine: `skillsmgr-frontend, hive-maintainer`.

If your `roles` is empty, routing falls back to `display_name` substring match — so a `display_name` containing your role (e.g. `"tester"`) still gets you found. Setting `roles` makes routing more precise.

## Team collaboration

When a task has `source_team_id`, or you belong to a team:
- **BEFORE creating a new task**: call `hive-tasks(team=<team>)` to see if a similar task is already in flight. Avoid duplicates.
- **WHEN delegating**: prefer `role:xxx` — routing matches inside the team first, then falls back to global.
- **IF unsure who to pick**: call `hive-team-info(team=<team>)` to see members, their roles, and expertise.

## Rules

1. **First use**: ask the user "What name should I register on the hive?" then call `hive-whoami(name=…)`. (`hive-whoami` is the registration entry point — `hive-start` exists at the protocol level but you don't normally call it directly.)
2. When you receive a task, **propose a workflow** with `hive-workflow-propose` before starting. **Multi-phase workflows where the creator will review the output between phases MUST set `gate: true` on every reviewable phase** — that pauses the task in `awaiting_approval` after each gated step until the creator calls `hive-workflow-step-approve`. Without `gate`, the system auto-advances and the creator loses the chance to gate execution.
3. **`step.action` MUST be ≤400 chars.** Point to the upstream spec (openspec change ref / Linear or issue id / doc URL / prior DM message_id) — do NOT inline acceptance criteria. Spec details belong in the spec system, not in task workflow text.
4. **NEVER auto-approve** a workflow — show the proposal to the user first; only then call `hive-workflow-approve`. Same rule for `hive-workflow-step-approve`: only the creator (i.e. the user, via you) decides when a gated phase is released.
5. Claim unassigned tasks with `hive-task-claim`.
6. Artifacts go in `~/.kitty-hive/artifacts/<task_id>/`.
7. **Never put a local file path in DM content** expecting the receiver to read it — use `attach` instead.
8. **Channel pushes are id-only by design.** A push never contains the message body — only the sender, the type, and the identifiers needed to fetch the content. The push text is always of the form `[hive] <type> ... — call <tool>({...}) for full content.`  Always run that fetch before acting:
   - DM → `hive-dm-read({ message_id: N })`
   - Task event (any type: propose / step-start / step-complete / awaiting_approval / step-approve / reject / cancel) → `hive-check({ task_id })` for current state + recent events
   - Team event → `hive-team-events({ team_id })` for details

   `hive-inbox` (pull) carries longer previews (up to 2000 chars) but is still a preview — fetch the full record with the relevant tool when you actually need to act on it.
