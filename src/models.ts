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

export type RoomKind = 'lobby' | 'dm' | 'team';

export interface Room {
  id: string;
  name: string | null;
  kind: RoomKind;
  host_agent_id: string | null;
  created_at: string;
  closed_at: string | null;
}

// Room events: only communication
export const ROOM_EVENT_TYPES = ['join', 'leave', 'message'] as const;
export type RoomEventType = typeof ROOM_EVENT_TYPES[number];

export interface RoomEvent {
  id: number;
  room_id: string;
  seq: number;
  type: RoomEventType;
  actor_agent_id: string | null;
  payload_json: string;
  ts: string;
}

// Task status
export type TaskStatus =
  | 'created'
  | 'proposing'
  | 'approved'
  | 'in_progress'
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
  source_room_id: string | null;
  input_json: string;
  created_at: string;
  completed_at: string | null;
}

// Task events
export const TASK_EVENT_TYPES = [
  'task-start', 'task-claim', 'task-update',
  'task-propose', 'task-approve', 'task-reject',
  'step-start', 'step-complete',
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

// Workflow
export interface WorkflowStep {
  step: number;
  title: string;
  assignees: string[];
  action: string;
  completion: 'all' | 'any';
  on_reject?: 'revise' | `back:${number}`;
  completed_by: string[];
}

