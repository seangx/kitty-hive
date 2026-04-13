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
  'task-start', 'task-claim', 'task-update',
  'task-ask', 'task-answer',
  'task-complete', 'task-fail', 'task-cancel',
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

export type TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled';
