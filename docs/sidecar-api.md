# Kitty Sidecar read API

The Sidecar API is a loopback-only operator view over Hive's authoritative
`tasks` and `task_events` tables. It does not create a second workflow state
machine. Native graph workflows are returned directly; legacy linear workflows
are still projected into the same graph-shaped read model.

Base URL: `http://127.0.0.1:4123/admin/sidecar`

## Reads

- `GET /snapshot?limit=200`
  - `{ version, generatedAt, runs, tasks, agentBadges, agentPool }`
  - `runs` contains tasks with `workflow_json`; `tasks` contains standalone
    tasks; `agentBadges` contains only non-terminal work.
  - `agentPool` contains authoritative local registered agents. Current entries
    are resident agents; no on-demand launcher is implied.

`agentPool[]` raw shape:

```json
{
  "agentId": "...",
  "displayName": "Reviewer",
  "tool": "codex",
  "roles": ["reviewer"],
  "expertise": "optional",
  "status": "active",
  "projectDir": "/repo",
  "launchMode": "resident"
}
```

`status` is the Hive agent presence state (`active | idle | busy | offline`),
not task execution state. Kitty should combine it with `agentBadges` when it
needs to render `working` versus `idle`.
- `GET /runs/:taskId`
  - graph, activation-preserving node runs, approvals, and taken edge ids.
- `GET /runs/:taskId/events?since=<cursor>`
  - `{ events, nextCursor }`; cursors are the task's monotonic event sequence.
- `GET /tasks/:taskId`
  - standalone task detail and attempts.

All public fields are camelCase. Agent-facing fields include stable ids
(`assigneeAgentId`, `assigneeAgentIds`, `agentId`) in addition to display names
so Kitty can focus the matching SessionDeck terminal without guessing by name.
Run/task summaries also expose optional `workspaceDir` and `branch` metadata.

## Wake subscription

`GET /events` is an SSE stream. It emits:

```text
event: wake
data: {"taskId":"...","runId":"...","cursor":7}
```

The payload is a wake signal only. It is not state and must never be reduced
into UI state. On every wake, re-read `/snapshot`; if the selected run matches,
also re-read its detail and catch up `/events?since=<last cursor>`.

The server sends a comment heartbeat every 25 seconds. Clients should reconnect
with bounded exponential backoff and keep the previous authoritative snapshot
visible while disconnected.

## Projection boundaries

- Native graph definitions retain their node and edge ids exactly.
- Existing linear Hive steps become projected graph nodes.
- Normal advancement becomes a `passed` edge.
- `on_reject: revise` becomes a self-edge; `back:N` becomes a back-edge.
- Every `step-start` creates a new node activation; rejected history is never
  overwritten in the read model.
- `proposing` and gated `awaiting_approval` both map to an explicit creator
  approval state.
- Standalone task `proposing` maps to UI status `claimed`; the legacy name is
  not exposed to the renderer.
