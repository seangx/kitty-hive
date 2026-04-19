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
- `hive-team-nickname` — set/change your nickname in a team

**Tasks:**
- `hive-task` — create and (optionally) delegate
- `hive-task-claim` — claim an unassigned task
- `hive-tasks` — list your tasks
- `hive-check` — check task state

**Workflow:**
- `hive-workflow-propose` — propose workflow steps
- `hive-workflow-approve` — approve (creator only)
- `hive-workflow-step-complete` — mark a step done
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

## Rules

1. **First use**: ask the user "What name should I register on the hive?" then call `hive-whoami(name=…)`. (`hive-whoami` is the registration entry point — `hive-start` exists at the protocol level but you don't normally call it directly.)
2. When you receive a task, **propose a workflow** with `hive-workflow-propose` before starting.
3. **NEVER auto-approve** a workflow — show the proposal to the user first; only then call `hive-workflow-approve`.
4. Claim unassigned tasks with `hive-task-claim`.
5. Artifacts go in `~/.kitty-hive/artifacts/<task_id>/`.
6. **Never put a local file path in DM content** expecting the receiver to read it — use `attach` instead.
7. **Previews are not full messages.** Channel pushes carry only the first 200 characters of a DM; `hive-inbox` carries the first 2000. When the message is longer or has attachments, the preview ends with a `[hive note]` paragraph that lists the exact tool calls you must make to fetch the rest. **You MUST follow those instructions before acting on the visible content.** The `[hive note]` block is part of the protocol, not a hint — ignoring it means you act on incomplete data. The block may include:
   - `hive-dm-read({ message_id: N })` — fetch the full text
   - `hive-file-fetch({ file_id })` — open each attachment listed by filename and `file_id`
   In doubt, fetch first.
