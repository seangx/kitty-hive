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
const HIVE_AGENT_KEY = process.env.HIVE_AGENT_KEY || ''
const HIVE_AGENT_NAME = process.env.HIVE_AGENT_NAME || ''
const HIVE_AGENT_ROLES = process.env.HIVE_AGENT_ROLES || ''

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
    if (agentId) await hiveCallTool('hive_start', reconnectArgs(), true)
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

// Build args for hive_start. Only sets `roles` when HIVE_AGENT_ROLES env is
// provided — pre-v0.6.5 channel.ts hardcoded `roles='channel'`, polluting the
// field that role-based routing relies on. Now we leave roles empty by default;
// agents accumulate roles via hive_update_role as they do work, and routing
// falls back to display_name substring match in the meantime.
function reconnectArgs(): any {
  const a: any = { tool: 'claude' }
  if (agentId) a.id = agentId
  if (HIVE_AGENT_ROLES) a.roles = HIVE_AGENT_ROLES
  return a
}

async function registerAgent(opts: { id?: string; key?: string; name?: string }) {
  const args: any = { tool: 'claude' }
  if (HIVE_AGENT_ROLES) args.roles = HIVE_AGENT_ROLES
  if (opts.id) args.id = opts.id
  if (opts.key) args.key = opts.key
  if (opts.name) args.name = opts.name
  let result: any
  try {
    result = await hiveCallTool('hive_start', args)
  } catch (err: any) {
    // Old server (pre-v0.6.2) doesn't know `key` and rejects with schema
    // validation error. Drop key and retry — clients stay forward-compatible.
    const msg = String(err?.message || err)
    if (opts.key && /key|invalid params|unknown|validation|unrecognized/i.test(msg)) {
      console.error(`[hive-channel] server rejected key param, falling back to name-only: ${msg}`)
      delete args.key
      result = await hiveCallTool('hive_start', args)
    } else {
      throw err
    }
  }
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
  { name: 'hive-channel', version: '0.5.3' },
  {
    capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
    instructions: [
      'You are connected to kitty-hive, a multi-agent collaboration server.',
      'Push notifications arrive as <channel source="hive-channel" from_agent_id="..." type="..." message_id="..."> blocks.',
      '',
      '## Identity',
      '- IMPORTANT: On first use, ask the user "What name should I register on the hive?" and call hive-whoami(name=<that name>).',
      '- Your agent_id (returned by whoami) is the stable handle for cross-team addressing.',
      '- display_name is for display only; not unique. Per-team you can also have a unique nickname (set when calling hive-team-join).',
      '',
      '## Addressing (`to` parameter)',
      '- agent id (always works)',
      '- team-nickname (must be unique within a team you both belong to)',
      '- display_name (only if globally unambiguous)',
      '- role:xxx (tasks only — picks an active agent with that role)',
      '- id@<peer-name> for cross-machine federation (peer name shown by hive-peers)',
      '',
      '## Tools',
      '- Identity: hive-whoami, hive-rename, hive-update-role (self-maintain role tags), hive-agents (list all agents on the hive)',
      '- DM & files: hive-dm (pass attach: ["/local/path"] to send files), hive-inbox, hive-dm-read (full content when preview has a [hive note] block), hive-file-fetch (get attachment by file_id)',
      '- Teams: hive-team-create, hive-team-join, hive-team-list, hive-teams (mine), hive-team-info, hive-team-events, hive-team-message',
      '- Tasks: hive-task, hive-task-claim, hive-task-cancel (creator only), hive-tasks, hive-check',
      '- Workflow: hive-workflow-propose (set gate:true per step for review pauses), hive-workflow-approve, hive-workflow-step-complete, hive-workflow-step-approve (release gate, creator only), hive-workflow-reject',
      '- Federation: hive-peers, hive-remote-agents (then DM/task with id@<peer-name>)',
      '',
      '## Roles',
      '`roles` is a comma-separated tag list describing the kinds of work you can do. It drives `role:xxx` routing — others find you by capability instead of by name.',
      '',
      'Self-maintain it:',
      '- After completing a kind of work you previously had not done, call hive-update-role(add=[\'<domain>\']). Examples: first e2e test → add \'tester\'; first code review → add \'reviewer\'.',
      '- If you were wrongly routed via role:X (you are not actually the right fit), call hive-update-role(remove=[\'X\']).',
      '- Do NOT pre-occupy roles. Only register what you can demonstrably do.',
      '',
      'Common roles: tester, reviewer, frontend, backend, db, devops, ux, design, docs. Project-specific tags also fine.',
      '',
      'If your `roles` is empty, routing falls back to display_name substring match — so a display_name containing your role (e.g. "tester") still gets you found. Setting roles makes routing more precise.',
      '',
      '## Team collaboration',
      'When a task has source_team_id, or you belong to a team:',
      '- BEFORE creating a new task: call hive-tasks(team=<team>) to see if a similar task is already in flight. Avoid duplicates.',
      '- WHEN delegating: prefer role:xxx — routing matches inside the team first.',
      '- IF unsure who to pick: call hive-team-info(team=<team>) to see members, their roles, and expertise.',
      '',
      '## Workflow rules',
      '- When you receive a task, propose a workflow (hive-workflow-propose) before starting.',
      '- For multi-phase workflows where the creator will want to review output between phases, set `gate: true` on each reviewable step. The task then pauses in status `awaiting_approval` after each gated step until the creator calls hive-workflow-step-approve. Without `gate`, the system auto-advances and the creator loses the chance to gate execution.',
      '- NEVER auto-approve a workflow — show the proposal to the user and wait for explicit confirmation. Then call hive-workflow-approve.',
      '- Same rule for hive-workflow-step-approve: only the creator (via the user) decides when a gated phase is released.',
      '- Mark each step with hive-workflow-step-complete.',
      '- Claim unassigned tasks with hive-task-claim.',
      '- step.action MUST be ≤400 chars. POINT to upstream spec (openspec change ref / Linear or issue id / doc URL / prior DM message_id) — do NOT inline acceptance criteria. Spec details belong in the spec system, not in task workflow text.',
      '',
      '## File transfer (paths do not cross machines)',
      '- A local path you mention in DM `content` cannot be opened by the receiver (different OS/machine).',
      '- To share a file, pass it via `hive-dm({ ..., attach: ["/abs/path"] })` — bytes are copied into hive and replicated across federation.',
      '- The receiver gets `attachments: [{file_id, filename, mime, size}]` in their inbox; they call `hive-file-fetch({ file_id })` to read locally.',
      '',
      '## Channel pushes are id-only (v0.6.0+)',
      '- A push carries only: sender, event type, and the identifier(s) needed to fetch the full record. No body, no preview text.',
      '- The push text always ends with `… — call <tool>({...}) for full content.` You MUST run that call before acting:',
      '    DM             → hive-dm-read({ message_id: N })',
      '    Task event     → hive-check({ task_id: "..." })     # any task-* or step-* push',
      '    Team event     → hive-team-events({ team_id: "..." })',
      '- Acting on the push text alone = acting without the content. Always fetch first.',
      '',
      '## Artifacts',
      '~/.kitty-hive/artifacts/<task_id>/',
    ].join('\n'),
  },
)

