# Graph Workflow kernel

Hive now has two deliberately separate execution lanes:

1. **Ordinary Task** — the default. An assigned or claimed task enters
   `in_progress` immediately and finishes with `hive_task_complete`.
2. **Graph Workflow** — explicit only. The creator starts a predefined template
   with `hive_workflow_start`; there is no proposal/approval ceremony before
   the first node.

The legacy linear proposal tools remain readable and executable for existing
tasks, but are no longer the default behavior or prompt.

## Persistence boundary

No database schema is added. A graph definition is stored in the existing
`tasks.workflow_json` column with the discriminant:

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

## Built-in template

`review-test-release` encodes:

```text
implement → review → e2e → release-review → success
    ↑          │        │          │
    └──────────┴────────┴──────────┘ changes_requested
```

`$assignee`, `role:reviewer`, and `role:tester` are resolved to concrete agent
ids when the run starts. A later change to pool membership cannot silently
change an in-flight run.

## Agent Pool boundary

The Sidecar snapshot exposes the real registered local agents as `agentPool`.
These entries are `launchMode: resident`; their tool, roles, status, expertise,
and project directory come from Hive's authoritative agent records. On-demand
profile launch/destruction is intentionally not faked by this kernel.

## Tools

- `hive_workflow_templates` — list predefined graph templates.
- `hive_workflow_start` — explicitly create and start a graph run.
- `hive_workflow_node_complete` — report the current node outcome.
- `hive_workflow_gate_decide` — creator decision for a gated graph node.
- `hive_task` / `hive_task_complete` — ordinary task lane.
- `hive_workflow_propose` and numbered step tools — legacy linear lane.
