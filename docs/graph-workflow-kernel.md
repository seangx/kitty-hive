# Graph Workflow kernel

Hive now has two deliberately separate execution lanes:

1. **Ordinary Task** — the default. An assigned or claimed task enters
   `in_progress` immediately and finishes with `hive_task_complete`.
2. **Graph Workflow** — explicit only. The creator starts a configured template
   with `hive_workflow_start`; there is no proposal/approval ceremony before
   the first node.

The legacy linear proposal tools remain readable and executable for existing
tasks, but are no longer the default behavior or prompt.

## Persistence boundary

A graph definition is stored in the existing `tasks.workflow_json` column
with the discriminant:

```json
{
  "kind": "graph",
  "version": 1,
  "template_id": "review-test-release",
  "entry_node_id": "implement",
  "nodes": [],
  "edges": []
}
```

`tasks.current_step` stores the 1-based index of the current graph node. Every
activation and transition is append-only in `task_events` (`node-start`,
`node-complete`, `edge-taken`, `approval-request`, `approval-decision`). Cycles
therefore create new activations instead of overwriting rejected history.

Task-specific `workspace_dir` and `branch` are stored in the existing
`input_json` document. They are metadata for Kitty/agents and do not mutate the
Hive process cwd.

## Conditional execution

Edges select on one closed outcome:

- `passed`
- `changes_requested`
- `failed`

At most one edge may exist for `(from node, outcome)`. A negative result takes
its edge immediately. A positive result honors the node's `all`/`any`
completion policy. With no matching edge, `passed` completes the run and a
negative outcome fails it.

A gated node pauses in `awaiting_approval` after positive completion. Only the
task creator can call `hive_workflow_gate_decide`; the decision then selects the
corresponding edge.

## JSON templates

Templates live in `~/.kitty-hive/workflows/*.json` (override with
`KITTY_HIVE_WORKFLOWS_DIR`). Packaged examples are copied there only on first
initialization, so deleting one remains effective after restart. Hive reads
the directory for every list/start request; new runs see edits immediately,
while in-flight runs keep the definition snapshot stored in `workflow_json`.

Use the operator CLI for CRUD:

```text
kitty-hive workflow list [--json]
kitty-hive workflow get <id>
kitty-hive workflow create <file.json>
kitty-hive workflow update <id> <file.json>
kitty-hive workflow delete <id> [--yes]
```

The packaged `review-test-release` example encodes:

`review-test-release` encodes:

```text
implement → review → e2e → release-review → success
    ↑          │        │          │
    └──────────┴────────┴──────────┘ changes_requested
```

`$assignee`, `role:reviewer`, and `role:tester` are resolved to concrete agent
ids when the run starts. A later change to pool membership cannot silently
change an in-flight run.

Each node may additionally declare a runtime context policy:

```json
"context": { "mode": "fresh_per_activation" }
```

- `resident` (default) executes on the selected agent's persistent thread.
- `fresh_per_run` creates one isolated execution identity per workflow run and
  reuses it when the graph loops back.
- `fresh_per_activation` creates a new isolated identity on every node
  activation. It is suitable for independent review passes.

Fresh identities inherit the base agent's tool, roles, expertise, and the
workflow `workspace_dir` (falling back to the base project directory). They
are excluded from Pool routing and Sidecar Pool lists, and their runtime is
retired when its scope ends. The offline row remains as event/message audit
provenance.

## Agent Pool boundary

The Sidecar snapshot exposes resident local agents as `agentPool`. Entries are
`launchMode: resident` and include `enabled`. Disabled agents keep their
resident daemon and remain manually addressable by id/name, but `role:*`
selection excludes them. Operators can use:

```text
kitty-hive agent enable <agent>
kitty-hive agent disable <agent>
```

Kitty Inspector uses the equivalent loopback-only Pool endpoint.

## Tools

- `hive_workflow_templates` — list configured JSON graph templates.
- `hive_workflow_start` — explicitly create and start a graph run.
- `hive_workflow_node_complete` — report the current node outcome.
- `hive_workflow_gate_decide` — creator decision for a gated graph node.
- `hive_task` / `hive_task_complete` — ordinary task lane.
- `hive_workflow_propose` and numbered step tools — legacy linear lane.
