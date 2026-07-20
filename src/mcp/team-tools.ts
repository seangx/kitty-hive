import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  handleTeamCreate, handleTeamJoin, handleTeamList, handleTeamInfo,
  handleTeamEvents, handleTeamMessage, handleTeamSetRules, handleMyTeams,
  handleTeamRenameNickname, handleTeamLeave,
} from '../tools/team.js';
import { asParam, authError, resolveAgent } from '../auth.js';
import { notifyTeamMembers } from '../sessions.js';
import { buildPushMessage } from '../preview.js';
import { setReadCursor } from '../db.js';

function teamEventId(teamId: string, type: string, seq: number): string {
  return `team:${teamId}:${type}:${seq}`;
}

function teamMetadataEventId(teamId: string, type: string): string {
  return `team-meta:${teamId}:${type}:${Date.now()}`;
}

export function registerTeamTools(mcp: McpServer) {
  mcp.tool(
    'hive_team_create',
    'Create a new team. Optionally set your nickname in this team.',
    {
      as: asParam,
      name: z.string().describe('Team name (must be globally unique)'),
      nickname: z.string().optional().describe('Your nickname in this team (must be unique within team)'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = handleTeamCreate(agent.id, { name: params.name, nickname: params.nickname });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive_team_join',
    'Join an existing team by name or id.',
    {
      as: asParam,
      team_id: z.string().optional().describe('Team id'),
      name: z.string().optional().describe('Team name'),
      nickname: z.string().optional().describe('Your nickname in this team (must be unique within team)'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = handleTeamJoin(agent.id, { team_id: params.team_id, name: params.name, nickname: params.nickname });
      const shownName = params.nickname ?? agent.display_name;
      await notifyTeamMembers(result.team_id, agent.id, buildPushMessage({
        type: 'join',
        from: shownName,
        from_agent_id: agent.id,
        event_id: teamEventId(result.team_id, 'join', result.seq),
        team_id: result.team_id,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive_team_list',
    'List all teams on this hive (with their members).',
    {},
    async () => {
      const result = handleTeamList();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive_team_info',
    'Get detailed info about a team you are in (members with nicknames + recent events).',
    {
      as: asParam,
      team_id: z.string().describe('Team id'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = handleTeamInfo(agent.id, { team_id: params.team_id });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive_team_events',
    'Fetch events from a team. Use "since" for incremental polling.',
    {
      as: asParam,
      team_id: z.string().describe('Team id'),
      since: z.number().optional().describe('Return events after this seq number'),
      limit: z.number().optional().describe('Max events (default 50, max 200)'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = handleTeamEvents(agent.id, { team_id: params.team_id, since: params.since, limit: params.limit });
      const last = result.events.at(-1);
      if (last) setReadCursor(agent.id, 'team', params.team_id, last.seq);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive_team_message',
    'Post a message to a team (broadcasts to all members).',
    {
      as: asParam,
      team_id: z.string().describe('Team id'),
      content: z.string().describe('Message content'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = handleTeamMessage(agent.id, { team_id: params.team_id, content: params.content });
      await notifyTeamMembers(params.team_id, agent.id, buildPushMessage({
        type: 'team-message',
        from: agent.display_name,
        from_agent_id: agent.id,
        event_id: teamEventId(params.team_id, 'team-message', result.seq),
        team_id: params.team_id,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive_team_set_rules',
    'Replace a team\'s rules / charter (free-form markdown shown to all members on hive_start + hive_team_info). HOST-ONLY: only the team\'s host agent can call this; non-hosts are rejected. Pass empty string to clear. The change is pushed to all members as a `team-rules-update` notification — they should re-fetch via hive_team_info to read the new text.',
    {
      as: asParam,
      team_id: z.string().describe('Team id'),
      rules: z.string().max(10000, 'rules max 10000 chars').describe('Full new rules text (markdown). Pass "" to clear.'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = handleTeamSetRules(agent.id, { team_id: params.team_id, rules: params.rules });
      await notifyTeamMembers(params.team_id, agent.id, buildPushMessage({
        type: 'team-rules-update',
        from: agent.display_name,
        from_agent_id: agent.id,
        event_id: teamMetadataEventId(params.team_id, 'team-rules-update'),
        team_id: params.team_id,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive_teams',
    'List teams you are a member of (with your nickname in each).',
    { as: asParam },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = handleMyTeams(agent.id);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive_team_rename_nickname',
    'Change YOUR nickname in a team you belong to. ' +
    'Self-only: you can only rename your own nickname, not other members\'. ' +
    'Pass an empty string to clear (your display_name will be used instead). ' +
    'The new nickname must be unique within the team (server-checked; conflict → error). ' +
    'A `rename` team event is appended so other members see the change in hive_team_events.',
    {
      as: asParam,
      team_id: z.string().describe('Team id (find via hive_teams or hive_team_list)'),
      nickname: z.string().describe('New nickname. Empty string = clear (fall back to display_name).'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = handleTeamRenameNickname(agent.id, { team_id: params.team_id, nickname: params.nickname });
      await notifyTeamMembers(params.team_id, agent.id, buildPushMessage({
        type: 'rename',
        from: result.nickname || agent.display_name,
        from_agent_id: agent.id,
        event_id: teamEventId(params.team_id, 'rename', result.seq),
        team_id: params.team_id,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive_team_leave',
    'Leave a team you belong to. ' +
    'Self-only: you can only remove yourself. ' +
    'Constraint: if you are the team\'s host you cannot leave (would orphan host-only operations like hive_team_set_rules). ' +
    'A `leave` team event is appended so other members see the departure in hive_team_events. ' +
    'You can re-join later with hive_team_join, which gives you a fresh chance to set a nickname.',
    {
      as: asParam,
      team_id: z.string().describe('Team id'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = handleTeamLeave(agent.id, { team_id: params.team_id });
      // Notify BEFORE the member-row is gone? Already done: handleTeamLeave
      // appends the event first, then removes the row, so other members'
      // hive_team_events sees the leave with proper actor lineage. Push
      // notifies remaining members (the leaver themselves is excluded via
      // the from_agent_id arg — they don't need a notification about their
      // own action).
      await notifyTeamMembers(params.team_id, agent.id, buildPushMessage({
        type: 'leave',
        from: agent.display_name,
        from_agent_id: agent.id,
        event_id: teamEventId(params.team_id, 'leave', result.seq),
        team_id: params.team_id,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );
}
