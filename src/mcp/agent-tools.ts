import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { handleStart } from '../tools/start.js';
import { renameAgent, listAllAgents, getAgentsByName } from '../db.js';
import { asParam, authError, resolveAgent } from '../auth.js';
import { bindSession } from '../sessions.js';

export function registerAgentTools(mcp: McpServer) {
  mcp.tool(
    'hive.start',
    'Register or reconnect as an agent. Returns your agent_id (used for cross-team addressing). Session is auto-bound for push notifications.',
    {
      id: z.string().optional().describe('Agent id to reconnect to (exact match). Errors if not found.'),
      name: z.string().optional().describe('Display name (random if omitted). Reuses latest existing agent with this name.'),
      roles: z.string().optional().describe('Comma-separated roles: ux,frontend,backend'),
      tool: z.string().optional().describe('Agent tool: claude, codex, shell'),
      expertise: z.string().optional().describe('Free-text expertise description'),
    },
    async (params, extra) => {
      const result = handleStart(params);
      if (extra.sessionId) {
        bindSession(extra.sessionId, result.agent_id);
      } else {
        console.warn(`[hive.start] WARNING: no sessionId in extra (stateless?). agent=${result.agent_id} will NOT receive push.`);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive.whoami',
    'Show the agent currently bound to this session (or via `as`).',
    { as: asParam },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            agent_id: agent.id,
            display_name: agent.display_name,
            roles: agent.roles,
            tool: agent.tool,
            status: agent.status,
            session_id: extra?.sessionId ?? null,
          }),
        }],
      };
    },
  );

  mcp.tool(
    'hive.rename',
    'Change your global display_name (display only — addressing uses id).',
    {
      as: asParam,
      name: z.string().describe('New display name'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const oldName = agent.display_name;
      renameAgent(agent.id, params.name);
      return { content: [{ type: 'text', text: JSON.stringify({ agent_id: agent.id, old_name: oldName, new_name: params.name }) }] };
    },
  );

  mcp.tool(
    'hive.agents',
    'List all known agents on this hive. Use this to find agent ids for cross-team DM/task.',
    {
      active_only: z.boolean().optional().describe('Only show active agents (default false)'),
      name: z.string().optional().describe('Filter by display_name (may match multiple)'),
    },
    async (params) => {
      const agents = params.name
        ? getAgentsByName(params.name)
        : listAllAgents(params.active_only ?? false);
      const result = agents.map(a => ({
        id: a.id, display_name: a.display_name, roles: a.roles,
        tool: a.tool, status: a.status, last_seen: a.last_seen,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
