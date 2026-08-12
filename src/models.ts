export const AGENT_EVENT_MODES = ['auto', 'foreground'] as const;
export type AgentEventMode = typeof AGENT_EVENT_MODES[number];

export const AGENT_CONTEXT_MODES = ['resident', 'fresh_per_run', 'fresh_per_activation'] as const;
export type AgentContextMode = typeof AGENT_CONTEXT_MODES[number];

export const AGENT_RUNTIME_SCOPES = ['resident', 'workflow_run', 'workflow_activation'] as const;
export type AgentRuntimeScope = typeof AGENT_RUNTIME_SCOPES[number];

export interface Agent {
  id: string;
  display_name: string;
  token: string;
  tool: string;
  roles: string;
  expertise: string;
  status: 'active' | 'idle' | 'busy' | 'offline';
  created_at: string;
  last_seen: string;
  origin_peer: string;   // empty for local agents; peer name for placeholders
  remote_id: string;     // empty for local agents; original agent_id on the peer
  external_key: string;  // opaque key from an external orchestrator (kitty session id, tmux pane, CI runner, ...). Empty when unmanaged. Unique when set.
  project_dir: string;   // working directory hint (operator-supplied). Persistent Codex/OpenCode supervisors use it as the backend cwd. Empty falls back to serve's cwd.
  thread_id: string;     // persisted conversation id. Codex stores a thread UUID; OpenCode stores a session id. agent.tool disambiguates the value. Empty = first-time spawn.
  event_mode: AgentEventMode; // auto = daemon starts model turns; foreground = persist notifications without background inference.
  pool_enabled: 0 | 1;   // disabled agents remain manually addressable but are excluded from role:* auto-routing.
  runtime_enabled: 0 | 1; // controls persistent supervisor lifecycle independently from pool routing.
  parent_agent_id: string; // non-empty for ephemeral workflow contexts cloned from a resident agent.
  runtime_scope: AgentRuntimeScope;
  runtime_ref: string;    // deterministic workflow run/activation key; unique when populated.
}

export interface Team {
  id: string;
  name: string;
  host_agent_id: string | null;
  created_at: string;
  closed_at: string | null;
  /** Free-form team rules / charter — markdown text. All members see it on
   *  hive_start (in the teams[] payload) and on hive_team_info, and are
   *  expected to follow it. Operator-set via `kitty-hive team rules`. */
  rules: string;
}

export interface TeamMember {
  team_id: string;
  agent_id: string;
  nickname: string | null;
  joined_at: string;
}

export const TEAM_EVENT_TYPES = ['join', 'leave', 'message', 'rename', 'host-transfer'] as const;
export type TeamEventType = typeof TEAM_EVENT_TYPES[number];

export interface TeamEvent {
  id: number;
  team_id: string;
  seq: number;
  type: TeamEventType;
  actor_agent_id: string | null;
  payload_json: string;
  ts: string;
}

export interface FileAttachment {
  file_id: string;
  filename: string;
  mime: string;
  size: number;
}

export interface DMMessage {
  id: number;
  seq: number;
  from_agent_id: string;
  to_agent_id: string;
  content: string;
  ts: string;
  attachments: string;   // JSON-encoded FileAttachment[]
}

export type TaskStatus =
  | 'created'
  | 'proposing'
  | 'approved'
  | 'in_progress'
  | 'awaiting_approval'   // gated step finished; waiting for creator's hive-workflow-step-approve
  | 'completed'
  | 'failed'
  | 'canceled';

export interface Task {
  id: string;
  title: string;
  creator_agent_id: string;
  assignee_agent_id: string | null;
  status: TaskStatus;
  workflow_json: string | null;
  current_step: number;
  source_team_id: string | null;
  input_json: string;
  created_at: string;
  completed_at: string | null;
  // Federation links (empty when not a federated task):
  originator_peer: string;       // we're the replica; events echo back to this peer
  originator_task_id: string;    // the originator's task id (use when echoing events back)
  delegated_peer: string;        // we're the originator; receive events from this peer
  delegated_task_id: string;     // peer's local task id (for our records / debugging)
}

export const TASK_EVENT_TYPES = [
  'task-start', 'task-claim', 'task-update',
  'task-propose', 'task-approve', 'task-reject',
  'step-start', 'step-complete', 'step-approve',
  'workflow-start', 'node-start', 'node-complete',
  'edge-taken', 'approval-request', 'approval-decision',
  'task-complete', 'task-fail', 'task-cancel',
] as const;
export type TaskEventType = typeof TASK_EVENT_TYPES[number];

export interface TaskEvent {
  id: number;
  task_id: string;
  seq: number;
  type: TaskEventType;
  actor_agent_id: string | null;
  payload_json: string;
  ts: string;
}

export interface WorkflowStep {
  step: number;
  title: string;
  assignees: string[];
  action: string;
  completion: 'all' | 'any';
  on_reject?: 'revise' | `back:${number}`;
  /** When true, after this step's assignees all finish the task pauses in
   *  status `awaiting_approval` until the creator calls hive-workflow-step-approve. */
  gate?: boolean;
  completed_by: string[];
}

export type GraphWorkflowOutcome = 'passed' | 'changes_requested' | 'failed';

/** A reusable graph node. Assignees may be concrete agent ids, role:xxx, or
 * `$assignee` in a template. Templates are resolved to concrete ids when a
 * run starts, so execution remains deterministic even if the pool changes. */
export interface GraphWorkflowNode {
  node_id: string;
  title: string;
  assignees: string[];
  action: string;
  completion: 'all' | 'any';
  gate?: boolean;
  context?: {
    mode: AgentContextMode;
  };
  /** Runtime-only logical assignees. Templates omit this field; an
   * instantiated run stores it so fresh execution agents may be replaced on
   * every activation without losing the originally selected pool agents. */
  base_assignees?: string[];
}

export interface GraphWorkflowEdge {
  edge_id: string;
  from: string;
  to: string;
  when: GraphWorkflowOutcome;
}

export interface GraphWorkflowDefinition {
  kind: 'graph';
  version: 1;
  template_id: string;
  template_name: string;
  entry_node_id: string;
  nodes: GraphWorkflowNode[];
  edges: GraphWorkflowEdge[];
}

export interface GraphWorkflowTemplate {
  template_id: string;
  template_name: string;
  description: string;
  version: 1;
  definition: GraphWorkflowDefinition;
}
