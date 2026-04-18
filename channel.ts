#!/usr/bin/env bun
/**
 * kitty-hive channel plugin for Claude Code
 *
 * Bridges kitty-hive HTTP MCP server events to Claude Code via Channels.
 * - Maintains an MCP session against the hive HTTP server
 * - Listens to SSE for push notifications (DMs, team events, task events)
 * - Forwards them as <channel> notifications into the Claude Code session
 * - Re-exposes hive tools as `hive-*` (kebab-case) so Claude can call them directly
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const HIVE_URL = process.env.HIVE_URL || 'http://localhost:4123/mcp'
const HIVE_AGENT_ID = process.env.HIVE_AGENT_ID || ''
const HIVE_AGENT_NAME = process.env.HIVE_AGENT_NAME || ''

// --- Hive HTTP client ---

let sessionId: string | null = null
let agentId: string | null = null
let agentName: string | null = null
let rpcId = 0
let sseStarted = false

async function hivePost(method: string, params: any = {}, _retried = false): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  }
  // initialize must not carry a session id (server creates one)
  if (sessionId && method !== 'initialize') headers['Mcp-Session-Id'] = sessionId

  const res = await fetch(HIVE_URL, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })

  // Server lost our session (restarted) — re-init and retry once
  if (res.status === 404 && !_retried && method !== 'initialize') {
    console.error(`[hive-channel] server returned 404 (stale session); re-initializing...`)
    sessionId = null
    await initHiveSession()
    if (agentId) await hiveCallTool('hive.start', { id: agentId, tool: 'claude', roles: 'channel' }, true)
    return hivePost(method, params, true)
  }

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

async function hiveCallTool(name: string, args: any = {}, _retried = false) {
  const result = await hivePost('tools/call', { name, arguments: args }, _retried)
  const text = result.content[0].text
  if (result.isError) throw new Error(text)
  try { return JSON.parse(text) } catch { return text }
}

async function initHiveSession() {
  sessionId = null  // ensure no stale id is sent
  await hivePost('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'hive-channel', version: '1.0' },
  })
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

async function registerAgent(opts: { id?: string; name?: string }) {
  const args: any = { tool: 'claude', roles: 'channel' }
  if (opts.id) args.id = opts.id
  if (opts.name) args.name = opts.name
  const result = await hiveCallTool('hive.start', args)
  agentId = result.agent_id
  agentName = result.display_name
  if (!sseStarted) {
    sseStarted = true
    listenSSE()
  }
  return result
}

// --- MCP server (stdio, plugin-side) ---

const mcp = new Server(
  { name: 'hive-channel', version: '0.4.1' },
  {
    capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
    instructions: [
      'You are connected to kitty-hive, a multi-agent collaboration server.',
      'Push notifications arrive as <channel source="hive-channel" from_agent_id="..." type="..."> blocks.',
      '',
      '## Identity',
      '- IMPORTANT: On first use, ask the user "What name should I register on the hive?" and call hive-whoami(name=<that name>).',
      '- Your agent_id (returned by whoami) is the stable handle for cross-team addressing.',
      '- display_name is for display only; not unique. Per-team you can also have a unique nickname (hive-team-nickname).',
      '',
      '## Tools',
      '- Identity: hive-whoami, hive-rename, hive-agents (list all agents on the hive)',
      '- DM: hive-dm (to=agent id or team-nickname), hive-inbox',
      '- Teams: hive-team-create, hive-team-join, hive-team-list, hive-teams (mine), hive-team-info, hive-team-events, hive-team-message, hive-team-nickname',
      '- Tasks: hive-task, hive-claim, hive-tasks, hive-check',
      '- Workflow: hive-propose, hive-approve, hive-step-complete, hive-reject',
      '- Federation: hive-peers, hive-remote-agents (use id@node)',
      '',
      '## Workflow rules',
      '- When you receive a task, propose a workflow (hive-propose) before starting.',
      '- NEVER auto-approve a workflow — show the proposal to the user and wait for explicit confirmation.',
      '- Mark each step with hive-step-complete.',
      '- Claim unassigned tasks with hive-claim.',
      '',
      '## Artifacts',
      '~/.kitty-hive/artifacts/<task_id>/',
    ].join('\n'),
  },
)

// --- Dynamic tool proxy ---
// Channel discovers hive.* tools from the HTTP server at startup, then exposes
// them as kebab-case `hive-*` tools. Calls are forwarded with `as: agentId`
// injected. Only `hive-whoami` is implemented locally (manages session state).

interface MCPTool {
  name: string
  description?: string
  inputSchema: any
}

let cachedHiveTools: MCPTool[] = []

function hiveToKebab(name: string): string {
  return name.replace(/\./g, '-')
}

function kebabToHive(name: string): string {
  return name.replace(/-/g, '.')
}

function stripAsParam(schema: any): any {
  if (!schema?.properties) return schema
  const { as: _as, ...rest } = schema.properties
  const required = Array.isArray(schema.required) ? schema.required.filter((r: string) => r !== 'as') : undefined
  const out: any = { ...schema, properties: rest }
  if (required && required.length > 0) out.required = required
  else delete out.required
  return out
}

async function refreshHiveTools(): Promise<void> {
  try {
    const result = await hivePost('tools/list', {})
    cachedHiveTools = (result.tools || []).filter((t: MCPTool) => t.name.startsWith('hive.'))
  } catch (err) {
    console.error('[hive-channel] failed to fetch tool list:', err)
  }
}

const WHOAMI_TOOL: MCPTool = {
  name: 'hive-whoami',
  description: 'Show your agent id, display_name, and registration info. If not registered, pass `name` to register.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Agent name (only when first registering)' } },
  },
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  if (cachedHiveTools.length === 0) await refreshHiveTools()
  const tools: MCPTool[] = [WHOAMI_TOOL]
  for (const t of cachedHiveTools) {
    // hive.whoami is served locally (manages registration state)
    if (t.name === 'hive.whoami') continue
    tools.push({
      name: hiveToKebab(t.name),
      description: t.description,
      inputSchema: stripAsParam(t.inputSchema),
    })
  }
  return { tools }
})

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params
  const args = (req.params.arguments || {}) as any

  // Local handler: hive-whoami
  if (name === 'hive-whoami') {
    if (!agentName) {
      if (!args.name) {
        return { content: [{ type: 'text', text: 'Not registered. Provide a "name" parameter to register.' }], isError: true }
      }
      await registerAgent({ name: args.name })
      await refreshHiveTools()
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ agent_id: agentId, agent_name: agentName, hive_url: HIVE_URL, session_id: sessionId }, null, 2),
      }],
    }
  }

  // Lazy-registration guard
  if (!agentName) {
    return {
      content: [{ type: 'text', text: 'Not registered. Call hive-whoami(name=<your-agent-name>) first.' }],
      isError: true,
    }
  }

  // Proxy all other hive-* tools to hive.* with `as: agentId` injected
  if (!name.startsWith('hive-')) throw new Error(`Unknown tool: ${name}`)
  const hiveName = kebabToHive(name)
  const result = await hiveCallTool(hiveName, { as: agentId, ...args })
  return {
    content: [{
      type: 'text',
      text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
    }],
  }
})

// --- Push notifications: SSE → channel ---

const pushedMessages = new Set<string>()
function dedup(key: string): boolean {
  if (pushedMessages.has(key)) return false
  pushedMessages.add(key)
  if (pushedMessages.size > 500) {
    const first = pushedMessages.values().next().value
    if (first) pushedMessages.delete(first)
  }
  return true
}

async function listenSSE() {
  while (true) {
    try {
      const res = await fetch(HIVE_URL, {
        method: 'GET',
        headers: { 'Accept': 'text/event-stream', 'Mcp-Session-Id': sessionId! },
      })
      if (!res.ok || !res.body) {
        console.error(`[hive-channel] SSE connect failed: ${res.status}, re-registering...`)
        try {
          await initHiveSession()
          if (agentId) await hiveCallTool('hive.start', { id: agentId, tool: 'claude', roles: 'channel' })
        } catch (e) {
          console.error(`[hive-channel] re-register failed:`, e)
        }
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
            if (data.method !== 'notifications/message' || !data.params?.data) continue

            const raw = data.params.data
            let parsed: any
            try { parsed = JSON.parse(raw) } catch { parsed = { type: 'message', preview: raw } }

            // Skip join/leave noise
            if (parsed.type === 'join' || parsed.type === 'leave') continue

            const content = parsed.preview || parsed.title || raw
            const from = parsed.from || parsed.from_agent_id || 'unknown'
            const key = `${from}:${parsed.type}:${content.slice(0, 60)}`
            if (!dedup(key)) continue

            await mcp.notification({
              method: 'notifications/claude/channel',
              params: {
                content,
                meta: {
                  type: parsed.type,
                  from,
                  from_agent_id: parsed.from_agent_id || '',
                  team_id: parsed.team_id || '',
                  task_id: parsed.task_id || '',
                },
              },
            })
          } catch { /* ignore parse errors */ }
        }
      }
    } catch (err) {
      console.error(`[hive-channel] SSE error, reconnecting...`, err)
    }
    await new Promise(r => setTimeout(r, 2000))
  }
}

// --- Start ---

await mcp.connect(new StdioServerTransport())

async function connectToHive() {
  while (true) {
    try {
      await initHiveSession()
      if (HIVE_AGENT_ID || HIVE_AGENT_NAME) {
        await registerAgent({ id: HIVE_AGENT_ID || undefined, name: HIVE_AGENT_NAME || undefined })
        console.error(`[hive-channel] connected as "${agentName}" (${agentId})`)
      } else {
        console.error(`[hive-channel] connected (no env identity — register via hive-whoami)`)
      }
      return
    } catch (err) {
      console.error(`[hive-channel] hive not ready, retrying in 3s...`, err)
      await new Promise(r => setTimeout(r, 3000))
    }
  }
}

await connectToHive()
