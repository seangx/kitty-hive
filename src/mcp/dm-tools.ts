import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { handleDMAsync } from '../tools/dm.js';
import { asParam, authError, resolveAgent } from '../auth.js';
import { notifyAgents } from '../sessions.js';
import { getUnreadForAgent, setReadCursor } from '../db.js';
import * as db from '../db.js';

export function registerDMTools(mcp: McpServer) {
  mcp.tool(
    'hive.dm',
    'Send a direct message to another agent. `to` accepts agent id, or a nickname/display_name unambiguous within your teams. Use "id@node" for federation.',
    {
      as: asParam,
      to: z.string().describe('Target: agent id, team-nickname, display_name, or "id@node"'),
      content: z.string().describe('Message content'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = await handleDMAsync(agent.id, params);
      if (!result.federated) {
        const preview = params.content.length > 200 ? params.content.slice(0, 200) + ' [summary]' : params.content;
        await notifyAgents([result.to_agent_id], agent.id, JSON.stringify({
          type: 'dm', from_agent_id: agent.id, from: agent.display_name, preview,
        }));
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive.inbox',
    'Check unread DMs, team events, and task events. Marks returned items as read.',
    { as: asParam },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const unread = getUnreadForAgent(agent.id);
      // Mark as read
      for (const u of unread) {
        if (u.latest.length === 0) continue;
        if (u.type === 'team') {
          const events = db.getTeamEvents(u.id, 0, 10000);
          if (events.length > 0) setReadCursor(agent.id, 'team', u.id, events[events.length - 1].seq);
        } else if (u.type === 'task') {
          const events = db.getTaskEvents(u.id, 0, 100);
          if (events.length > 0) setReadCursor(agent.id, 'task', u.id, events[events.length - 1].seq);
        } else if (u.type === 'dm') {
          // Per-sender cursor: u.id is the sender agent_id
          const max = db.getMaxIncomingDMId(agent.id, u.id);
          if (max > 0) setReadCursor(agent.id, 'dm', u.id, max);
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify(unread.length > 0 ? unread : []) }] };
    },
  );
}
