import {
  getRoomById, getRoomEvents, getLastRoomEventTs, getLatestRoomEvents, isMember,
  getAgentRooms, getRoomMembers, getAgentById,
} from '../db.js';
import type { Room, RoomEvent } from '../models.js';

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
    const lastTs = getLastRoomEventTs(r.id);
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

  const latestEvents = getLatestRoomEvents(input.room_id, 10);

  return { room, members, latest_events: latestEvents };
}
