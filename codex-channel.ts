#!/usr/bin/env node
/**
 * kitty-hive codex-channel — push delivery for OpenAI Codex agents.
 *
 * Codex CLI has no equivalent of Claude Code's `notifications/claude/channel`,
 * so a real-time agent like a "codex code-reviewer" can't passively wait for
 * hive events. This bridge fills that gap WITHOUT touching the hive server:
 *
 *   1. Registers a long-lived agent identity on hive (via hive_start).
 *   2. Subscribes to that agent's SSE push stream.
 *   3. On each push, spawns `codex exec "<prompt>"` — codex picks up the work,
 *      uses its locally-configured hive MCP tools (set up via `kitty-hive init
 *      codex`) to fetch full content and act, then exits.
 *
 * Bridge is fully event-driven, queues pushes while codex is busy, and survives
 * hive restarts via the same 404 → re-init logic channel.ts uses.
 *
 * Usage:
 *   npx kitty-hive codex-channel --name "code-reviewer"
 *   HIVE_AGENT_NAME=code-reviewer npx kitty-hive codex-channel
 *   HIVE_AGENT_ID=0moc... npx kitty-hive codex-channel    # rebind to existing
 *
 * Env:
 *   HIVE_URL          (default http://localhost:4123/mcp)
 *   HIVE_AGENT_ID     reuse this agent (highest priority)
 *   HIVE_AGENT_KEY    external orchestrator key (idempotent register)
 *   HIVE_AGENT_NAME   display_name to register as
 *   HIVE_AGENT_ROLES  comma-separated initial roles
 *   CODEX_CMD         path to codex binary (default: `codex` from PATH)
 *   CODEX_PROFILE     codex profile name to pass via --profile (optional)
 *   CODEX_EXTRA_ARGS  extra space-separated args before the prompt
 */

import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';

// --- Config (env) ---

const HIVE_URL = process.env.HIVE_URL || 'http://localhost:4123/mcp';
const HIVE_AGENT_ID = process.env.HIVE_AGENT_ID || '';
const HIVE_AGENT_KEY = process.env.HIVE_AGENT_KEY || '';
const HIVE_AGENT_NAME = process.env.HIVE_AGENT_NAME || '';
const HIVE_AGENT_ROLES = process.env.HIVE_AGENT_ROLES || '';
const CODEX_CMD = process.env.CODEX_CMD || 'codex';
const CODEX_PROFILE = process.env.CODEX_PROFILE || '';
const CODEX_EXTRA_ARGS = (process.env.CODEX_EXTRA_ARGS || '').trim();

// Allow CLI flags to override env
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--name' && process.argv[i + 1]) { (process.env as any).HIVE_AGENT_NAME = process.argv[++i]; }
  else if (a === '--id' && process.argv[i + 1]) { (process.env as any).HIVE_AGENT_ID = process.argv[++i]; }
  else if (a === '--key' && process.argv[i + 1]) { (process.env as any).HIVE_AGENT_KEY = process.argv[++i]; }
  else if (a === '--url' && process.argv[i + 1]) { (process.env as any).HIVE_URL = process.argv[++i]; }
  else if (a === '--profile' && process.argv[i + 1]) { (process.env as any).CODEX_PROFILE = process.argv[++i]; }
  else if (a === '--help' || a === '-h') {
    console.log('Usage: kitty-hive codex-channel [--name <n>] [--id <id>] [--key <k>] [--url <u>] [--profile <p>]');
    console.log('Env: HIVE_URL, HIVE_AGENT_ID|KEY|NAME|ROLES, CODEX_CMD, CODEX_PROFILE, CODEX_EXTRA_ARGS');
    process.exit(0);
  }
}
// Re-read after CLI overrides
const ENV_NAME = process.env.HIVE_AGENT_NAME || HIVE_AGENT_NAME;
const ENV_ID = process.env.HIVE_AGENT_ID || HIVE_AGENT_ID;
const ENV_KEY = process.env.HIVE_AGENT_KEY || HIVE_AGENT_KEY;
const ENV_URL = process.env.HIVE_URL || HIVE_URL;

function preflight() {
  // Check codex is in PATH (warn, don't fail — user might have CODEX_CMD set)
  try {
    execSync(`${CODEX_CMD} --version`, { stdio: 'pipe' });
  } catch {
    console.error(`[codex-channel] WARN: \`${CODEX_CMD}\` not found in PATH or fails to run.`);
    console.error(`[codex-channel]       Install codex CLI first or set CODEX_CMD env to the binary path.`);
  }
  if (!ENV_ID && !ENV_KEY && !ENV_NAME) {
    console.error('[codex-channel] FATAL: must provide --name, --id, or --key (or HIVE_AGENT_NAME/ID/KEY env)');
    process.exit(1);
  }
}

