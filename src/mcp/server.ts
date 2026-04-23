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
      '- Inside a team, members can have unique nicknames (set at hive_team_join time).',
      '',
      '## Addressing',
      '- DM and task `to`: prefer agent_id. team-nickname or display_name also accepted if unambiguous.',
      '- Federation: use "id@node" or "nickname@node".',
      '',
      '## Roles',
      '`roles` is a comma-separated tag list describing the kinds of work you can do.',
      'It drives `role:xxx` routing — others find you by capability instead of by name.',
      '',
      'Self-maintain it:',
      '- After completing a kind of work you previously had not done, call',
      '  hive_update_role(add=[\'<domain>\']). Examples: first e2e test → add \'tester\';',
      '  first code review → add \'reviewer\'.',
      '- If you were wrongly routed via role:X (you are not actually the right fit),',
      '  call hive_update_role(remove=[\'X\']).',
      '- Do NOT pre-occupy roles. Only register what you can demonstrably do.',
      '',
      'Common roles: tester, reviewer, frontend, backend, db, devops, ux, design, docs.',
      'Project-specific tags also fine: skillsmgr-frontend, hive-maintainer.',
      '',
      'If your `roles` is empty, routing falls back to display_name substring match —',
      'so a display_name containing your role (e.g. "tester") still gets you found.',
      'Setting roles makes routing more precise.',
      '',
      '## Team collaboration',
      'When a task has source_team_id, or you belong to a team:',
      '- BEFORE creating a new task: call hive_tasks(team=<team>) to see if a similar',
      '  task is already in flight. Avoid duplicates.',
      '- WHEN delegating: prefer role:xxx — routing matches inside the team first.',
      '- IF unsure who to pick: call hive_team_info(team=<team>) to see members,',
      '  their roles, and expertise.',
      '',
      '## Workflow rules',
      '- When you receive a task, propose a workflow (hive_workflow_propose) before starting.',
      '- The creator approves (hive_workflow_approve). NEVER auto-approve — show the proposal to the user.',
      '- Mark each step with hive_workflow_step_complete.',
      '- Claim unassigned tasks with hive_task_claim.',
      '- step.action MUST be ≤400 chars. POINT to the upstream spec (openspec change ref,',
      '  Linear/issue id, doc URL, prior DM message_id) — do NOT inline acceptance criteria.',
      '  Spec details belong in the spec system, not in task workflow text.',
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
