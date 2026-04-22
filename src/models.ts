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
}

export interface Team {
  id: string;
  name: string;
  host_agent_id: string | null;
  created_at: string;
  closed_at: string | null;
}

export interface TeamMember {
  team_id: string;
  agent_id: string;
  nickname: string | null;
  joined_at: string;
}

export const TEAM_EVENT_TYPES = ['join', 'leave', 'message', 'rename'] as const;
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