// --- Hive HTTP client ---

let sessionId: string | null = null;
let agentId: string | null = null;
let agentName: string | null = null;
let rpcId = 0;

async function hivePost(method: string, params: any = {}, _retried = false): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (sessionId && method !== 'initialize') headers['Mcp-Session-Id'] = sessionId;

  const res = await fetch(ENV_URL, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });

  // Server lost session (restarted) — re-init and retry once
  if (res.status === 404 && !_retried && method !== 'initialize') {
    console.error(`[codex-channel] server returned 404 (stale session); re-initializing...`);
    sessionId = null;
    await initHiveSession();
    if (agentId) await hiveCallTool('hive_start', reconnectArgs(), true);
    return hivePost(method, params, true);
  }

  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;

  const text = await res.text();
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) {
      const data = JSON.parse(line.slice(5));
      if (data.error) throw new Error(JSON.stringify(data.error));
      return data.result;
    }
  }
  const data = JSON.parse(text);
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.result;
}

async function hiveCallTool(name: string, args: any = {}, _retried = false) {
  const result = await hivePost('tools/call', { name, arguments: args }, _retried);
  const text = result.content[0].text;
  if (result.isError) throw new Error(text);
  try { return JSON.parse(text); } catch { return text; }
}

async function initHiveSession() {
  sessionId = null;
  await hivePost('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'codex-channel', version: '1.0' },
  });
  await fetch(ENV_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': sessionId!,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
}

function reconnectArgs(): any {
  const a: any = { tool: 'codex' };
  if (agentId) a.id = agentId;
  if (HIVE_AGENT_ROLES) a.roles = HIVE_AGENT_ROLES;
  return a;
}

async function registerAgent() {
  const args: any = { tool: 'codex' };
  if (HIVE_AGENT_ROLES) args.roles = HIVE_AGENT_ROLES;
  if (ENV_ID) args.id = ENV_ID;
  if (ENV_KEY) args.key = ENV_KEY;
  if (ENV_NAME) args.name = ENV_NAME;

  let result: any;
  try {
    result = await hiveCallTool('hive_start', args);
  } catch (err: any) {
    // Pre-v0.6.2 servers don't know `key` — drop and retry
    const msg = String(err?.message || err);
    if (args.key && /key|invalid params|unknown|validation|unrecognized/i.test(msg)) {
      console.error(`[codex-channel] server rejected key param, falling back to name-only: ${msg}`);
      delete args.key;
      result = await hiveCallTool('hive_start', args);
    } else {
      throw err;
    }
  }
  agentId = result.agent_id;
  agentName = result.display_name;
  return result;
}

// --- Push handling: SSE → codex exec ---

const pushedMessages = new Set<string>();
function dedup(key: string): boolean {
  if (pushedMessages.has(key)) return false;
  pushedMessages.add(key);
  if (pushedMessages.size > 500) {
    const first = pushedMessages.values().next().value;
    if (first) pushedMessages.delete(first);
  }
  return true;
}

interface ParsedEvent {
  type?: string;
  from?: string;
  from_agent_id?: string;
  message_id?: number;
  task_id?: string;
  team_id?: string;
  preview?: string;
  title?: string;
  event_id?: string;
  raw?: string;
}

let codexBusy = false;
const eventQueue: ParsedEvent[] = [];

function buildPrompt(ev: ParsedEvent): string {
  const senderLabel = ev.from || ev.from_agent_id || 'unknown';
  const summary = ev.title || ev.preview || ev.raw || `(no summary)`;

  const fetchHint = (() => {
    if (ev.type === 'message' && ev.message_id != null) {
      return `Fetch full DM with: hive_dm_read({ message_id: ${ev.message_id}, as: "${agentId}" })`;
    }
    if (ev.task_id) {
      return `Fetch task state with: hive_check({ task_id: "${ev.task_id}", as: "${agentId}" })`;
    }
    if (ev.team_id) {
      return `Fetch team events with: hive_team_events({ team_id: "${ev.team_id}", as: "${agentId}" })`;
    }
    return `Use hive_inbox({ as: "${agentId}" }) to see what arrived.`;
  })();

  return [
    `You are kitty-hive agent "${agentName}" (id: ${agentId}).`,
    ``,
    `A new event arrived on the hive channel:`,
    `  type:    ${ev.type || 'unknown'}`,
    `  from:    ${senderLabel}`,
    `  summary: ${summary}`,
    ``,
    `STEP 1 — bind your MCP session to your hive identity:`,
    `  Call hive_start({ id: "${agentId}" }) FIRST. This makes subsequent hive_*`,
    `  tool calls run as you (otherwise you'll register a fresh agent every run).`,
    ``,
    `STEP 2 — fetch the full content (the push above is id-only by design):`,
    `  ${fetchHint}`,
    ``,
    `STEP 3 — handle the event according to its type:`,
    `  - DM            → read it; reply via hive_dm if appropriate`,
    `  - task-propose  → review the proposed workflow; only the creator approves`,
    `  - task-assigned → propose a workflow with hive_workflow_propose, then await approval`,
    `  - step-start    → execute YOUR part of the current step, then hive_workflow_step_complete`,
    `  - awaiting_approval → only the task creator releases the gate (hive_workflow_step_approve)`,
    `  - team-message  → read; act if the broadcast addresses you`,
    ``,
    `When done, exit. The codex-channel daemon will spawn you again on the next event.`,
  ].join('\n');
}

