import {
  createTeam, getTeamById, getTeamByName, listTeams, getAgentTeams,
  addTeamMember, removeTeamMember, renameTeamMember,
  isTeamMember, getTeamMembers, getTeamMember,
  getTeamDisplayName, appendTeamEvent, getTeamEvents, getLatestTeamEvents,
  getAgentById, setTeamRules,
} from '../db.js';
import type { Team, TeamEvent } from '../models.js';

// --- hive_team_create ---

export function handleTeamCreate(actorId: string, input: { name: string; nickname?: string }): { team_id: string; name: string } {
  const existing = getTeamByName(input.name);
  if (existing) throw new Error(`Team "${input.name}" already exists (team_id: ${existing.id})`);

  const team = createTeam(input.name, actorId);
  addTeamMember(team.id, actorId, input.nickname ?? null);
  appendTeamEvent(team.id, 'join', actorId, { nickname: input.nickname ?? null });
  return { team_id: team.id, name: team.name };
}

// --- hive_team_join ---

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

// --- hive_team_list ---

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

// --- hive_team_info ---

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

// --- hive_team_set_rules ---

/** Set or clear a team's rules (markdown). Host-only — only the team's host
 *  agent can call this via MCP; the operator CLI bypasses this restriction.
 *  Pass empty string to clear. Length-capped at 10000 chars (set higher than
 *  any reasonable team charter; mostly to prevent accidental dumps). */
export function handleTeamSetRules(actorId: string, input: { team_id: string; rules: string }): { team_id: string; team_name: string; rules_length: number; previous_length: number } {
  const team = getTeamById(input.team_id);
  if (!team) throw new Error(`Team not found: ${input.team_id}`);
  if (team.closed_at) throw new Error('Team is closed');
  if (team.host_agent_id !== actorId) {
    throw new Error('Only the team host can change rules. Ask the host, or use `kitty-hive team rules` (operator CLI) to override.');
  }
  const prev = team.rules || '';
  const next = input.rules ?? '';
  setTeamRules(input.team_id, next);
  return {
    team_id: input.team_id,
    team_name: team.name,
    rules_length: next.length,
    previous_length: prev.length,
  };
}

// --- hive_team_events ---

export function handleTeamEvents(actorId: string, input: { team_id: string; since?: number; limit?: number }): { events: TeamEvent[]; has_more: boolean } {
  if (!isTeamMember(input.team_id, actorId)) throw new Error('Not a member of this team');
  const limit = Math.min(input.limit ?? 50, 200);
  const events = getTeamEvents(input.team_id, input.since ?? 0, limit + 1);
  const hasMore = events.length > limit;
  if (hasMore) events.pop();
  return { events, has_more: hasMore };
}

// --- hive_team_message ---

export function handleTeamMessage(actorId: string, input: { team_id: string; content: string }): { team_id: string; event_id: number; seq: number } {
  const team = getTeamById(input.team_id);
  if (!team) throw new Error(`Team not found: ${input.team_id}`);
  if (team.closed_at) throw new Error('Team is closed');
  if (!isTeamMember(input.team_id, actorId)) throw new Error('Not a member of this team');
  const event = appendTeamEvent(input.team_id, 'message', actorId, { content: input.content });
  return { team_id: input.team_id, event_id: event.id, seq: event.seq };
}

// --- hive_team_rename_nickname ---
//
// Self-only: changes the caller's nickname in a team they belong to. Useful
// when the agent joined without a nickname (and now wants one) or wants to
// rename the existing one. Pass empty string to clear (display_name fallback
// then takes over). Writes a 'rename' team event so other members see the
// change in their team-events stream.
//
// Validation:
//   - caller must be a team member
//   - new nickname must not collide with another existing member's nickname
//     (SQLite UNIQUE on (team_id, nickname) — we check up-front for a
//     clearer error than the raw constraint violation)

export function handleTeamRenameNickname(
  actorId: string,
  input: { team_id: string; nickname: string },
): { team_id: string; team_name: string; previous_nickname: string | null; nickname: string | null } {
  const team = getTeamById(input.team_id);
  if (!team) throw new Error(`Team not found: ${input.team_id}`);
  if (team.closed_at) throw new Error('Team is closed');
  const me = getTeamMember(team.id, actorId);
  if (!me) throw new Error(`You are not a member of team "${team.name}"`);

  const normalized = input.nickname.trim();
  if (normalized) {
    const conflict = getTeamMembers(team.id).find(
      m => m.agent_id !== actorId && m.nickname === normalized,
    );
    if (conflict) throw new Error(`Nickname "${normalized}" already taken in this team`);
  }

  const ok = renameTeamMember(team.id, actorId, normalized);
  if (!ok) throw new Error('Failed to update nickname (member row missing)');

  appendTeamEvent(team.id, 'rename', actorId, {
    previous: me.nickname,
    nickname: normalized || null,
  });

  return {
    team_id: team.id,
    team_name: team.name,
    previous_nickname: me.nickname,
    nickname: normalized || null,
  };
}

// --- hive_team_leave ---
//
// Self-only: caller leaves a team they belong to. Writes a 'leave' team
// event before removing the member row so other members see the departure
// in their team-events stream (and the actor_agent_id resolves through
// agents table for display).
//
// Constraint: the team's host cannot leave (would orphan host responsibility,
// including the host-only hive_team_set_rules). Host must transfer host
// first — but host-transfer is not yet implemented either, so for now the
// host of a team they want to dissolve has to remove via admin / future tool.

export function handleTeamLeave(
  actorId: string,
  input: { team_id: string },
): { team_id: string; team_name: string } {
  const team = getTeamById(input.team_id);
  if (!team) throw new Error(`Team not found: ${input.team_id}`);
  if (team.closed_at) throw new Error('Team is closed');
  if (!isTeamMember(team.id, actorId)) {
    throw new Error(`You are not a member of team "${team.name}"`);
  }
  if (team.host_agent_id === actorId) {
    throw new Error(
      `You are the host of "${team.name}" and cannot leave. ` +
      `Transfer host first (not yet supported via MCP) or dissolve the team out-of-band.`,
    );
  }
  // Append event BEFORE removing — once the member row is gone, this still
  // references the actor by agent_id (team_events.actor_agent_id is the
  // agents.id, not team_members.id), so display lookups still work.
  appendTeamEvent(team.id, 'leave', actorId, {});
  removeTeamMember(team.id, actorId);
  return { team_id: team.id, team_name: team.name };
}

// --- hive_team_list (mine) ---

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
