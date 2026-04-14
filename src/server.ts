import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { getAgentById, getAgentByName, touchAgent, initDB, getUnreadForAgent, setReadCursor, cleanupStaleTasks } from './db.js';
import { handleStart } from './tools/start.js';
import { handleDM } from './tools/dm.js';
import { handleTaskCreate, handleCheck, handleWorkflowPropose, handleWorkflowApprove, handleStepComplete, handleWorkflowReject } from './tools/task.js';
import { handlePost, handleEvents, handleList, handleInfo } from './tools/room.js';
import { handleTeamCreate, handleTeamJoin, handleTeamList } from './tools/team.js';
import { ROOM_EVENT_TYPES } from './models.js';
import type { Agent } from './models.js';
import * as db from './db.js';

// --- Logging ---

type LogLevel = 'error' | 'warn' | 'info' | 'debug';
const LOG_PRIORITY: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
let logLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel) { logLevel = level; }

function log(level: LogLevel, msg: string) {
  if (LOG_PRIORITY[level] <= LOG_PRIORITY[logLevel]) {
    const prefix = level === 'info' ? '' : `[${level}] `;
    console.log(`${prefix}${msg}`);
  }
}

// --- Session tracking ---

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

// sessionId → Session
const sessions: Record<string, Session> = {};
// sessionId → agentId
const sessionAgents = new Map<string, string>();
// agentId → Set<sessionId>
const agentSessions = new Map<string, Set<string>>();

function bindSession(sessionId: string, agentId: string) {
  // Clean up old binding if this session was previously bound to a different agent
  const oldAgentId = sessionAgents.get(sessionId);
  if (oldAgentId && oldAgentId !== agentId) {
    const oldSet = agentSessions.get(oldAgentId);
    if (oldSet) { oldSet.delete(sessionId); if (oldSet.size === 0) agentSessions.delete(oldAgentId); }
  }

  sessionAgents.set(sessionId, agentId);
  let set = agentSessions.get(agentId);
  if (!set) { set = new Set(); agentSessions.set(agentId, set); }
  set.add(sessionId);
  log("debug", `[bind] session=${sessionId} → agent=${agentId} (total sessions for agent: ${set.size})`);
}

function unbindSession(sessionId: string) {
  const agentId = sessionAgents.get(sessionId);
  if (agentId) {
    const set = agentSessions.get(agentId);
    if (set) { set.delete(sessionId); if (set.size === 0) agentSessions.delete(agentId); }
    sessionAgents.delete(sessionId);
  }
}

// --- Push notifications ---

function notifyRoomMembers(roomId: string, excludeAgentId?: string, message?: string) {
  const members = db.getRoomMembers(roomId);
  log("debug", `[notify] room=${roomId} members=${members.join(',')} exclude=${excludeAgentId}`);
  for (const memberId of members) {
    if (memberId === excludeAgentId) continue;
    const sids = agentSessions.get(memberId);
    log("debug", `[notify] agent=${memberId} sessions=${sids ? [...sids].join(',') : 'NONE'}`);
    if (!sids) continue;
    for (const sid of sids) {
      const session = sessions[sid];
      if (!session) { log("warn", `[notify] session ${sid} NOT FOUND in sessions map`); continue; }
      try {
        // Logging notification (generic)
        session.server.sendLoggingMessage({
          level: 'info',
          data: message ?? `New event in room ${roomId}`,
        }, sid);
        // Resource updated notification (inbox changed)
        session.server.server.sendResourceUpdated({ uri: 'hive://inbox' });
        log("debug", `[notify] sent to session ${sid} OK (logging + resource updated)`);
      } catch (err) {
        log("warn", `[notify] failed to send to session ${sid}: ${err}`);
      }
    }
  }
}

