import { createRoom, appendRoomEvent, getRoomById, isMember, listTeams, getRoomMembers, getAgentById } from '../db.js';
import type { Room } from '../models.js';

// --- hive.team.create ---

interface CreateInput {
  name: string;
}

export function handleTeamCreate(actorId: string, input: CreateInput): { room_id: string; name: string } {
  const room = createRoom('team', actorId, input.name);
  appendRoomEvent(room.id, 'join', actorId);
  return { room_id: room.id, name: input.name };
}

// --- hive.team.join ---

interface JoinInput {
  room_id: string;
}

export function handleTeamJoin(actorId: string, input: JoinInput): { room_id: string; name: string | null } {
  const room = getRoomById(input.room_id);
  if (!room) throw new Error(`Room not found: ${input.room_id}`);
  if (room.kind !== 'team') throw new Error('Not a team room');
  if (room.closed_at) throw new Error('Team is closed');
  if (isMember(input.room_id, actorId)) throw new Error('Already a member');

  appendRoomEvent(input.room_id, 'join', actorId);
  return { room_id: room.id, name: room.name };
}

// --- hive.team.list ---

interface TeamSummary {
  room_id: string;
  name: string | null;
  member_count: number;
  members: string[];
}

export function handleTeamList(): { teams: TeamSummary[] } {
  const teams = listTeams();
  return {
    teams: teams.map(t => {
      const memberIds = getRoomMembers(t.id);
      const members = memberIds.map(id => {
        const agent = getAgentById(id);
        return agent?.display_name ?? id;
      });
      return { room_id: t.id, name: t.name, member_count: memberIds.length, members };
    }),
  };
}
