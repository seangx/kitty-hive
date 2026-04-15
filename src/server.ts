import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { getAgentById, getAgentByName, touchAgent, initDB, getUnreadForAgent, setReadCursor, cleanupStaleTasks, getPeerBySecret, isPeerExposed, touchPeer, listPeers, getPeerByName } from './db.js';
import { handleStart } from './tools/start.js';
import { handleDM, handleDMAsync } from './tools/dm.js';
import { handleTaskCreate, handleTaskCreateAsync, handleTaskClaim, handleCheck, handleWorkflowPropose, handleWorkflowApprove, handleStepComplete, handleWorkflowReject } from './tools/task.js';
import { handleEvents, handleList, handleInfo } from './tools/room.js';
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
      'Call hive.start with your name to register. All tools except hive.start and hive.check require `as` param.',
      '',
      '## Task Rules (IMPORTANT)',
      'When you receive a task (via hive.task or task-assigned notification):',
      '1. Analyze the task and propose a workflow using hive.workflow.propose',
      '2. The workflow should have clear steps with assignees from your team',
      '3. Wait for the creator to approve (hive.workflow.approve) before starting',
      '4. Execute each step, call hive.workflow.step.complete when done',
      '5. If you see an unassigned task, claim it with hive.task.claim',
      '',
      'When you CREATE a task:',
      '- Always specify `to` (agent name or "role:xxx") to assign it',
      '- Use `input.description` to describe what needs to be done',
      '- The assignee will propose a workflow — you MUST show the proposal to the user and get explicit confirmation before calling hive.workflow.approve',
      '- NEVER auto-approve a workflow without asking the user first',
      '',
      '## Rooms',
      '- lobby: global, everyone auto-joins',
      '- dm: private 1:1 messaging (auto-created by hive.dm)',
      '- team: group collaboration (hive.team.create/join/list)',
      '',
      '## Shared Artifacts',
      'Use ~/.kitty-hive/artifacts/<task_id>/ for cross-agent file exchange.',
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
    'Send a direct message. Use "agent@node" for cross-node DM (federation).',
    {
      as: asParam,
      to: z.string().describe('Target agent name, or "agent@node" for federation'),
      content: z.string().describe('Message content'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = await handleDMAsync(agent.id, params);
      if (!result.federated) {
        notifyRoomMembers(result.room_id, agent.id, JSON.stringify({
          type: 'dm', from: agent.display_name, room_id: result.room_id,
          preview: params.content && params.content.length > 200 ? params.content.slice(0, 200) + ' [summary]' : params.content,
        }));
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive.task',
    'Create a task and delegate. Use "agent@node" for cross-node delegation.',
    {
      as: asParam,
      to: z.string().optional().describe('Target: agent name, "role:ux", or "agent@node" for federation'),
      title: z.string().describe('Task title'),
      input: z.record(z.string(), z.unknown()).optional().describe('Structured task input (optional)'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = await handleTaskCreateAsync(agent.id, { to: params.to, title: params.title, input: params.input as object });
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
    'hive.task.claim',
    'Claim an unassigned task. Only works on tasks with status "created" and no assignee.',
    {
      as: asParam,
      task_id: z.string().describe('Task ID to claim'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = handleTaskClaim(params.task_id, agent.id);
      notifyTaskParticipants(params.task_id, agent.id, JSON.stringify({
        type: 'task-claimed', from: agent.display_name,
        task_id: params.task_id, preview: `${agent.display_name} claimed: ${result.title}`,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive.tasks',
    'List tasks. Shows all tasks you created or are assigned to, grouped by status.',
    {
      as: asParam,
      status: z.string().optional().describe('Filter by status: created, proposing, approved, in_progress, completed, failed, canceled'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const tasks = db.getAgentTasks(agent.id, params.status);
      const board = tasks.map(t => ({
        task_id: t.id,
        title: t.title,
        status: t.status,
        creator: db.getAgentById(t.creator_agent_id)?.display_name ?? 'unknown',
        assignee: t.assignee_agent_id ? (db.getAgentById(t.assignee_agent_id)?.display_name ?? 'unknown') : 'unassigned',
        current_step: t.current_step,
        has_workflow: !!t.workflow_json,
        created_at: t.created_at,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(board, null, 2) }] };
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
      const action = handleStepComplete(params.task_id, agent.id, params.step, params.result);
      const resultPreview = params.result && params.result.length > 200 ? params.result.slice(0, 200) + ' [summary]' : params.result;
      const msg = action?.type === 'task-complete' ? 'Task completed!'
        : action?.type === 'step-start' ? `Step ${action.step} started. Previous step result: ${resultPreview || 'none'}`
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
    'Join an existing team room by name or ID.',
    {
      as: asParam,
      room_id: z.string().optional().describe('Team room ID'),
      name: z.string().optional().describe('Team name'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = handleTeamJoin(agent.id, { room_id: params.room_id, name: params.name });
      notifyRoomMembers(result.room_id, agent.id, JSON.stringify({
        type: 'join', from: agent.display_name, room_id: result.room_id,
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

  // --- Federation MCP tools ---

  mcp.tool(
    'hive.peers',
    'List connected federation peers.',
    {},
    async () => {
      const peers = db.listPeers();
      const result = peers.map(p => ({
        name: p.name, url: p.url, status: p.status,
        exposed: p.exposed, last_seen: p.last_seen,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  mcp.tool(
    'hive.remote.agents',
    'List agents on a remote peer node.',
    {
      peer: z.string().describe('Peer node name'),
    },
    async (params) => {
      const peer = db.getPeerByName(params.peer);
      if (!peer) throw new Error(`Peer "${params.peer}" not found`);

      const res = await fetch(peer.url.replace('/mcp', '/federation/agents'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${peer.secret}`,
          'X-Hive-Peer': peer.name,
        },
      });

      if (!res.ok) throw new Error(`Failed to fetch agents from peer "${params.peer}"`);
      const data = await res.json();
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
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

    // --- Federation routes ---
    if (url.pathname.startsWith('/federation/')) {
      await handleFederation(req, res, url);
      return;
    }

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
    if (count > 0) log("info", `[cleanup] removed ${count} stale tasks`);
  }, 60 * 60 * 1000);

  process.on('SIGINT', async () => {
    for (const sid in sessions) {
      try { await sessions[sid].transport.close(); } catch { /* ignore */ }
      delete sessions[sid];
    }
    process.exit(0);
  });
}

// --- Federation handler ---

import { mkdirSync as mkdirSyncFs, writeFileSync as writeFileSyncFs, readFileSync as readFileSyncFs, existsSync as existsSyncFs } from 'node:fs';
import { join as joinPath } from 'node:path';
import { homedir as homedirFn } from 'node:os';

function authenticatePeer(req: IncomingMessage): db.Peer | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!match) return null;
  const peer = db.getPeerBySecret(match[1]);
  if (peer) db.touchPeer(peer.name);
  return peer ?? null;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

function filesDir(): string {
  const dir = joinPath(homedirFn(), '.kitty-hive', 'files');
  mkdirSyncFs(dir, { recursive: true });
  return dir;
}

async function handleFederation(req: IncomingMessage, res: ServerResponse, url: URL) {
  const peer = authenticatePeer(req);
  if (!peer) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const peerName = req.headers['x-hive-peer'] as string || peer.name;
  log("info", `[federation] ${req.method} ${url.pathname} from peer=${peerName}`);

  // --- GET /federation/agents ---
  if (url.pathname === '/federation/agents' && req.method === 'POST') {
    const exposed = peer.exposed ? peer.exposed.split(',').map(s => s.trim()).filter(Boolean) : [];
    const agents = exposed.map(name => {
      const agent = db.getAgentByName(name);
      return agent ? { name: agent.display_name, roles: agent.roles, status: agent.status } : null;
    }).filter(Boolean);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ node: getNodeName(), agents }));
    return;
  }

  // --- POST /federation/dm ---
  if (url.pathname === '/federation/dm' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const { from, to, content, file_id } = body;

    if (!from || !to || !content) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing from, to, or content' }));
      return;
    }

    // Check if target agent is exposed to this peer
    if (!db.isPeerExposed(peer.name, to)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Agent "${to}" is not accessible` }));
      return;
    }

    // Create or find remote agent placeholder
    const remoteAgentName = `${from}`;
    let remoteAgent = db.getAgentByName(remoteAgentName);
    if (!remoteAgent) {
      remoteAgent = db.createAgent(remoteAgentName, 'remote', `peer:${peerName}`, '');
    }

    // Deliver DM
    const targetAgent = db.getAgentByName(to);
    if (!targetAgent) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Agent "${to}" not found` }));
      return;
    }

    const msgContent = file_id ? `${content}\n\n[file: ${file_id}]` : content;
    const result = handleDM(remoteAgent.id, { to, content: msgContent });

    // Notify local agent
    notifyRoomMembers(result.room_id, remoteAgent.id, JSON.stringify({
      type: 'dm', from: remoteAgentName, room_id: result.room_id,
      preview: content.length > 200 ? content.slice(0, 200) + ' [summary]' : content,
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ delivered: true, event_id: result.event_id }));
    return;
  }

  // --- POST /federation/file (upload) ---
  if (url.pathname === '/federation/file' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const data = Buffer.concat(chunks);

    const filename = (req.headers['x-filename'] as string) || 'upload';
    const fileId = 'f_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    const fileDir = joinPath(filesDir(), fileId);
    mkdirSyncFs(fileDir, { recursive: true });
    writeFileSyncFs(joinPath(fileDir, filename), data);

    log("info", `[federation] file received: ${fileId}/${filename} (${data.length} bytes)`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ file_id: fileId, filename, size: data.length }));
    return;
  }

  // --- GET /federation/file/:id ---
  if (url.pathname.startsWith('/federation/file/') && req.method === 'GET') {
    const fileId = url.pathname.split('/').pop();
    if (!fileId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing file ID' }));
      return;
    }

    const fileDir = joinPath(filesDir(), fileId);
    if (!existsSyncFs(fileDir)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File not found' }));
      return;
    }

    // Read first file in directory
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(fileDir);
    if (files.length === 0) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File not found' }));
      return;
    }

    const filePath = joinPath(fileDir, files[0]);
    const fileData = readFileSyncFs(filePath);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${files[0]}"`,
    });
    res.end(fileData);
    return;
  }

  // --- POST /federation/task ---
  if (url.pathname === '/federation/task' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const { from, to, title, input } = body;

    if (!from || !to || !title) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing from, to, or title' }));
      return;
    }

    if (!db.isPeerExposed(peer.name, to)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Agent "${to}" is not accessible` }));
      return;
    }

    // Create remote agent placeholder
    let remoteAgent = db.getAgentByName(from);
    if (!remoteAgent) {
      remoteAgent = db.createAgent(from, 'remote', `peer:${peerName}`, '');
    }

    const targetAgent = db.getAgentByName(to);
    if (!targetAgent) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Agent "${to}" not found` }));
      return;
    }

    const result = handleTaskCreate(remoteAgent.id, { to, title, input });

    // Notify assignee
    notifyTaskParticipants(result.task_id, remoteAgent.id, JSON.stringify({
      type: 'task-assigned', from, task_id: result.task_id, preview: title,
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ task_id: result.task_id, status: result.status }));
    return;
  }

  // --- POST /federation/task/event ---
  if (url.pathname === '/federation/task/event' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const { from, task_id, type, workflow, step, reason, result: stepResult } = body;

    if (!from || !task_id || !type) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing from, task_id, or type' }));
      return;
    }

    let remoteAgent = db.getAgentByName(from);
    if (!remoteAgent) {
      remoteAgent = db.createAgent(from, 'remote', `peer:${peerName}`, '');
    }

    const task = db.getTaskById(task_id);
    if (!task) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Task not found: ${task_id}` }));
      return;
    }

    try {
      let action: any = null;
      switch (type) {
        case 'task-propose':
          handleWorkflowPropose(task_id, remoteAgent.id, workflow);
          break;
        case 'task-approve':
          action = handleWorkflowApprove(task_id, remoteAgent.id);
          break;
        case 'step-complete':
          action = handleStepComplete(task_id, remoteAgent.id, step, stepResult);
          break;
        case 'task-reject':
          action = handleWorkflowReject(task_id, remoteAgent.id, step, reason);
          break;
        default:
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Unknown event type: ${type}` }));
          return;
      }

      notifyTaskParticipants(task_id, remoteAgent.id, JSON.stringify({
        type, from, task_id, preview: `${type} from ${from}`,
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, action }));
    } catch (err: any) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unknown federation endpoint' }));
}

function getNodeName(): string {
  try {
    const configPath = joinPath(homedirFn(), '.kitty-hive', 'config.json');
    if (existsSyncFs(configPath)) {
      const config = JSON.parse(readFileSyncFs(configPath, 'utf8'));
      if (config.name) return config.name;
    }
  } catch { /* ignore */ }
  return require('os').hostname().split('.')[0];
}
