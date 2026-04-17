import {
  createTeam, getTeamById, getTeamByName, listTeams, getAgentTeams,
  addTeamMember, isTeamMember, getTeamMembers, getTeamMember, setTeamNickname,
  getTeamDisplayName, appendTeamEvent, getTeamEvents, getLatestTeamEvents,
  getAgentById,
} from '../db.js';
import type { Team, TeamEvent } from '../models.js';

// --- hive.team.create ---

export function handleTeamCreate(actorId: string, input: { name: string; nickname?: string }): { team_id: string; name: string } {
  const existing = getTeamByName(input.name);
  if (existing) throw new Error(`Team "${input.name}" already exists (team_id: ${existing.id})`);

  const team = createTeam(input.name, actorId);
  addTeamMember(team.id, actorId, input.nickname ?? null);
  appendTeamEvent(team.id, 'join', actorId, { nickname: input.nickname ?? null });
  return { team_id: team.id, name: team.name };
}

// --- hive.team.join ---

export function handleTeamJoin(actorId: string, input: { team_id?: string; name?: string; nickname?: string }): { team_id: string; name: string } {
  let team: Team | undefined;
  if (input.team_id) team = getTeamById(input.team_id);
  else if (input.name) team = getTeamByName(input.name);
  if (!team) throw new Error(`Team not found: ${input.team_id || input.name}`);
  if (team.closed_at) throw new Error('Team is closed');
  if (isTeamMember(team.id, actorId)) throw new Error('Already a member');

  // Check nickname conflict before insert
  if (input.nickname) {
    const conflict = getTeamMembers(team.id).find(m => m.nickname === input.nickname);
    if (conflict) throw new Error(`Nickname "${input.nickname}" already taken in this team`);
  }
  addTeamMember(team.id, actorId, input.nickname ?? null);
  appendTeamEvent(team.id, 'join', actorId, { nickname: input.nickname ?? null });
  return { team_id: team.id, name: team.name };
}

// --- hive.team.list ---

interface TeamSummary {
  team_id: string;
  name: string;
  member_count: number;
  members: Array<{ id: string; display_name: string }>;
}

export function handleTeamList(): { teams: TeamSummary[] } {
  const teams = listTeams(true);
  return {
    teams: teams.map(t => {
      const members = getTeamMembers(t.id).map(m => ({
        id: m.agent_id,
        display_name: m.nickname ?? (getAgentById(m.agent_id)?.display_name ?? m.agent_id),
      }));
      return { team_id: t.id, name: t.name, member_count: members.length, members };
    }),
  };
}

// --- hive.team.info ---

interface InfoOutput {
  team: Team;
  members: Array<{ id: string; nickname: string | null; display_name: string; status: string }>;
  latest_events: TeamEvent[];
}

export function handleTeamInfo(actorId: string, input: { team_id: string }): InfoOutput {
  const team = getTeamById(input.team_id);
  if (!team) throw new Error(`Team not found: ${input.team_id}`);
  if (!isTeamMember(input.team_id, actorId)) throw new Error('Not a member of this team');

  const members = getTeamMembers(input.team_id).map(m => {
    const agent = getAgentById(m.agent_id);
    return {
      id: m.agent_id,
      nickname: m.nickname,
      display_name: agent?.display_name ?? 'unknown',
      status: agent?.status ?? 'offline',
    };
  });

  return {
    team, members,
    latest_events: getLatestTeamEvents(input.team_id, 10),
  };
}

// --- hive.team.events ---

export function handleTeamEvents(actorId: string, input: { team_id: string; since?: number; limit?: number }): { events: TeamEvent[]; has_more: boolean } {
  if (!isTeamMember(input.team_id, actorId)) throw new Error('Not a member of this team');
  const limit = Math.min(input.limit ?? 50, 200);
  const events = getTeamEvents(input.team_id, input.since ?? 0, limit + 1);
  const hasMore = events.length > limit;
  if (hasMore) events.pop();
  return { events, has_more: hasMore };
}

// --- hive.team.message ---

export function handleTeamMessage(actorId: string, input: { team_id: string; content: string }): { team_id: string; event_id: number; seq: number } {
  if (!isTeamMember(input.team_id, actorId)) throw new Error('Not a member of this team');
  const event = appendTeamEvent(input.team_id, 'message', actorId, { content: input.content });
  return { team_id: input.team_id, event_id: event.id, seq: event.seq };
}

// --- hive.team.nickname ---

export function handleTeamNickname(actorId: string, input: { team_id: string; nickname: string | null }): { team_id: string; nickname: string | null; old_nickname: string | null } {
  if (!isTeamMember(input.team_id, actorId)) throw new Error('Not a member of this team');
  const member = getTeamMember(input.team_id, actorId)!;
  if (input.nickname) {
    const conflict = getTeamMembers(input.team_id).find(m => m.nickname === input.nickname && m.agent_id !== actorId);
    if (conflict) throw new Error(`Nickname "${input.nickname}" already taken in this team`);
  }
  setTeamNickname(input.team_id, actorId, input.nickname);
  appendTeamEvent(input.team_id, 'rename', actorId, {
    old_nickname: member.nickname, new_nickname: input.nickname,
  });
  return { team_id: input.team_id, nickname: input.nickname, old_nickname: member.nickname };
}

// --- hive.team.list (mine) ---

export function handleMyTeams(actorId: string): { teams: Array<{ team_id: string; name: string; nickname: string | null; member_count: number }> } {
  const teams = getAgentTeams(actorId, true);
  return {
    teams: teams.map(t => {
      const me = getTeamMember(t.id, actorId);
      return {
        team_id: t.id,
        name: t.name,
        nickname: me?.nickname ?? null,
        member_count: getTeamMembers(t.id).length,
      };
    }),
  };
}
