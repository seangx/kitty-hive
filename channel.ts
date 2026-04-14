#!/usr/bin/env bun
/**
 * kitty-hive channel plugin for Claude Code
 *
 * Bridges kitty-hive MCP server events to Claude Code sessions via Channels.
 * Polls hive inbox for new messages and pushes them as <channel> notifications.
 * Exposes a reply tool so Claude can respond directly.
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:hive-channel
 *
 * Requires kitty-hive server running (default: http://localhost:4123/mcp)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const HIVE_URL = process.env.HIVE_URL || 'http://localhost:4123/mcp'
const HIVE_AGENT_NAME = process.env.HIVE_AGENT_NAME || ''
const POLL_INTERVAL = parseInt(process.env.HIVE_POLL_INTERVAL || '3000', 10)

// --- Hive HTTP client ---

let sessionId: string | null = null
let agentId: string | null = null
let agentName: string | null = null
let rpcId = 0

async function hivePost(method: string, params: any = {}) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  }
  if (sessionId) headers['Mcp-Session-Id'] = sessionId

  const res = await fetch(HIVE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })

  const sid = res.headers.get('mcp-session-id')
  if (sid) sessionId = sid

  const text = await res.text()
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) {
      const data = JSON.parse(line.slice(5))
      if (data.error) throw new Error(JSON.stringify(data.error))
      return data.result
    }
  }
  const data = JSON.parse(text)
  if (data.error) throw new Error(JSON.stringify(data.error))
  return data.result
}

async function hiveCallTool(name: string, args: any = {}) {
  const result = await hivePost('tools/call', { name, arguments: args })
  const text = result.content[0].text
  if (result.isError) throw new Error(text)
  try { return JSON.parse(text) } catch { return text }
}

async function initHiveSession() {
  // Initialize MCP session with hive
  await hivePost('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'hive-channel', version: '1.0' },
  })
  // Send initialized notification
  await fetch(HIVE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId!,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
}

async function registerAgent(name: string) {
  const result = await hiveCallTool('hive.start', { name, tool: 'claude', roles: 'channel' })
  agentId = result.agent_id
  agentName = result.display_name
  return result
}

// --- Channel MCP server ---

const mcp = new Server(
  { name: 'hive-channel', version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: [
      'You are connected to kitty-hive, a multi-agent collaboration server.',
      'Messages from other agents arrive as <channel source="hive-channel" from="..." room_id="..." type="...">.',
      'To reply, use the hive-reply tool with the room_id from the message tag.',
      'To send a DM to another agent, use the hive-dm tool.',
      'To check all unread messages, use the hive-inbox tool.',
      '',
      'Task artifacts: use ~/.kitty-hive/artifacts/<task_id>/ for cross-agent file exchange.',
      'When a task-complete message includes an output_path, read the file from that path.',
    ].join('\n'),
  },
)

// --- Tools ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'hive-dm',
      description: 'Send a direct message to another agent on kitty-hive',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Target agent name or ID' },
          content: { type: 'string', description: 'Message content' },
        },
        required: ['to', 'content'],
      },
    },
    {
      name: 'hive-reply',
      description: 'Reply in a room you are already a member of. ONLY use the room_id from a <channel> message YOU received. To message someone new, use hive-dm instead.',
      inputSchema: {
        type: 'object',
        properties: {
          room_id: { type: 'string', description: 'The room ID from a <channel> tag you received — do NOT use room IDs from other agents' },
          content: { type: 'string', description: 'Your reply message' },
        },
        required: ['room_id', 'content'],
      },
    },
    {
      name: 'hive-inbox',
      description: 'Check all unread messages on kitty-hive',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'hive-task',
      description: 'Create a task and delegate to an agent or role. Creates a task room with state tracking.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Target: agent name or "role:ux"' },
          title: { type: 'string', description: 'Task title' },
          input: { type: 'object', description: 'Structured task input (description, output_path, output_format)' },
        },
        required: ['title'],
      },
    },
    {
      name: 'hive-check',
      description: 'Check the current state of a task by task ID',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task ID to check' },
        },
        required: ['task_id'],
      },
    },
    {
      name: 'hive-rooms',
      description: 'List rooms you are a member of',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: 'Filter by room kind: dm, team, task, project, lobby' },
        },
      },
    },
    {
      name: 'hive-room-info',
      description: 'Get detailed info about a room including members and recent events',
      inputSchema: {
        type: 'object',
        properties: {
          room_id: { type: 'string', description: 'Room ID' },
        },
        required: ['room_id'],
      },
    },
    {
      name: 'hive-events',
      description: 'Fetch events from a room. Use "since" for incremental polling.',
      inputSchema: {
        type: 'object',
        properties: {
          room_id: { type: 'string', description: 'Room ID' },
          since: { type: 'number', description: 'Return events after this seq number' },
          limit: { type: 'number', description: 'Max events to return (default 50)' },
        },
        required: ['room_id'],
      },
    },
    {
      name: 'hive-propose',
      description: 'Propose a workflow for a task. Define steps with assignees, actions, and completion criteria.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task ID' },
          workflow: {
            type: 'array',
            description: 'Workflow steps',
            items: {
              type: 'object',
              properties: {
                step: { type: 'number' },
                title: { type: 'string' },
                assignees: { type: 'array', items: { type: 'string' }, description: 'Agent names or "role:xxx"' },
                action: { type: 'string' },
                completion: { type: 'string', description: '"all" or "any"' },
                on_reject: { type: 'string', description: '"revise" or "back:N"' },
              },
              required: ['step', 'title', 'assignees', 'action'],
            },
          },
        },
        required: ['task_id', 'workflow'],
      },
    },
    {
      name: 'hive-approve',
      description: 'Approve a proposed workflow. Automatically starts step 1.',
      inputSchema: {
        type: 'object',
        properties: { task_id: { type: 'string', description: 'Task ID' } },
        required: ['task_id'],
      },
    },
    {
      name: 'hive-step-complete',
      description: 'Mark your part of the current step as complete.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task ID' },
          step: { type: 'number', description: 'Step number' },
          result: { type: 'string', description: 'Result description' },
        },
        required: ['task_id', 'step'],
      },
    },
    {
      name: 'hive-reject',
      description: 'Reject the current step. Sends the task back to a previous step.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task ID' },
          step: { type: 'number', description: 'Step being rejected' },
          reason: { type: 'string', description: 'Rejection reason' },
        },
        required: ['task_id', 'step'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params
  const args = req.params.arguments as Record<string, string>

  if (name === 'hive-reply') {
    await hiveCallTool('hive.room.post', {
      as: agentName,
      room_id: args.room_id,
      type: 'message',
      content: args.content,
    })
    return { content: [{ type: 'text', text: 'sent' }] }
  }

  if (name === 'hive-dm') {
    const result = await hiveCallTool('hive.dm', {
      as: agentName,
      to: args.to,
      content: args.content,
    })
    return { content: [{ type: 'text', text: `sent (room: ${result.room_id})` }] }
  }

  if (name === 'hive-inbox') {
    const result = await hiveCallTool('hive.inbox', { as: agentName })
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] }
  }

  if (name === 'hive-task') {
    const input = args.input ? (typeof args.input === 'string' ? JSON.parse(args.input) : args.input) : undefined
    const result = await hiveCallTool('hive.task', {
      as: agentName,
      to: args.to,
      title: args.title,
      input,
    })
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  if (name === 'hive-check') {
    const result = await hiveCallTool('hive.check', { task_id: args.task_id })
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  if (name === 'hive-rooms') {
    const result = await hiveCallTool('hive.room.list', { as: agentName, kind: args.kind })
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  if (name === 'hive-room-info') {
    const result = await hiveCallTool('hive.room.info', { as: agentName, room_id: args.room_id })
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  if (name === 'hive-events') {
    const result = await hiveCallTool('hive.room.events', {
      as: agentName,
      room_id: args.room_id,
      since: args.since ? Number(args.since) : undefined,
      limit: args.limit ? Number(args.limit) : undefined,
    })
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  if (name === 'hive-propose') {
    const workflow = typeof args.workflow === 'string' ? JSON.parse(args.workflow) : args.workflow
    const result = await hiveCallTool('hive.workflow.propose', {
      as: agentName,
      task_id: args.task_id,
      workflow,
    })
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  if (name === 'hive-approve') {
    const result = await hiveCallTool('hive.workflow.approve', {
      as: agentName,
      task_id: args.task_id,
    })
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  if (name === 'hive-step-complete') {
    const result = await hiveCallTool('hive.workflow.step.complete', {
      as: agentName,
      task_id: args.task_id,
      step: Number(args.step),
      result: args.result,
    })
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  if (name === 'hive-reject') {
    const result = await hiveCallTool('hive.workflow.reject', {
      as: agentName,
      task_id: args.task_id,
      step: Number(args.step),
      reason: args.reason,
    })
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  throw new Error(`unknown tool: ${name}`)
})

// --- Dedup ---
const pushedMessages = new Set<string>();
function dedup(from: string, roomId: string, content: string): boolean {
  const key = `${from}:${roomId}:${content.slice(0, 50)}`;
  if (pushedMessages.has(key)) return false;
  pushedMessages.add(key);
  // Keep set bounded
  if (pushedMessages.size > 500) {
    const first = pushedMessages.values().next().value;
    if (first) pushedMessages.delete(first);
  }
  return true;
}

// --- SSE listener ---

async function listenSSE() {
  const url = HIVE_URL
  const headers: Record<string, string> = {
    'Accept': 'text/event-stream',
    'Mcp-Session-Id': sessionId!,
  }

  while (true) {
    try {
      const res = await fetch(url, { method: 'GET', headers })
      if (!res.ok || !res.body) {
        console.error(`[hive-channel] SSE connect failed: ${res.status}`)
        await new Promise(r => setTimeout(r, 3000))
        continue
      }

      console.error(`[hive-channel] SSE stream connected`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          try {
            const data = JSON.parse(line.slice(5))
            // logging notification from hive server
            if (data.method === 'notifications/message' && data.params?.data) {
              const raw = data.params.data
              let parsed: any
              try { parsed = JSON.parse(raw) } catch { parsed = { message: raw } }

              // Skip if it's not a message-type event
              if (!parsed.type || parsed.type === 'join' || parsed.type === 'leave') continue

              const content = parsed.preview || parsed.title || raw;
              const from = parsed.from || 'unknown';
              const roomId = parsed.room_id || '';
              if (!dedup(from, roomId, content)) continue;

              await mcp.notification({
                method: 'notifications/claude/channel',
                params: {
                  content,
                  meta: {
                    from,
                    room_id: roomId,
                    room_name: parsed.room_name || '',
                    room_kind: parsed.room_kind || '',
                    type: parsed.type || 'message',
                  },
                },
              })
            }
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (err) {
      console.error(`[hive-channel] SSE error, reconnecting...`, err)
    }
    // Reconnect after disconnect
    await new Promise(r => setTimeout(r, 2000))
  }
}

// --- Fallback: poll inbox on startup to catch missed messages ---

async function drainInbox() {
  try {
    const unread = await hiveCallTool('hive.inbox', { as: agentName })
    if (!Array.isArray(unread)) return

    for (const room of unread) {
      for (const msg of room.latest) {
        if (msg.type === 'join' || msg.type === 'leave') continue
        const content = msg.preview || `[${msg.type} event]`;
        if (!dedup(msg.from, room.room_id, content)) continue;
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content,
            meta: {
              from: msg.from,
              room_id: room.room_id,
              room_name: room.room_name || '',
              room_kind: room.room_kind,
              type: msg.type,
            },
          },
        })
      }
    }
  } catch { /* ignore */ }
}

// --- Start ---

await mcp.connect(new StdioServerTransport())

// Connect to hive with retry
async function connectToHive() {
  const name = HIVE_AGENT_NAME || `channel-${Date.now().toString(36)}`
  while (true) {
    try {
      await initHiveSession()
      await registerAgent(name)
      console.error(`[hive-channel] connected as "${agentName}" (${agentId})`)
      return
    } catch (err) {
      console.error(`[hive-channel] hive not ready, retrying in 3s...`)
      await new Promise(r => setTimeout(r, 3000))
    }
  }
}

await connectToHive()

// SSE only, no polling
listenSSE()
