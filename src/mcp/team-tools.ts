import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  handleTeamCreate, handleTeamJoin, handleTeamList, handleTeamInfo,
  handleTeamEvents, handleTeamMessage, handleTeamNickname, handleMyTeams,
} from '../tools/team.js';
import { asParam, authError, resolveAgent } from '../auth.js';
import { notifyTeamMembers } from '../sessions.js';

export function registerTeamTools(mcp: McpServer) {
  mcp.tool(
    'hive.team.create',
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
    'hive.team.join',
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
      await notifyTeamMembers(result.team_id, agent.id, JSON.stringify({
        type: 'join', from_agent_id: agent.id, from: shownName,
        team_id: result.team_id, preview: `${shownName} joined`,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive.team.list',
    'List all open teams (with their members).',
    {},
    async () => {
      const result = handleTeamList();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive.team.info',
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
    'hive.team.events',
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
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive.team.message',
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
      const preview = params.content.length > 200 ? params.content.slice(0, 200) + ' [summary]' : params.content;
      await notifyTeamMembers(params.team_id, agent.id, JSON.stringify({
        type: 'team-message', from_agent_id: agent.id, from: agent.display_name,
        team_id: params.team_id, preview,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive.team.nickname',
    'Set or change your nickname within a team. Pass null to clear.',
    {
      as: asParam,
      team_id: z.string().describe('Team id'),
      nickname: z.string().nullable().describe('New nickname (or null to clear)'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = handleTeamNickname(agent.id, { team_id: params.team_id, nickname: params.nickname });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive.teams',
    'List teams you are a member of (with your nickname in each).',
    { as: asParam },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = handleMyTeams(agent.id);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );
}
