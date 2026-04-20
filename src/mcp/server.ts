import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sessionAgents } from '../sessions.js';
import { getUnreadForAgent } from '../db.js';
import { registerAgentTools } from './agent-tools.js';
import { registerDMTools } from './dm-tools.js';
import { registerTeamTools } from './team-tools.js';
import { registerTaskTools } from './task-tools.js';
import { registerFederationTools } from './federation-tools.js';

export function createMcpServer(): McpServer {
  const mcp = new McpServer({
    name: 'kitty-hive',
    version: '0.2.0',
  }, {
    capabilities: {
      logging: {},
      resources: { subscribe: true },
    },
    instructions: [
      'kitty-hive is a multi-agent collaboration server.',
      '',
      '## Identity',
      '- agent_id (ULID) is your stable cross-team handle. Get it from hive_start.',
      '- display_name is for display only, not unique.',
      '- Inside a team, members can have unique nicknames (set with hive_team_nickname).',
      '',
      '## Addressing',
      '- DM and task `to`: prefer agent_id. team-nickname or display_name also accepted if unambiguous.',
      '- Federation: use "id@node" or "nickname@node".',
      '',
      '## Workflow rules',
      '- When you receive a task, propose a workflow (hive_workflow_propose) before starting.',
      '- The creator approves (hive_workflow_approve). NEVER auto-approve — show the proposal to the user.',
      '- Mark each step with hive_workflow_step_complete.',
      '- Claim unassigned tasks with hive_task_claim.',
      '',
      '## Artifacts',
      'Use ~/.kitty-hive/artifacts/<task_id>/ for cross-agent file exchange.',
    ].join('\n'),
  });

  registerAgentTools(mcp);
  registerDMTools(mcp);
  registerTeamTools(mcp);
  registerTaskTools(mcp);
  registerFederationTools(mcp);

  // Inbox resource (auto-updated via sendResourceUpdated)
  mcp.resource(
    'inbox',
    'hive://inbox',
    { mimeType: 'application/json', description: 'Your unread DMs, team events, and task events' },
    async (uri, extra) => {
      const sessionId = extra?.sessionId;
      const agentId = sessionId ? sessionAgents.get(sessionId) : undefined;
      if (!agentId) {
        return { contents: [{ uri: uri.href, text: '{"error":"Not authenticated. Call hive_start first."}' }] };
      }
      const unread = getUnreadForAgent(agentId);
      return {
        contents: [{
          uri: uri.href,
          text: JSON.stringify(unread.length > 0 ? unread : { message: 'No unread messages.' }),
        }],
      };
    },
  );

  return mcp;
}
