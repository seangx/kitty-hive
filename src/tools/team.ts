import { createRoom, appendRoomEvent, getRoomById, isMember, listTeams, getRoomMembers, getAgentById } from '../db.js';
import type { Room } from '../models.js';

// --- hive.team.create ---

interface CreateInput {
  name: string;
}

export function handleTeamCreate(actorId: string, input: CreateInput): { room_id: string; name: string } {
  // Check uniqueness
  const existing = listTeams().find(t => t.name === input.name);
  if (existing) throw new Error(`Team "${input.name}" already exists (room_id: ${existing.id})`);

  const room = createRoom('team', actorId, input.name);
  appendRoomEvent(room.id, 'join', actorId);
  return { room_id: room.id, name: input.name };
}

// --- hive.team.join ---

interface JoinInput {
  room_id?: string;
  name?: string;
}

export function handleTeamJoin(actorId: string, input: JoinInput): { room_id: string; name: string | null } {
  let room;
  if (input.room_id) {
    room = getRoomById(input.room_id);
  } else if (input.name) {
    const teams = listTeams();
    room = teams.find(t => t.name === input.name);
  }
  if (!room) throw new Error(`Team not found: ${input.room_id || input.name}`);
  if (room.kind !== 'team') throw new Error('Not a team room');
  if (room.closed_at) throw new Error('Team is closed');
  if (isMember(room.id, actorId)) throw new Error('Already a member');

  appendRoomEvent(room.id, 'join', actorId);
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
