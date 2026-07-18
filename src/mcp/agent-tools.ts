import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { handleStart } from '../tools/start.js';
import { renameAgent, listAllAgents, getAgentsByName, updateAgentRoles, getAgentById, getAgentByExternalKey } from '../db.js';
import { getDaemonForAgent } from '../codex-supervisor.js';
import { getOpenCodeDaemonForAgent } from '../opencode-supervisor.js';
import { asParam, authError, resolveAgent } from '../auth.js';
import { bindSession } from '../sessions.js';

export function registerAgentTools(mcp: McpServer) {
  mcp.tool(
    'hive_start',
    'Register or reconnect as an agent. Returns your agent_id (used for cross-team addressing). The MCP session is automatically bound to the returned agent so push notifications target the right session. ' +
    'Lookup priority: id > key > name. id is hive\'s ULID. key is an opaque external identifier (e.g. a kitty/tmux session uuid) — used by orchestrators that spawn long-lived processes and want a stable agent across restarts. name is fuzzy fallback. ' +
    '(Channel-plugin users: prefer hive-whoami for first-time registration; this is the underlying server tool.)',
    {
      id: z.string().optional().describe('Agent id to reconnect to (exact ULID match). If not found, the agent is created with this id.'),
      key: z.string().optional().describe('External orchestrator key. Idempotent: same key always returns the same agent_id. UNIQUE on populated values.'),
      name: z.string().optional().describe('Display name (random if omitted). When the agent already exists, display_name is silently refreshed to this value.'),
      roles: z.string().optional().describe('Comma-separated roles: ux,frontend,backend'),
      tool: z.string().optional().describe('Agent tool: claude, codex, opencode, shell'),
      expertise: z.string().optional().describe('Free-text expertise description'),
    },
    async (params, extra) => {
      const result = handleStart(params);
      if (extra.sessionId) {
        bindSession(extra.sessionId, result.agent_id);
      } else {
        console.warn(`[hive_start] WARNING: no sessionId in extra (stateless?). agent=${result.agent_id} will NOT receive push.`);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive_whoami',
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
    'hive_update_role',
    'Add or remove role tags on yourself. Affects role:xxx routing — others can find you via role:tester etc. ' +
    'Call this AFTER you complete a kind of work you previously hadn\'t done (add=[\'<domain>\']), ' +
    'or when you notice you were wrongly routed via role:X (remove=[\'X\']). ' +
    'Do NOT pre-occupy roles — only register what you can demonstrably do.',
    {
      as: asParam,
      add: z.array(z.string()).optional().describe('Role tags to add (e.g. ["tester", "reviewer"]). Comma in a single string is fine too — it will be split.'),
      remove: z.array(z.string()).optional().describe('Role tags to remove.'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      // Allow either ["tester","reviewer"] or ["tester,reviewer"] for ergonomic CLI use.
      const split = (arr: string[] | undefined) =>
        (arr ?? []).flatMap(s => s.split(',')).map(s => s.trim()).filter(Boolean);
      const result = updateAgentRoles(agent.id, split(params.add), split(params.remove));
      return { content: [{ type: 'text', text: JSON.stringify({
        agent_id: agent.id,
        display_name: agent.display_name,
        old_roles: result.old,
        new_roles: result.new,
      }) }] };
    },
  );

  mcp.tool(
    'hive_rename',
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
    'hive_codex_pane_ws',
    'Look up the codex app-server ws endpoint + thread_id for a tool=codex agent. ' +
    'Used by launchers (kitty-kitty etc.) to spawn `codex --remote <ws_url>` inside a visible pane attached to the SAME thread the hive supervisor\'s daemon is injecting hive events into. Three-way share: daemon (ws client) injects, TUI shows the thread, user can type — all into one thread. ' +
    'Pass agent_id or agent_key; agent_id wins. Returns status="ready" only when the supervisor-spawned daemon has finished setting up its codex app-server and reported back. status="starting" means the daemon is still booting (retry shortly). status="not_supervised" means there\'s no daemon for this agent (agent missing, agent.tool != "codex", or supervisor not running).',
    {
      agent_id: z.string().optional().describe('Hive agent id (ULID).'),
      agent_key: z.string().optional().describe('Agent external_key (alternative to agent_id).'),
    },
    async (params) => {
      if (!params.agent_id && !params.agent_key) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'agent_id or agent_key required' }) }], isError: true };
      }
      // Resolve to agent_id first
      let agent: ReturnType<typeof getAgentById>;
      if (params.agent_id) {
        agent = getAgentById(params.agent_id);
      } else {
        agent = getAgentByExternalKey(params.agent_key!);
      }
      if (!agent) {
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'not_supervised',
          error: `agent not found: ${params.agent_id || params.agent_key}`,
        }) }] };
      }
      if (agent.tool !== 'codex') {
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'not_supervised',
          agent_id: agent.id,
          display_name: agent.display_name,
          error: `agent.tool="${agent.tool}", not "codex" — only codex agents are supervised`,
        }) }] };
      }
      const snap = getDaemonForAgent({ agentId: agent.id });
      if (!snap) {
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'not_supervised',
          agent_id: agent.id,
          display_name: agent.display_name,
          error: 'no daemon running for this agent — hive serve may not have spawned one (restart serve, or check that tool=codex was set when the agent registered)',
        }) }] };
      }
      if (!snap.ready) {
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'starting',
          agent_id: agent.id,
          display_name: agent.display_name,
          pid: snap.pid,
          uptime_ms: snap.uptime_ms,
          // No ws_url / thread_id yet — daemon is still booting codex app-server
        }) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'ready',
        agent_id: agent.id,
        display_name: agent.display_name,
        ws_url: snap.ws_url,
        thread_id: snap.thread_id,
        pid: snap.pid,
        uptime_ms: snap.uptime_ms,
      }) }] };
    },
  );

  mcp.tool(
    'hive_opencode_pane_server',
    'Look up the authenticated loopback OpenCode server + session for a tool=opencode agent. ' +
    'Launchers attach a visible TUI to the SAME persistent session receiving hive pushes with ' +
    '`opencode attach <server_url> --session <session_id> --username <server_username> --password <server_password>`. ' +
    'Returns status="starting" while the supervised OpenCode server is booting and status="not_supervised" for missing/non-opencode agents.',
    {
      agent_id: z.string().optional().describe('Hive agent id (ULID).'),
      agent_key: z.string().optional().describe('Agent external_key (alternative to agent_id).'),
    },
    async (params) => {
      if (!params.agent_id && !params.agent_key) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'agent_id or agent_key required' }) }], isError: true };
      }
      const agent = params.agent_id
        ? getAgentById(params.agent_id)
        : getAgentByExternalKey(params.agent_key!);
      if (!agent || agent.tool !== 'opencode') {
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'not_supervised',
          agent_id: agent?.id,
          display_name: agent?.display_name,
          error: agent ? `agent.tool="${agent.tool}", not "opencode"` : 'agent not found',
        }) }] };
      }
      const snap = getOpenCodeDaemonForAgent(agent.id);
      if (!snap) {
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'not_supervised',
          agent_id: agent.id,
          display_name: agent.display_name,
          error: 'no OpenCode daemon running; ensure hive serve is running and OpenCode is installed',
        }) }] };
      }
      if (!snap.ready) {
        return { content: [{ type: 'text', text: JSON.stringify({
          status: 'starting',
          agent_id: agent.id,
          display_name: agent.display_name,
          pid: snap.pid,
          uptime_ms: snap.uptime_ms,
          restart_count: snap.restart_count,
        }) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'ready',
        agent_id: agent.id,
        display_name: agent.display_name,
        server_url: snap.server_url,
        session_id: snap.session_id,
        server_username: snap.server_username,
        server_password: snap.server_password,
        version: snap.version,
        pid: snap.pid,
        uptime_ms: snap.uptime_ms,
      }) }] };
    },
  );

  mcp.tool(
    'hive_agents',
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