function notifyAgents(agentIds: string[], excludeAgentId?: string, message?: string) {
  for (const agentId of agentIds) {
    if (agentId === excludeAgentId) continue;
    const sids = agentSessions.get(agentId);
    if (!sids) continue;
    for (const sid of sids) {
      const session = sessions[sid];
      if (!session) continue;
      try {
        session.server.sendLoggingMessage({ level: 'info', data: message ?? 'New task event' }, sid);
        session.server.server.sendResourceUpdated({ uri: 'hive://inbox' });
      } catch { /* ignore */ }
    }
  }
}

function notifyTaskParticipants(taskId: string, excludeAgentId?: string, message?: string) {
  const task = db.getTaskById(taskId);
  if (!task) return;
  const participants = new Set<string>();
  participants.add(task.creator_agent_id);
  if (task.assignee_agent_id) participants.add(task.assignee_agent_id);
  // Also notify workflow step assignees
  if (task.workflow_json) {
    try {
      const steps = JSON.parse(task.workflow_json);
      for (const step of steps) {
        for (const a of step.assignees || []) {
          if (a.startsWith('role:')) {
            const agent = db.findAgentByRole(a.slice(5));
            if (agent) participants.add(agent.id);
          } else {
            const agent = db.getAgentById(a) || db.getAgentByName(a);
            if (agent) participants.add(agent.id);
          }
        }
      }
    } catch { /* ignore */ }
  }
  notifyAgents([...participants], excludeAgentId, message);
}

// --- Agent resolution ---

const asParam = z.string().optional().describe('Your agent name or ID (from hive.start)');

function resolveAgent(extra: any, asValue?: string): Agent | null {
  const sessionId = extra?.sessionId;
  // Logged by caller, not here (too noisy from polling)
  // 1) Session binding
  if (sessionId) {
    const agentId = sessionAgents.get(sessionId);
    if (agentId) {
      const agent = getAgentById(agentId);
      if (agent) { touchAgent(agent.id); return agent; }
    }
  }
  // 2) `as` param fallback
  if (asValue) {
    const agent = getAgentById(asValue) || getAgentByName(asValue);
    if (agent) { touchAgent(agent.id); return agent; }
  }
  // silent — too noisy from polling/stateless requests
  return null;
}

function authError() {
  return {
    content: [{ type: 'text' as const, text: 'Error: Not authenticated. Call hive.start first, or pass `as` with your agent name.' }],
    isError: true,
  };
}

// --- MCP Server factory (one per session) ---

