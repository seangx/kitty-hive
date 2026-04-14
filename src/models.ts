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
}

export type RoomKind = 'dm' | 'team' | 'task' | 'project' | 'lobby';

export interface Room {
  id: string;
  name: string | null;
  kind: RoomKind;
  host_agent_id: string | null;
  parent_room_id: string | null;
  metadata_json: string;
  created_at: string;
  closed_at: string | null;
}

export const EVENT_TYPES = [
  'join', 'leave', 'message',
  // Simple task events (backward compat)
  'task-start', 'task-claim', 'task-update',
  'task-ask', 'task-answer',
  'task-complete', 'task-fail', 'task-cancel',
  // Workflow events
  'task-propose', 'task-approve', 'task-reject',
  'step-start', 'step-complete',
] as const;

export type EventType = typeof EVENT_TYPES[number];

export interface RoomEvent {
  id: number;
  room_id: string;
  seq: number;
  type: EventType;
  actor_agent_id: string | null;
  payload_json: string;
  ts: string;
}

// --- Simple task states (backward compat) ---

export type TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled';

// --- Workflow task states ---

export type WorkflowTaskStatus =
  | 'proposing'
  | 'approved'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface WorkflowStep {
  step: number;
  title: string;
  assignees: string[];        // agent name or "role:xxx"
  action: string;
  completion: 'all' | 'any';
  on_reject?: 'revise' | `back:${number}`;
  completed_by: string[];     // agent IDs that have completed this step
}

export interface TaskWorkflow {
  task_id: string;
  title: string;
  status: WorkflowTaskStatus;
  current_step: number;
  creator_agent_id: string;
  workflow: WorkflowStep[];
}
