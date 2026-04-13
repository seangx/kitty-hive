import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { getAgentById, getAgentByName, touchAgent, initDB, getUnreadForAgent, setReadCursor, cleanupStaleRooms } from './db.js';
import { handleStart } from './tools/start.js';
import { handleDM } from './tools/dm.js';
import { handleTask, handleCheck } from './tools/task.js';
import { handlePost, handleEvents, handleList, handleInfo } from './tools/room.js';
import { EVENT_TYPES } from './models.js';
import type { Agent } from './models.js';
import * as db from './db.js';

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
  console.log(`[bind] session=${sessionId} → agent=${agentId} (total sessions for agent: ${set.size})`);
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
  console.log(`[notify] room=${roomId} members=${members.join(',')} exclude=${excludeAgentId}`);
  for (const memberId of members) {
    if (memberId === excludeAgentId) continue;
    const sids = agentSessions.get(memberId);
    console.log(`[notify] agent=${memberId} sessions=${sids ? [...sids].join(',') : 'NONE'}`);
    if (!sids) continue;
    for (const sid of sids) {
      const session = sessions[sid];
      if (!session) { console.log(`[notify] session ${sid} NOT FOUND in sessions map`); continue; }
      try {
        // Logging notification (generic)
        session.server.sendLoggingMessage({
          level: 'info',
          data: message ?? `New event in room ${roomId}`,
        }, sid);
        // Resource updated notification (inbox changed)
        session.server.server.sendResourceUpdated({ uri: 'hive://inbox' });
        console.log(`[notify] sent to session ${sid} OK (logging + resource updated)`);
      } catch (err) {
        console.log(`[notify] failed to send to session ${sid}: ${err}`);
      }
    }
  }
}

// --- Agent resolution ---

const asParam = z.string().optional().describe('Your agent name or ID (from hive.start)');

function resolveAgent(extra: any, asValue?: string): Agent | null {
  const sessionId = extra?.sessionId;
  console.log(`[auth] resolveAgent sessionId=${sessionId} as=${asValue} sessionAgent=${sessionId ? sessionAgents.get(sessionId) : 'n/a'}`);
  // 1) Session binding
  if (sessionId) {
    const agentId = sessionAgents.get(sessionId);
    if (agentId) {
      const agent = getAgentById(agentId);
      if (agent) { touchAgent(agent.id); console.log(`[auth] resolved via session: ${agent.display_name}`); return agent; }
    }
  }
  // 2) `as` param fallback
  if (asValue) {
    const agent = getAgentById(asValue) || getAgentByName(asValue);
    if (agent) { touchAgent(agent.id); console.log(`[auth] resolved via as: ${agent.display_name}`); return agent; }
  }
  console.log(`[auth] FAILED to resolve agent`);
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
      const result = handleTask(agent.id, { to: params.to, title: params.title, input: params.input as object });
      if (result.assignee) {
        const sids = agentSessions.get(result.assignee.id);
        if (sids) {
          for (const sid of sids) {
            const session = sessions[sid];
            if (!session) continue;
            try {
              session.server.sendLoggingMessage({
                level: 'info',
                data: JSON.stringify({
                  type: 'task-assigned', from: agent.display_name,
                  task_id: result.task_id, room_id: result.room_id, title: params.title,
                }),
              }, sid);
            } catch { /* ignore */ }
          }
        }
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
    'Post an event to a room (message, task update, etc.).',
    {
      as: asParam,
      room_id: z.string().describe('Room ID'),
      type: z.string().describe(`Event type: ${EVENT_TYPES.join(', ')}`),
      content: z.string().optional().describe('Message content (for type=message)'),
      task_id: z.string().optional().describe('Task ID (for task-* event types)'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = handlePost(agent.id, {
        room_id: params.room_id, type: params.type as any,
        content: params.content, task_id: params.task_id,
      });
      notifyRoomMembers(params.room_id, agent.id, JSON.stringify({
        type: params.type, from: agent.display_name, room_id: params.room_id,
        task_id: params.task_id, preview: params.content,
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
      kind: z.string().optional().describe('Filter by room kind: dm, team, task, project, lobby'),
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
        const maxSeq = u.latest[u.latest.length - 1];
        if (maxSeq) {
          // Get actual max seq from db
          const events = db.getEvents(u.room_id, 0, 10000);
          if (events.length > 0) {
            setReadCursor(agent.id, u.room_id, events[events.length - 1].seq);
          }
        }
      }
      if (unread.length === 0) {
        return { content: [{ type: 'text', text: '[]' }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(unread) }] };
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

    console.log(`[http] ${req.method} ${req.url} session=${req.headers['mcp-session-id'] || 'none'}`);

    // --- GET: SSE stream ---
    if (req.method === 'GET') {
      const sid = req.headers['mcp-session-id'] as string | undefined;
      if (!sid || !sessions[sid]) {
        console.log(`[http] GET rejected: sid=${sid} exists=${!!sessions[sid!]} active_sessions=${Object.keys(sessions).join(',')}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing session ID' }));
        return;
      }
      console.log(`[sse] opening SSE stream for session=${sid} agent=${sessionAgents.get(sid) || 'unbound'}`);
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
      console.log(`[session] DELETE session=${sid}`);
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
      console.log(`[rpc] method=${method} sid=${sid || 'none'} tool=${body?.params?.name || '-'}`);

      if (sid && sessions[sid]) {
        // Existing session
        await sessions[sid].transport.handleRequest(req, res, body);
      } else if (!sid && isInitializeRequest(body)) {
        // New session: create server + transport
        const server = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSid: string) => {
            console.log(`[session] new session created: ${newSid}`);
            sessions[newSid] = { transport, server };
          },
        });

        transport.onclose = () => {
          const tSid = transport.sessionId;
          if (tSid) {
            console.log(`[session] transport closed: ${tSid}`);
            unbindSession(tSid);
            delete sessions[tSid];
          }
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } else {
        console.log(`[rpc] rejected: no session and not initialize. sid=${sid} isInit=${isInitializeRequest(body)}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          id: null,
        }));
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
    const count = cleanupStaleRooms(7);
    if (count > 0) console.log(`[cleanup] removed ${count} stale task rooms`);
  }, 60 * 60 * 1000);

  process.on('SIGINT', async () => {
    for (const sid in sessions) {
      try { await sessions[sid].transport.close(); } catch { /* ignore */ }
      delete sessions[sid];
    }
    process.exit(0);
  });
}