function spawnCodex(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const args: string[] = ['exec'];
    if (CODEX_PROFILE) args.push('--profile', CODEX_PROFILE);
    if (CODEX_EXTRA_ARGS) args.push(...CODEX_EXTRA_ARGS.split(/\s+/).filter(Boolean));
    args.push(prompt);

    console.error(`[codex-channel] spawning: ${CODEX_CMD} exec  (prompt ${prompt.length} chars)`);
    const child = spawn(CODEX_CMD, args, {
      stdio: 'inherit',
      env: {
        ...process.env,
        // Tell the spawned codex which hive identity to bind to. The prompt
        // also tells codex to call hive_start({id}) — env is a backup signal
        // for any tooling that respects it.
        HIVE_AGENT_ID: agentId || '',
      },
    });
    child.on('exit', (code) => {
      console.error(`[codex-channel] codex exited (code=${code})`);
      resolve();
    });
    child.on('error', (err) => {
      console.error(`[codex-channel] codex spawn error:`, err);
      resolve();
    });
  });
}

async function processNextEvent() {
  if (codexBusy) return;
  const next = eventQueue.shift();
  if (!next) return;
  codexBusy = true;
  try {
    await spawnCodex(buildPrompt(next));
  } finally {
    codexBusy = false;
  }
  // Drain any events that piled up while codex was running
  if (eventQueue.length > 0) setImmediate(processNextEvent);
}

function enqueue(ev: ParsedEvent) {
  eventQueue.push(ev);
  setImmediate(processNextEvent);
}

async function listenSSE() {
  while (true) {
    try {
      const res = await fetch(ENV_URL, {
        method: 'GET',
        headers: { 'Accept': 'text/event-stream', 'Mcp-Session-Id': sessionId! },
      });
      if (!res.ok || !res.body) {
        console.error(`[codex-channel] SSE connect failed: ${res.status}, re-registering...`);
        try {
          await initHiveSession();
          if (agentId) await hiveCallTool('hive_start', reconnectArgs());
        } catch (e) {
          console.error(`[codex-channel] re-register failed:`, e);
        }
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      console.error(`[codex-channel] SSE stream connected; waiting for events`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          try {
            const data = JSON.parse(line.slice(5));
            if (data.method !== 'notifications/message' || !data.params?.data) continue;

            const raw = data.params.data;
            let parsed: ParsedEvent;
            try { parsed = JSON.parse(raw); } catch { parsed = { type: 'message', preview: raw, raw }; }

            // Skip noise that codex doesn't need to react to
            if (parsed.type === 'join' || parsed.type === 'leave') continue;

            const from = parsed.from || parsed.from_agent_id || 'unknown';
            const content = parsed.preview || parsed.title || raw;
            const dedupKey = parsed.event_id
              || (parsed.message_id != null ? `dm:${parsed.message_id}` : null)
              || `${from}:${parsed.type}:${content.slice(0, 60)}`;
            if (!dedup(dedupKey)) continue;

            console.error(`[codex-channel] push: ${parsed.type} from ${from}`);
            enqueue(parsed);
          } catch (err) {
            console.error(`[codex-channel] SSE parse error:`, err);
          }
        }
      }
      console.error(`[codex-channel] SSE stream closed by server, reconnecting...`);
    } catch (err) {
      console.error(`[codex-channel] SSE error:`, err);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// --- Boot ---

async function main() {
  preflight();
  while (true) {
    try {
      await initHiveSession();
      const res = await registerAgent();
      console.error(`[codex-channel] connected as "${res.display_name}" (${res.agent_id})`);
      console.error(`[codex-channel] hive=${ENV_URL}  codex=${CODEX_CMD}${CODEX_PROFILE ? `  profile=${CODEX_PROFILE}` : ''}`);
      break;
    } catch (err) {
      console.error(`[codex-channel] hive not ready, retrying in 3s...`, err);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  await listenSSE();
}

main().catch((err) => {
  console.error('[codex-channel] fatal:', err);
  process.exit(1);
});
