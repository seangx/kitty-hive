import {
  getRoomById, getEvents, appendEvent, isMember,
  getAgentRooms, getRoomMembers, getAgentById,
} from '../db.js';
import { nextState, isTaskEvent, deriveTaskState } from '../state-machine.js';
import type { Agent, Room, RoomEvent, EventType, TaskState } from '../models.js';

// --- hive.room.post ---

interface PostInput {
  room_id: string;
  type: EventType;
  content?: string;
  task_id?: string;
  task?: object;
}

interface PostOutput {
  event_id: number;
  seq: number;
}

export function handlePost(actorId: string, input: PostInput): PostOutput {
  const room = getRoomById(input.room_id);
  if (!room) throw new Error(`Room not found: ${input.room_id}`);
  if (!isMember(input.room_id, actorId)) throw new Error('Not a member of this room. Use hive.dm to message someone directly.');
  if (room.closed_at) throw new Error('Room is closed');

  // Validate task state transition if task event
  if (isTaskEvent(input.type) && input.task_id) {
    const taskEvents = getEvents(input.room_id, 0, 10000)
      .filter(e => {
        try {
          const p = JSON.parse(e.payload_json);
          return p.task_id === input.task_id;
        } catch { return false; }
      });
    const currentState = taskEvents.length > 0 ? deriveTaskState(taskEvents) : null;
    const next = nextState(currentState, input.type);
    if (!next) {
      throw new Error(`Invalid task transition: ${currentState} + ${input.type}`);
    }
  }

  const payload: Record<string, unknown> = {};
  if (input.content) payload.content = input.content;
  if (input.task_id) payload.task_id = input.task_id;
  if (input.task) Object.assign(payload, input.task);

  const event = appendEvent(input.room_id, input.type, actorId, payload);

  return { event_id: event.id, seq: event.seq };
}

// --- hive.room.events ---

interface EventsInput {
  room_id: string;
  since?: number;
  limit?: number;
}

interface EventsOutput {
  events: RoomEvent[];
  has_more: boolean;
}

export function handleEvents(actorId: string, input: EventsInput): EventsOutput {
  if (!isMember(input.room_id, actorId)) throw new Error('Not a member of this room');

  const limit = Math.min(input.limit ?? 50, 200);
  const events = getEvents(input.room_id, input.since ?? 0, limit + 1);
  const hasMore = events.length > limit;
  if (hasMore) events.pop();

  return { events, has_more: hasMore };
}

// --- hive.room.list ---

interface ListInput {
  kind?: string;
  active_only?: boolean;
}

interface RoomSummary {
  id: string;
  name: string | null;
  kind: string;
  member_count: number;
  last_event_ts: string | null;
}

export function handleList(actorId: string, input: ListInput): { rooms: RoomSummary[] } {
  const rooms = getAgentRooms(actorId, input.kind, input.active_only ?? true);

  const summaries: RoomSummary[] = rooms.map(r => {
    const members = getRoomMembers(r.id);
    const allEvents = getEvents(r.id, 0, 10000);
    const lastTs = allEvents.length > 0 ? allEvents[allEvents.length - 1].ts : null;

    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      member_count: members.length,
      last_event_ts: lastTs,
    };
  });

  return { rooms: summaries };
}

// --- hive.room.info ---

interface InfoInput {
  room_id: string;
}

interface InfoOutput {
  room: Room;
  members: Array<{ id: string; display_name: string; status: string }>;
  latest_events: RoomEvent[];
  task_state?: TaskState;
}

export function handleInfo(actorId: string, input: InfoInput): InfoOutput {
  const room = getRoomById(input.room_id);
  if (!room) throw new Error(`Room not found: ${input.room_id}`);
  if (!isMember(input.room_id, actorId)) throw new Error('Not a member of this room');

  const memberIds = getRoomMembers(input.room_id);
  const members = memberIds.map(id => {
    const agent = getAgentById(id);
    return {
      id,
      display_name: agent?.display_name ?? 'Unknown',
      status: agent?.status ?? 'offline',
    };
  });

  const allEvents = getEvents(input.room_id, 0, 10000);
  const latestEvents = allEvents.slice(-10);

  // Derive task state if task room
  let taskState: TaskState | undefined;
  if (room.kind === 'task') {
    const taskEvents = allEvents.filter(e => isTaskEvent(e.type as EventType));
    if (taskEvents.length > 0) taskState = deriveTaskState(taskEvents);
  }

  return { room, members, latest_events: latestEvents, task_state: taskState };
}