// --- Dynamic tool proxy ---
// Channel discovers hive_* tools from the HTTP server at startup, then exposes
// them as kebab-case `hive-*` tools. Calls are forwarded with `as: agentId`
// injected. Only `hive-whoami` is implemented locally (manages session state).

interface MCPTool {
  name: string
  description?: string
  inputSchema: any
}

let cachedHiveTools: MCPTool[] = []

function hiveToKebab(name: string): string {
  return name.replace(/_/g, '-')
}

function kebabToHive(name: string): string {
  return name.replace(/-/g, '_')
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
    cachedHiveTools = (result.tools || []).filter((t: MCPTool) => t.name.startsWith('hive_'))
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
    // hive_whoami is served locally (manages registration state)
    if (t.name === 'hive_whoami') continue
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

  // Proxy all other hive-* tools to hive_* with `as: agentId` injected
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
          if (agentId) await hiveCallTool('hive_start', reconnectArgs())
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
            // Prefer stable event_id (v0.6.0+); fall back to message_id for DMs,
            // then to the content-prefix hash for anything older.
            const dedupKey = parsed.event_id
              || (parsed.message_id != null ? `dm:${parsed.message_id}` : null)
              || `${from}:${parsed.type}:${content.slice(0, 60)}`
            if (!dedup(dedupKey)) continue

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
                  event_id: parsed.event_id || '',
                  message_id: parsed.message_id != null ? String(parsed.message_id) : '',
                  reason: parsed.reason || '',
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
      if (HIVE_AGENT_ID || HIVE_AGENT_KEY || HIVE_AGENT_NAME) {
        // Priority order is enforced server-side (id > key > name); we just
        // forward whatever the orchestrator gave us.
        await registerAgent({
          id: HIVE_AGENT_ID || undefined,
          key: HIVE_AGENT_KEY || undefined,
          name: HIVE_AGENT_NAME || undefined,
        })
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