function createMcpServer(): McpServer {
  const mcp = new McpServer({
    name: 'kitty-hive',
    version: '0.1.0',
  }, {
    capabilities: {
      logging: {},
      resources: { subscribe: true },
    },
    instructions: [
      'kitty-hive is a multi-agent collaboration server.',
      '',
      '## Getting Started',
      'FIRST: Call hive.start with your name to register. This returns your agent_id.',
      'THEN: Use hive.dm to send direct messages, hive.task to delegate tasks, hive.inbox to check unread messages.',
      'All tools except hive.start and hive.check require the `as` parameter with your agent name.',
      '',
      '## Task Workflow',
      'When creating a task with hive.task, use the `input` field to define requirements:',
      '- `input.description`: what to do',
      '- `input.output_path`: where to save the result file (use ~/.kitty-hive/artifacts/<task_id>/)',
      '- `input.output_format`: expected format (png, json, md, etc.)',
      '',
      'When completing a task, include the result in the task-complete payload:',
      '- Post hive.room.post with type "task-complete" and content describing the result and file path.',
      '',
      '## Shared Artifacts',
      'Use ~/.kitty-hive/artifacts/ as the shared directory for cross-agent file exchange.',
      'Convention: ~/.kitty-hive/artifacts/<task_id>/<filename>',
      'The task creator reads the output_path from the task-complete event.',
    ].join('\n'),
  });

  mcp.tool(
    'hive.start',
    'Register as an agent and join the lobby. Returns your agent_id. Session is auto-bound for push notifications.',
    {
      name: z.string().optional().describe('Display name (random if omitted)'),
      roles: z.string().optional().describe('Comma-separated roles: ux,frontend,backend'),
      tool: z.string().optional().describe('Agent tool: claude, codex, shell'),
      expertise: z.string().optional().describe('Free-text expertise description'),
    },
    async (params, extra) => {
      const result = handleStart(params);
      if (extra.sessionId) bindSession(extra.sessionId, result.agent_id);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive.dm',
    'Send a direct message to another agent. Auto-creates a DM room if needed.',
    {
      as: asParam,
      to: z.string().describe('Target agent ID or display name'),
      content: z.string().describe('Message content'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = handleDM(agent.id, params);
      notifyRoomMembers(result.room_id, agent.id, JSON.stringify({
        type: 'dm', from: agent.display_name, room_id: result.room_id,
        preview: params.content && params.content.length > 100 ? params.content.slice(0, 100) + '...' : params.content,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive.task',
    'Create a task and delegate to an agent or role. Creates a task room with state tracking.',
    {
      as: asParam,
      to: z.string().optional().describe('Target: agent ID, display name, or "role:ux"'),
      title: z.string().describe('Task title'),
      input: z.record(z.string(), z.unknown()).optional().describe('Structured task input (optional)'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = handleTaskCreate(agent.id, { to: params.to, title: params.title, input: params.input as object });
      if (result.assignee) {
        notifyAgents([result.assignee.id], agent.id, JSON.stringify({
          type: 'task-assigned', from: agent.display_name,
          task_id: result.task_id, title: params.title,
        }));
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive.check',
    'Check the current state of a task by task ID.',
    { task_id: z.string().describe('Task ID to check') },
    async (params) => {
      const result = handleCheck(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive.room.post',
    'Post a message to a room.',
    {
      as: asParam,
      room_id: z.string().describe('Room ID'),
      content: z.string().describe('Message content'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = handlePost(agent.id, {
        room_id: params.room_id, type: 'message', content: params.content,
      });
      notifyRoomMembers(params.room_id, agent.id, JSON.stringify({
        type: 'message', from: agent.display_name, room_id: params.room_id,
        preview: params.content && params.content.length > 100 ? params.content.slice(0, 100) + '...' : params.content,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive.room.events',
    'Fetch events from a room. Use "since" for incremental polling.',
    {
      as: asParam,
      room_id: z.string().describe('Room ID'),
      since: z.number().optional().describe('Return events after this seq number'),
      limit: z.number().optional().describe('Max events to return (default 50, max 200)'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = handleEvents(agent.id, {
        room_id: params.room_id, since: params.since, limit: params.limit,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive.room.list',
    'List rooms you are a member of.',
    {
      as: asParam,
      kind: z.string().optional().describe('Filter by room kind: dm, team, lobby'),
      active_only: z.boolean().optional().describe('Only show active (non-closed) rooms (default true)'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = handleList(agent.id, { kind: params.kind, active_only: params.active_only });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive.room.info',
    'Get detailed information about a room including members and recent events.',
    {
      as: asParam,
      room_id: z.string().describe('Room ID'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = handleInfo(agent.id, { room_id: params.room_id });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive.inbox',
    'Check your inbox for unread messages and events across all rooms. Marks returned messages as read.',
    {
      as: asParam,
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const unread = getUnreadForAgent(agent.id);
      // Mark as read
      for (const u of unread) {
        if (u.latest.length > 0) {
          if (u.type === 'room') {
            const events = db.getRoomEvents(u.id, 0, 10000);
            if (events.length > 0) setReadCursor(agent.id, 'room', u.id, events[events.length - 1].seq);
          } else {
            const events = db.getTaskEvents(u.id, 0, 100);
            if (events.length > 0) setReadCursor(agent.id, 'task', u.id, events[events.length - 1].seq);
          }
        }
      }
      if (unread.length === 0) {
        return { content: [{ type: 'text', text: '[]' }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(unread) }] };
    },
  );

  // --- Workflow tools ---

  mcp.tool(
    'hive.workflow.propose',
    'Propose a workflow for a task. The task creator must approve before it starts.',
    {
      as: asParam,
      task_id: z.string().describe('Task ID'),
      workflow: z.array(z.object({
        step: z.number(),
        title: z.string(),
        assignees: z.array(z.string()).describe('Agent names or "role:xxx"'),
        action: z.string(),
        completion: z.enum(['all', 'any']).default('all'),
        on_reject: z.string().optional().describe('"revise" or "back:N"'),
      })).describe('Workflow steps'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      handleWorkflowPropose(params.task_id, agent.id, params.workflow as any);
      notifyTaskParticipants(params.task_id, agent.id, JSON.stringify({
        type: 'task-propose', from: agent.display_name,
        task_id: params.task_id, preview: `Workflow proposed: ${params.workflow.length} steps`,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ task_id: params.task_id, status: 'proposing', steps: params.workflow.length }) }] };
    },
  );

  mcp.tool(
    'hive.workflow.approve',
    'Approve a proposed workflow. Automatically starts step 1.',
    {
      as: asParam,
      task_id: z.string().describe('Task ID'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const action = handleWorkflowApprove(params.task_id, agent.id);
      notifyTaskParticipants(params.task_id, agent.id, JSON.stringify({
        type: 'step-start', from: agent.display_name,
        task_id: params.task_id, preview: `Step 1 started, assignees: ${action.assignees?.join(', ')}`,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ task_id: params.task_id, status: 'approved', action }) }] };
    },
  );

  mcp.tool(
    'hive.workflow.step.complete',
    'Mark your part of the current step as complete.',
    {
      as: asParam,
      task_id: z.string().describe('Task ID'),
      step: z.number().describe('Step number'),
      result: z.string().optional().describe('Result description'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const action = handleStepComplete(params.task_id, agent.id, params.step);
      const msg = action?.type === 'task-complete' ? 'Task completed!'
        : action?.type === 'step-start' ? `Step ${action.step} started`
        : `Step ${params.step} progress recorded, waiting for others`;
      notifyTaskParticipants(params.task_id, agent.id, JSON.stringify({
        type: action?.type || 'step-complete', from: agent.display_name,
        task_id: params.task_id, preview: msg,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ task_id: params.task_id, action: action || 'waiting' }) }] };
    },
  );

  mcp.tool(
    'hive.workflow.reject',
    'Reject the current step output. Sends the task back to a previous step.',
    {
      as: asParam,
      task_id: z.string().describe('Task ID'),
      step: z.number().describe('Step number being rejected'),
      reason: z.string().optional().describe('Rejection reason'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const action = handleWorkflowReject(params.task_id, agent.id, params.step, params.reason);
      notifyTaskParticipants(params.task_id, agent.id, JSON.stringify({
        type: 'task-reject', from: agent.display_name,
        task_id: params.task_id, preview: `Step ${params.step} rejected → back to step ${action.step}`,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ task_id: params.task_id, action }) }] };
    },
  );

  // --- Team tools ---

  mcp.tool(
    'hive.team.create',
    'Create a team room for group collaboration.',
    {
      as: asParam,
      name: z.string().describe('Team name'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = handleTeamCreate(agent.id, { name: params.name });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive.team.join',
    'Join an existing team room.',
    {
      as: asParam,
      room_id: z.string().describe('Team room ID'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = handleTeamJoin(agent.id, { room_id: params.room_id });
      notifyRoomMembers(params.room_id, agent.id, JSON.stringify({
        type: 'join', from: agent.display_name, room_id: params.room_id,
        preview: `${agent.display_name} joined the team`,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive.team.list',
    'List all available teams.',
    {},
    async () => {
      const result = handleTeamList();
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  // --- Inbox resource ---
  mcp.resource(
    'inbox',
    'hive://inbox',
    { mimeType: 'application/json', description: 'Your unread messages and events across all rooms' },
    async (uri, extra) => {
      const sessionId = extra?.sessionId;
      let agentId: string | undefined;
      if (sessionId) agentId = sessionAgents.get(sessionId);
      if (!agentId) {
        return { contents: [{ uri: uri.href, text: '{"error":"Not authenticated. Call hive.start first."}' }] };
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

// --- HTTP server ---

export async function startServer(port: number, dbPath?: string): Promise<void> {
  initDB(dbPath);

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. MCP endpoint is at /mcp' }));
      return;
    }

    // Don't log heartbeat/polling requests
    const isQuiet = req.method === 'GET'; // SSE keepalive

    // --- GET: SSE stream ---
    if (req.method === 'GET') {
      const sid = req.headers['mcp-session-id'] as string | undefined;
      if (!sid || !sessions[sid]) {

        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing session ID' }));
        return;
      }
      log("debug", `[sse] opening SSE stream for session=${sid} agent=${sessionAgents.get(sid) || 'unbound'}`);
      await sessions[sid].transport.handleRequest(req, res);
      return;
    }

    // --- DELETE: session termination ---
    if (req.method === 'DELETE') {
      const sid = req.headers['mcp-session-id'] as string | undefined;
      if (!sid || !sessions[sid]) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing session ID' }));
        return;
      }
      log("info", `[session] DELETE session=${sid}`);
      unbindSession(sid);
      await sessions[sid].transport.handleRequest(req, res);
      return;
    }

    // --- POST: JSON-RPC ---
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());

      const sid = req.headers['mcp-session-id'] as string | undefined;
      const method = body?.method || (Array.isArray(body) ? `batch[${body.length}]` : 'unknown');
      const tool = body?.params?.name || '';
      const isHeartbeat = tool === 'hive.inbox' || method === 'notifications/initialized';
      if (!isHeartbeat) {
        log("info", `[rpc] method=${method} sid=${sid || 'none'} tool=${tool || '-'}`);
      }

      if (sid && sessions[sid]) {
        // Existing session
        await sessions[sid].transport.handleRequest(req, res, body);
      } else if (!sid && isInitializeRequest(body)) {
        // New session: create server + transport
        const server = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSid: string) => {
            log("info", `[session] new session created: ${newSid}`);
            sessions[newSid] = { transport, server };
          },
        });

        transport.onclose = () => {
          const tSid = transport.sessionId;
          if (tSid) {
            log("debug", `[session] transport closed: ${tSid}`);
            unbindSession(tSid);
            delete sessions[tSid];
          }
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } else {
        // Stateless fallback: create temporary server + transport per request
        // This supports clients that don't maintain sessions (e.g. HTTP adapters)
        if (!isHeartbeat) log("debug", `[rpc] stateless request: method=${method} tool=${tool || '-'}`);
        const server = createMcpServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        res.on('close', () => { transport.close(); server.close(); });
      }
    } catch (error) {
      console.error('[rpc] Error handling MCP request:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        }));
      }
    }
  });

  httpServer.listen(port, () => {
    console.log(`🐝 kitty-hive listening on http://localhost:${port}/mcp`);
    console.log(`   Database: ${dbPath || '~/.kitty-hive/hive.db'}`);
    console.log(`   Mode: stateful (SSE push enabled)`);
  });

  // Cleanup stale task rooms every hour
  setInterval(() => {
    const count = cleanupStaleTasks(7);
    if (count > 0) log("info", `[cleanup] removed ${count} stale task rooms`);
  }, 60 * 60 * 1000);

  process.on('SIGINT', async () => {
    for (const sid in sessions) {
      try { await sessions[sid].transport.close(); } catch { /* ignore */ }
      delete sessions[sid];
    }
    process.exit(0);
  });
}
