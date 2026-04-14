import {
  getRoomById, getRoomEvents, appendRoomEvent, isMember,
  getAgentRooms, getRoomMembers, getAgentById,
} from '../db.js';
import type { Room, RoomEvent, RoomEventType } from '../models.js';

// --- hive.room.post ---

interface PostInput {
  room_id: string;
  type: RoomEventType;
  content?: string;
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

  const payload: Record<string, unknown> = {};
  if (input.content) payload.content = input.content;

  const event = appendRoomEvent(input.room_id, input.type, actorId, payload);
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
  const events = getRoomEvents(input.room_id, input.since ?? 0, limit + 1);
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
    const allEvents = getRoomEvents(r.id, 0, 10000);
    const lastTs = allEvents.length > 0 ? allEvents[allEvents.length - 1].ts : null;
    return { id: r.id, name: r.name, kind: r.kind, member_count: members.length, last_event_ts: lastTs };
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
}

export function handleInfo(actorId: string, input: InfoInput): InfoOutput {
  const room = getRoomById(input.room_id);
  if (!room) throw new Error(`Room not found: ${input.room_id}`);
  if (!isMember(input.room_id, actorId)) throw new Error('Not a member of this room');

  const memberIds = getRoomMembers(input.room_id);
  const members = memberIds.map(id => {
    const agent = getAgentById(id);
    return { id, display_name: agent?.display_name ?? 'Unknown', status: agent?.status ?? 'offline' };
  });

  const allEvents = getRoomEvents(input.room_id, 0, 10000);
  const latestEvents = allEvents.slice(-10);

  return { room, members, latest_events: latestEvents };
}
