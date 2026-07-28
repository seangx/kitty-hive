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
 *   HIVE_EVENT_MODE   auto (daemon handles events) or foreground (default auto)
 *   HIVE_SUPERVISOR_PID parent kitty-hive serve PID (supervised mode only)
 *   CODEX_CMD         path to codex binary (default: `codex` from PATH)
 *   CODEX_PROFILE     codex profile name to pass via --profile (optional)
 *   CODEX_EXTRA_ARGS  extra space-separated args before the prompt
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { execSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { HistoryItemInjector, TurnTracker, answerServerRequest, buildEventTimingLines, buildThreadResumeParams, checkEventDeliveryBeforeInject, decideEventDelivery, supervisorProcessIsMissing, type RpcTransport, type TurnOutcome } from './src/codex-channel-runtime.js';

// --- Config (env) ---

const HIVE_URL = process.env.HIVE_URL || 'http://localhost:4123/mcp';
const HIVE_AGENT_ID = process.env.HIVE_AGENT_ID || '';
const HIVE_AGENT_KEY = process.env.HIVE_AGENT_KEY || '';
const HIVE_AGENT_NAME = process.env.HIVE_AGENT_NAME || '';
const HIVE_AGENT_ROLES = process.env.HIVE_AGENT_ROLES || '';
const CODEX_CMD = process.env.CODEX_CMD || 'codex';
const CODEX_PROFILE = process.env.CODEX_PROFILE || '';
const CODEX_EXTRA_ARGS = (process.env.CODEX_EXTRA_ARGS || '').trim();
// CODEX_CHANNEL_MODE: 'auto' (default) tries appserver first, falls back to
// exec if codex < 0.124 or app-server fails to start. 'appserver' forces
// appserver mode (fails hard if unavailable). 'exec' forces the legacy
// spawn-per-event mode (works on any codex version, no shared context).
const CODEX_CHANNEL_MODE = (process.env.CODEX_CHANNEL_MODE || 'auto') as 'auto' | 'appserver' | 'exec';
const CODEX_APPSERVER_CWD = process.env.CODEX_APPSERVER_CWD || process.cwd();
const HIVE_SUPERVISOR_PID = process.env.HIVE_SUPERVISOR_PID;
// Timeout for thread/start + thread/resume. codex 0.144 blocks these ~30s on
// a models-refresh child-process hang (vendor bug, openai/codex#14795-family:
// "failed to refresh available models: timeout waiting for child process to
// exit"), so the old 30s default made every daemon boot a coin flip and
// crash-looped the whole fleet on 2026-07-15. Resume of a large rollout jsonl
// under boot-storm load can also legitimately exceed 30s.
const THREAD_RPC_TIMEOUT_MS = 120_000;

// Allow CLI flags to override env
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--name' && process.argv[i + 1]) { (process.env as any).HIVE_AGENT_NAME = process.argv[++i]; }
  else if (a === '--id' && process.argv[i + 1]) { (process.env as any).HIVE_AGENT_ID = process.argv[++i]; }
  else if (a === '--key' && process.argv[i + 1]) { (process.env as any).HIVE_AGENT_KEY = process.argv[++i]; }
  else if (a === '--url' && process.argv[i + 1]) { (process.env as any).HIVE_URL = process.argv[++i]; }
  else if (a === '--profile' && process.argv[i + 1]) { (process.env as any).CODEX_PROFILE = process.argv[++i]; }
  else if (a === '--event-mode' && process.argv[i + 1]) { (process.env as any).HIVE_EVENT_MODE = process.argv[++i]; }
  else if (a === '--help' || a === '-h') {
    console.log('Usage: kitty-hive codex-channel [--name <n>] [--id <id>] [--key <k>] [--url <u>] [--profile <p>] [--event-mode auto|foreground]');
    console.log('Env: HIVE_URL, HIVE_AGENT_ID|KEY|NAME|ROLES, HIVE_EVENT_MODE, CODEX_CMD, CODEX_PROFILE, CODEX_EXTRA_ARGS');
    process.exit(0);
  }
}
// Re-read after CLI overrides
const ENV_NAME = process.env.HIVE_AGENT_NAME || HIVE_AGENT_NAME;
const ENV_ID = process.env.HIVE_AGENT_ID || HIVE_AGENT_ID;
const ENV_KEY = process.env.HIVE_AGENT_KEY || HIVE_AGENT_KEY;
const ENV_URL = process.env.HIVE_URL || HIVE_URL;
const HIVE_EVENT_MODE = process.env.HIVE_EVENT_MODE === 'foreground' ? 'foreground' : 'auto';
const PUSH_DELIVERY_STATUS_URL = new URL('/admin/push-delivery-status', ENV_URL).toString();

function preflight() {
  const rawEventMode = process.env.HIVE_EVENT_MODE;
  if (rawEventMode && rawEventMode !== 'auto' && rawEventMode !== 'foreground') {
    console.error(`[codex-channel] FATAL: HIVE_EVENT_MODE must be "auto" or "foreground" (got ${JSON.stringify(rawEventMode)})`);
    process.exit(1);
  }
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
  replayed?: boolean;
  queued_at?: string;
  /** Daemon-side arrival timestamp (ISO), stamped at enqueue. Injected into
   *  the turn text so codex can spot stale deliveries: a turn that hung
   *  in-flight (e.g. the 2026-07-15 approval-freeze incident) may only
   *  EXECUTE hours later, after a thread resume — without this stamp the
   *  overnight event looks exactly like a fresh push (bug reported by 管家,
   *  DM #1978). */
  received_at?: string;
}

// NO daemon-side retry. Earlier versions retried failed `sendTurn`s up to 3×;
// that turned out to be the proximate cause of the 2026-05-26 duplicate-turn
// incident — see codex-channel-runtime.ts header for the post-mortem. The
// TurnTracker now blocks re-issue of `turn/start` for an already-attempted
// event_id; loss recovery (hive SSE replay, pending_pushes drain on daemon
// respawn) lives at a higher layer.

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
    ...buildEventTimingLines(ev).map(line => `  ${line}`),
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
    `  - task-assigned → do the work, then hive_task_complete({ task_id, result }).`,
    `                    Only use hive_workflow_propose when the task genuinely needs`,
    `                    multiple steps/agents/review gates (it forces an approval round-trip)`,
    `  - step-start    → execute YOUR part of the current step, then hive_workflow_step_complete`,
    `  - awaiting_approval → only the task creator releases the gate (hive_workflow_step_approve)`,
    `  - team-message  → read; act if the broadcast addresses you`,
    ``,
    `When done, exit. The codex-channel daemon will spawn you again on the next event.`,
  ].join('\n');
}

// ===== Appserver mode (codex ≥ 0.124) =====
// Long-lived codex via `codex app-server --listen ws://127.0.0.1:<port>`.
// One JSON-RPC WebSocket connection and one persistent thread. Auto-mode
// events start turns; foreground-mode events only append model-visible
// history via thread/inject_items, so no background inference can consume
// Hive messages. Thread context survives daemon restarts.

let pushMode: 'appserver' | 'exec' | null = null;
let appserverProc: ChildProcess | null = null;
let appserverWs: any /* WebSocket */ = null;
let appserverWsUrl: string | null = null;  // ws://127.0.0.1:<port> — for outside callers via supervisor
let threadId: string | null = null;
let appserverDeathHandled = false;  // guard so multiple death signals only exit once
let turnTracker: TurnTracker | null = null;
let historyInjector: HistoryItemInjector | null = null;
let controlServer: HttpServer | null = null;
let controlUrl: string | null = null;      // http://127.0.0.1:<port> — supervisor drives in-process thread switch
let supervisorWatchdog: NodeJS.Timeout | null = null;

/** Called when EITHER codex app-server child process dies post-ready OR the WS
 *  closes / errors. Both fire together when app-server crashes. Exits the
 *  daemon with non-zero so the supervisor's child.on('exit') triggers an
 *  exponential-backoff respawn with a fresh codex app-server. In-flight events
 *  in the local queue ARE lost — known limitation, documented in v0.7.0 notes.
 *  Idempotent via the appserverDeathHandled guard. */
function onAppserverDeath(reason: string): void {
  if (appserverDeathHandled) return;
  appserverDeathHandled = true;
  console.error(`[codex-channel] appserver died: ${reason}`);
  console.error('[codex-channel] exiting daemon — supervisor will respawn with fresh codex app-server');
  // Full group cleanup, NOT just appserverProc.kill(): this path also fires
  // on WS-level errors while the codex app-server process tree is still
  // alive. Killing only the direct child leaves the vendor codex binary
  // (grandchild, same detached group) running and LISTENing forever.
  // Real incident 2026-07-14: 60+ orphaned app-servers accumulated over a
  // month of crash exits, drove load past 9, and every fresh app-server then
  // timed out on thread/resume → death spiral across all 10 daemons after a
  // serve restart. cleanupAppserver() does the process-group SIGTERM.
  cleanupAppserver();
  // exit code 2 distinguishes "app-server crash" from "clean shutdown via SIGTERM"
  process.exit(2);
}
let nextRpcId = 100;
const pendingResponses = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => port ? resolve(port) : reject(new Error('failed to pick free port')));
    });
    srv.on('error', reject);
  });
}

/** Hive tool names, fetched live from the hive MCP server (tools/list) so
 *  new tools automatically get the headless approval override. Static
 *  fallback covers "hive briefly unreachable" — better a possibly-stale
 *  list than spawning with zero overrides and hanging every turn. */
const HIVE_TOOLS_FALLBACK = [
  'hive_start', 'hive_whoami', 'hive_rename', 'hive_update_role', 'hive_agents',
  'hive_dm', 'hive_dm_read', 'hive_inbox', 'hive_file_fetch',
  'hive_task', 'hive_tasks', 'hive_task_claim', 'hive_task_cancel', 'hive_task_complete', 'hive_check',
  'hive_workflow_propose', 'hive_workflow_approve', 'hive_workflow_reject',
  'hive_workflow_step_complete', 'hive_workflow_step_approve',
  'hive_team_create', 'hive_team_join', 'hive_team_leave', 'hive_team_list', 'hive_teams',
  'hive_team_info', 'hive_team_events', 'hive_team_message', 'hive_team_set_rules', 'hive_team_rename_nickname',
  'hive_peers', 'hive_remote_agents', 'hive_codex_pane_ws',
];

async function listHiveToolNames(): Promise<string[]> {
  try {
    const result = await hivePost('tools/list', {});
    const names = (result?.tools ?? []).map((t: any) => t.name).filter((n: any) => typeof n === 'string' && /^[a-z0-9_]+$/.test(n));
    if (names.length > 0) return names;
  } catch (err) {
    console.error(`[codex-channel] tools/list failed, using static hive tool list: ${err}`);
  }
  return HIVE_TOOLS_FALLBACK;
}

async function setupAppserver(): Promise<void> {
  if (typeof (globalThis as any).WebSocket !== 'function') {
    throw new Error('global WebSocket not available (need Node 22+); set CODEX_CHANNEL_MODE=exec');
  }
  const port = await pickFreePort();
  console.error(`[codex-channel] starting appserver: ${CODEX_CMD} app-server --listen ws://127.0.0.1:${port}`);

  // detached: true puts appserverProc in its own process group, so SIGTERM
  // to -pid kills the entire subtree (npm/npx wrapper + grandchild codex
  // binary). Without this, killing only the wrapper leaves the actual codex
  // process orphaned and still LISTENing on the ws port — see Bug 1 follow-up
  // (2026-05-20): `agent remove` killed the daemon but `lsof -i :<port>` still
  // showed the vendor codex binary holding the port.
  // Spawn codex app-server with config overrides so the daemon's intro turn
  // (which auto-calls hive_start to bind the codex thread's MCP session)
  // doesn't hang waiting for an approval dialog that has no human attached.
  //
  // Background: users typically set `approval_mode = "approve"` per hive
  // tool in ~/.codex/config.toml so a codex they're INTERACTING with prompts
  // before acting. But the headless daemon has no human to click approve —
  // any approval-gated tool call hangs the turn forever (real incidents:
  // 2026-05-27 hive_start "Working (16m12s)"; 2026-07-15 codex 0.144 update
  // → EVERY event turn dead at first hive tool call, all pushes looked
  // broken). Per-tool `-c` overrides are the deterministic fix: explicit
  // tool-level entries beat the user's, and they're per-spawn — the user's
  // interactive codex sessions keep their approval prompts.
  //
  // NOTE codex config precedence: tool-level > server default. A single
  // `default_tools_approval_mode` override would LOSE to the user's explicit
  // per-tool "approve" entries, so we must override every tool by name.
  const approvalOverrides: string[] = [];
  for (const t of await listHiveToolNames()) {
    approvalOverrides.push('-c', `mcp_servers.hive.tools.${t}.approval_mode="auto"`);
  }
  appserverProc = spawn(CODEX_CMD, [
    'app-server',
    '--listen', `ws://127.0.0.1:${port}`,
    ...approvalOverrides,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  // Wait for listen-ready line on stderr, or fail after 10s
  await new Promise<void>((resolve, reject) => {
    let ready = false;
    const timer = setTimeout(() => {
      if (!ready) { ready = true; reject(new Error('codex app-server did not become ready within 10s')); }
    }, 10000);
    appserverProc!.stderr!.on('data', (chunk) => {
      const s = String(chunk);
      process.stderr.write(`[codex-app] ${s}`);
      if (!ready && /Listening|listen|started|ready/i.test(s)) {
        ready = true; clearTimeout(timer); resolve();
      }
    });
    appserverProc!.stdout!.on('data', (chunk) => process.stderr.write(`[codex-app] ${chunk}`));
    appserverProc!.on('exit', (code, signal) => {
      if (!ready) {
        ready = true; clearTimeout(timer);
        reject(new Error(`codex app-server exited (code=${code}, signal=${signal}) before becoming ready`));
        return;
      }
      // post-ready exit: codex app-server crashed mid-flight. Daemon's WS will
      // also close immediately; further turn/start calls would silently fail.
      // Best recovery is for daemon to die so supervisor respawns it cleanly
      // with a fresh codex app-server. In-flight events in the local queue
      // are lost — acceptable for v1 (rare path); pending_pushes in hive
      // will hold any events that arrived AFTER daemon exit and re-deliver
      // when supervisor's new daemon binds.
      onAppserverDeath(`codex app-server exited (code=${code}, signal=${signal})`);
    });
    appserverProc!.on('error', (err) => {
      if (!ready) { ready = true; clearTimeout(timer); reject(err); return; }
      onAppserverDeath(`codex app-server process error: ${err?.message || err}`);
    });
  });

  // Even after the "listening" log line, give the WS endpoint a beat to accept.
  await new Promise(r => setTimeout(r, 200));

  // Open WS
  appserverWs = new (globalThis as any).WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => { cleanup(); resolve(); };
    const onErr = (e: any) => { cleanup(); reject(new Error(`WS open failed: ${e?.message || e?.type || 'unknown'}`)); };
    const cleanup = () => {
      appserverWs.removeEventListener('open', onOpen);
      appserverWs.removeEventListener('error', onErr);
    };
    appserverWs.addEventListener('open', onOpen);
    appserverWs.addEventListener('error', onErr);
    setTimeout(() => { if (appserverWs.readyState !== 1) { cleanup(); reject(new Error('WS open timeout')); } }, 5000);
  });

  appserverWs.addEventListener('message', (ev: any) => {
    let msg: any;
    try { msg = JSON.parse(String(ev.data)); } catch (err) {
      console.error('[codex-channel] WS parse error:', err);
      return;
    }
    // RPC response
    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = pendingResponses.get(msg.id);
      if (pending) {
        pendingResponses.delete(msg.id);
        if (msg.error) pending.reject(new Error(`codex rpc error: ${JSON.stringify(msg.error)}`));
        else pending.resolve(msg.result);
      }
      return;
    }
    // Server→client REQUEST (has both id and method): codex is waiting for
    // an answer and the turn is BLOCKED until one arrives. A headless daemon
    // that stays silent hangs the turn until our 10-min tracker timeout and
    // the event is lost (2026-07-15 incident: codex 0.144 routes approval
    // elicitations here; every push looked dead). Always answer.
    if (msg.id != null && msg.method) {
      handleServerRequest(msg);
      return;
    }
    // Notification — let the tracker route turn-related ones by turn id.
    // Unmatched notifications (item delta, agentMessage stream, etc.) are
    // ignored at this layer.
    if (msg.method && turnTracker?.handleNotification(msg.method, msg.params)) {
      return;
    }
  });

  appserverWs.addEventListener('close', () => {
    onAppserverDeath('appserver WS closed by remote (codex app-server likely exited)');
  });
  appserverWs.addEventListener('error', (e: any) => {
    onAppserverDeath(`appserver WS error: ${e?.message || e?.type || 'unknown'}`);
  });

  // 1. initialize
  await rpcCall('initialize', {
    clientInfo: { name: 'kitty-hive-codex-channel', version: '0.7.0' },
  });
  // initialized notification — fire and forget
  appserverWs.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }));

  // 2. thread/resume (if we have a persisted thread_id from a prior daemon
  //    lifetime) or thread/start (first-time spawn). Supervisor injects
  //    HIVE_AGENT_THREAD_ID after the first ready announcement, persisted in
  //    agents.thread_id; codex app-server loads the corresponding jsonl from
  //    ~/.codex/sessions/ so conversation history survives daemon kill /
  //    serve restart / machine reboot.
  const persistedThreadId = (process.env.HIVE_AGENT_THREAD_ID || '').trim();
  let resumed = false;
  if (persistedThreadId) {
    try {
      const resumeResp = await rpcCall(
        'thread/resume',
        buildThreadResumeParams(persistedThreadId, CODEX_APPSERVER_CWD),
        THREAD_RPC_TIMEOUT_MS,
      );
      const resumedId = resumeResp?.thread?.id;
      if (!resumedId) throw new Error(`thread/resume returned no thread.id: ${JSON.stringify(resumeResp)}`);
      threadId = resumedId;
      resumed = true;
      console.error(`[codex-channel] appserver thread resumed: ${threadId} (${resumeResp?.thread?.turns?.length ?? 0} turns)`);
    } catch (err) {
      // Common cause: jsonl missing (stale thread_id from a wiped ~/.codex)
      // or codex schema upgrade. Fall back to a fresh thread; the new
      // thread_id will overwrite the stale one in agents.thread_id via
      // markDaemonReady → setAgentThreadId, so this self-heals.
      console.error(`[codex-channel] thread/resume failed for ${persistedThreadId}, falling back to thread/start: ${err}`);
    }
  }
  if (!resumed) {
    const threadResp = await rpcCall('thread/start', { cwd: CODEX_APPSERVER_CWD }, THREAD_RPC_TIMEOUT_MS);
    threadId = threadResp?.thread?.id;
    if (!threadId) throw new Error(`thread/start did not return thread.id: ${JSON.stringify(threadResp)}`);
    console.error(`[codex-channel] appserver thread started: ${threadId}`);
  }
  appserverWsUrl = `ws://127.0.0.1:${port}`;

  // Bring up the TurnTracker now that we have a thread. RpcTransport is a
  // thin adapter over the local rpcCall — the tracker stays decoupled from
  // our WS plumbing so tests can swap in a stub transport.
  turnTracker = new TurnTracker(
    { call: (method, params, timeoutMs) => rpcCall(method, params, timeoutMs) },
    threadId!,
  );
  historyInjector = new HistoryItemInjector(
    { call: (method, params, timeoutMs) => rpcCall(method, params, timeoutMs) },
    threadId!,
  );

  // 2a. Start the control server (in-process thread switch entry point), then
  // announce ready — the announce carries control_url so the supervisor can
  // drive switches. Control-server failure is non-fatal: the daemon still
  // works, set-thread just falls back to the SIGTERM respawn path.
  await startControlServer().catch(err => {
    controlServer = null;
    controlUrl = null;
    console.error('[codex-channel] control server failed to start (set-thread falls back to respawn):', err);
  });

  // 2b. In foreground mode the brief itself must not start a model turn.
  // Persist it before ready is announced so an attached foreground cannot
  // race its first user turn ahead of the ownership policy.
  const briefText = resumed ? buildRebindText() : buildIntroText();
  const briefKind = resumed ? 'daemon-rebind' : 'daemon-intro';
  if (HIVE_EVENT_MODE === 'foreground') {
    const outcome = await injectHistory(briefText, { eventId: `${briefKind}:${threadId}:${Date.now()}` });
    if (outcome.kind === 'rpc_send_error') {
      throw new Error(`foreground brief injection failed: ${outcome.error.message}`);
    }
    console.error(`[codex-channel] foreground policy persisted without model turn (${briefKind})`);
  }

  // Announce ready signal back to hive supervisor so kitty-kitty (or any
  // other launcher) can query the (ws_url, thread_id) pair. Also persists
  // thread_id for next spawn.
  await announceReady().catch(err => {
    console.error('[codex-channel] failed to announce ready to supervisor:', err);
  });

  // Auto mode preserves the autonomous worker behavior: the startup brief is
  // a fire-and-forget model turn. Foreground mode already persisted the same
  // policy above and deliberately creates no turn.
  if (HIVE_EVENT_MODE === 'auto') {
    void sendTurn(briefText, { eventId: `${briefKind}:${threadId}:${Date.now()}` })
      .then((outcome) => {
        if (outcome.kind !== 'completed') {
          console.error(`[codex-channel] ${briefKind} turn outcome: ${outcome.kind} — daemon already proceeded`);
        }
      })
      .catch((err) => {
        console.error(`[codex-channel] ${briefKind} turn promise rejected:`, err);
      });
  }
}

/** Full agent brief injected into a brand-new thread (first spawn, or an
 *  in-process reset to a fresh thread). */
function buildIntroText(): string {
  if (HIVE_EVENT_MODE === 'foreground') {
    return [
      `You are kitty-hive agent "${agentName}" (id: ${agentId}).`,
      ``,
      `HIVE EVENT POLICY: foreground-only. The daemon may append pending Hive`,
      `event notices to this thread, but it must never start a model turn. A`,
      `notice is not a read receipt and must not be acted on by itself.`,
      ``,
      `When the next real user-authored foreground turn sees pending notices:`,
      `1. Call hive_start({ id: "${agentId}" }) if this MCP session is fresh.`,
      `2. Call hive_inbox() to obtain the authoritative CURRENT unread state.`,
      `3. Fetch and handle only items still returned by Hive. Ignore stale`,
      `   injected notices whose item is no longer unread.`,
      ``,
      `Only foreground user turns may call Hive read/action tools.`,
    ].join('\n');
  }
  return [
    `You are kitty-hive agent "${agentName}" (id: ${agentId}).`,
    ``,
    `You are running inside a persistent codex thread driven by the kitty-hive`,
    `codex-channel daemon. The daemon will inject one short message per hive`,
    `event into this thread; you handle the event and wait for the next.`,
    ``,
    `FIRST ACTION: call hive_start({ id: "${agentId}" }) to bind your MCP`,
    `session to your hive identity. This makes every hive_* tool call run`,
    `as you (not as a new agent). Do this BEFORE handling the first event.`,
    `NOTE: if you ever see a "[kitty-hive] daemon restarted" notice, call`,
    `hive_start again — the daemon process restarted and the MCP binding`,
    `was lost (but this thread's history was preserved).`,
    ``,
    `For each event:`,
    `- Push notifications are id-only by design — call the fetch tool the`,
    `  daemon points to (hive_dm_read / hive_check / hive_team_events /`,
    `  hive_team_info) BEFORE acting on the event content.`,
    `- Handle per type (DM, task-propose, step-start, awaiting_approval,`,
    `  team-message, ...) using the matching hive_* tools.`,
    `- task-assigned: do the work, then hive_task_complete({ task_id, result }).`,
    `  Only hive_workflow_propose when the task genuinely needs multiple`,
    `  steps/agents/review gates — it forces a creator-approval round-trip.`,
    `- When done, just stop. The next event will arrive as a new turn.`,
    ``,
    `Acknowledge readiness briefly, then wait for the first event.`,
  ].join('\n');
}

/** Short re-bind notice injected when an existing thread is (re)attached —
 *  daemon respawn resume, or in-process switch to a historical thread. The
 *  thread's history has the full brief already; it just needs to re-assert
 *  its hive identity in case the MCP session binding was lost. */
function buildRebindText(): string {
  if (HIVE_EVENT_MODE === 'foreground') {
    return [
      `[kitty-hive] daemon restarted in foreground-only event mode.`,
      `No background model turn was started and no Hive message was consumed.`,
      `The MCP session is fresh. On the next real user-authored foreground turn`,
      `that sees pending Hive notices, call hive_start({ id: "${agentId}" })`,
      `and then hive_inbox() to reconcile the CURRENT unread state.`,
    ].join('\n');
  }
  return [
    `[kitty-hive] daemon restarted — your MCP session is fresh.`,
    `Call hive_start({ id: "${agentId}" }) again to re-bind your hive identity`,
    `before handling the next event.`,
    `STALENESS WARNING: any turns completing around this restart may have been`,
    `stuck in-flight since long before it (each event carries a "received:"`,
    `timestamp — compare against the current time). For stale events, catch up`,
    `via hive_inbox and respond to the CURRENT state; do not reply to an old`,
    `message as if it just arrived. Then wait silently for the next push.`,
  ].join('\n');
}

// ===== In-process thread switch (control server) =====
// The supervisor drives clear-conversation / thread-pin via
// POST <controlUrl>/switch-thread { thread_id: string | "" } — the daemon
// swaps threads on the SAME codex app-server instead of dying for a full
// SIGTERM→respawn cycle (~9s incl. codex startup; in-process is ~1-2s).
// ws_url stays stable across switches, so an attached pane survives.
//
// Serialized with a promise chain: two concurrent switches would race
// threadId/turnTracker updates. The supervisor also serializes per-agent
// upstream, but the daemon defends itself regardless of caller discipline.

let switchChain: Promise<unknown> = Promise.resolve();

async function performThreadSwitch(target: string): Promise<{ ok: boolean; thread_id?: string; error?: string }> {
  if (pushMode !== 'appserver' || !appserverWs || appserverWs.readyState !== 1) {
    return { ok: false, error: 'daemon not in appserver mode (or WS not open)' };
  }
  try {
    if (target) {
      const resp = await rpcCall(
        'thread/resume',
        buildThreadResumeParams(target, CODEX_APPSERVER_CWD),
        THREAD_RPC_TIMEOUT_MS,
      );
      const resumedId = resp?.thread?.id;
      if (!resumedId) return { ok: false, error: `thread/resume returned no thread.id: ${JSON.stringify(resp)}` };
      threadId = resumedId;
      console.error(`[codex-channel] in-process switch: resumed thread ${threadId} (${resp?.thread?.turns?.length ?? 0} turns)`);
    } else {
      const resp = await rpcCall('thread/start', { cwd: CODEX_APPSERVER_CWD }, THREAD_RPC_TIMEOUT_MS);
      const newId = resp?.thread?.id;
      if (!newId) return { ok: false, error: `thread/start returned no thread.id: ${JSON.stringify(resp)}` };
      threadId = newId;
      console.error(`[codex-channel] in-process switch: started fresh thread ${threadId}`);
    }
    turnTracker?.setThreadId(threadId!);
    historyInjector?.setThreadId(threadId!);
    const briefText = target ? buildRebindText() : buildIntroText();
    const briefKind = target ? 'switch-rebind' : 'switch-intro';
    if (HIVE_EVENT_MODE === 'foreground') {
      const outcome = await injectHistory(briefText, { eventId: `${briefKind}:${threadId}:${Date.now()}` });
      if (outcome.kind === 'rpc_send_error') {
        return { ok: false, error: `foreground policy injection failed: ${outcome.error.message}` };
      }
    }
    // Re-announce only after the foreground policy is persisted, so the
    // supervisor snapshot cannot expose a thread that lacks the safety rule.
    await announceReady().catch(err => {
      console.error('[codex-channel] switch: failed to re-announce ready:', err);
    });
    if (HIVE_EVENT_MODE === 'auto') {
      void sendTurn(briefText, { eventId: `${briefKind}:${threadId}:${Date.now()}` })
        .then((outcome) => {
          if (outcome.kind !== 'completed') {
            console.error(`[codex-channel] ${briefKind} turn outcome: ${outcome.kind}`);
          }
        })
        .catch((err) => console.error(`[codex-channel] ${briefKind} turn promise rejected:`, err));
    }
    return { ok: true, thread_id: threadId! };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || err) };
  }
}

async function startControlServer(): Promise<void> {
  const port = await pickFreePort();
  controlServer = createHttpServer((req, res) => {
    // Loopback-only by bind address (127.0.0.1); no auth needed beyond that —
    // same trust model as the hive admin endpoints.
    if (req.method === 'POST' && req.url === '/switch-thread') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let target = '';
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
          if (!('thread_id' in body)) throw new Error('thread_id required (use "" or null to reset)');
          if (body.thread_id !== null && typeof body.thread_id !== 'string') throw new Error('thread_id must be string or null');
          target = (body.thread_id ?? '').trim();
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
          return;
        }
        const run = switchChain.catch(() => undefined).then(() => performThreadSwitch(target));
        switchChain = run;
        run.then((result) => {
          res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        }).catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
        });
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'unknown control endpoint' }));
  });
  await new Promise<void>((resolve, reject) => {
    controlServer!.on('error', reject);
    controlServer!.listen(port, '127.0.0.1', () => resolve());
  });
  controlUrl = `http://127.0.0.1:${port}`;
  console.error(`[codex-channel] control server listening at ${controlUrl}`);
}

/** Tell the hive supervisor (the parent process that spawned us) that we have
 *  a live ws + thread, so it can answer hive_codex_pane_ws / show in admin
 *  snapshots. HIVE_URL is the supervisor's MCP base url (set explicitly by
 *  codex-supervisor when it spawns us); derive admin URL from it. */
async function announceReady(): Promise<void> {
  if (!agentId || !appserverWsUrl || !threadId) return;
  const adminUrl = ENV_URL.replace(/\/mcp\/?$/, '') + '/admin/codex-daemon-ready';
  const res = await fetch(adminUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: agentId,
      ws_url: appserverWsUrl,
      thread_id: threadId,
      control_url: controlUrl,
    }),
  });
  if (!res.ok) {
    throw new Error(`POST ${adminUrl} → ${res.status} ${await res.text().catch(() => '')}`);
  }
  console.error(`[codex-channel] announced ready: ws=${appserverWsUrl} thread=${threadId.slice(0, 8)}...`);
}

/** Answer a server→client JSON-RPC request from codex app-server. The
 *  decision policy lives in codex-channel-runtime's answerServerRequest()
 *  (pure, unit-tested); this wrapper just logs and sends. */
function handleServerRequest(msg: { id: number; method: string; params?: any }): void {
  const answer = answerServerRequest(msg.method, msg.params, (turnId) => turnTracker?.isActiveTurn(turnId) ?? false);
  const p = msg.params ?? {};
  const detail = (p.message || p.reason || p.command || '').toString().slice(0, 120);
  if (answer.kind === 'ignore') {
    // A human pane attached to this app-server owns the turn — their TUI
    // shows the dialog; the daemon answering would hijack it (2026-07-16
    // monkeys-cli incident: every shell approval auto-declined under the
    // user's cursor).
    console.error(`[codex-channel] ignoring server request ${msg.method} (${answer.reason}): ${detail}`);
    return;
  }
  if (answer.kind === 'result') {
    const verb = JSON.stringify(answer.payload).includes('"accept"') ? 'auto-accepting' : 'declining';
    console.error(`[codex-channel] ${verb} server request ${msg.method}${p.serverName ? ` (server=${p.serverName})` : ''}: ${detail}`);
  } else {
    console.error(`[codex-channel] unknown server request "${msg.method}" on OUR turn — answering method-not-found to avoid hanging it`);
  }
  try {
    const frame = answer.kind === 'result'
      ? { jsonrpc: '2.0', id: msg.id, result: answer.payload }
      : { jsonrpc: '2.0', id: msg.id, error: answer.payload };
    appserverWs?.send(JSON.stringify(frame));
  } catch (err) {
    console.error(`[codex-channel] failed to answer server request ${msg.method}:`, err);
  }
}

async function rpcCall(method: string, params: any, timeoutMs = 30000): Promise<any> {
  if (!appserverWs || appserverWs.readyState !== 1) throw new Error('appserver WS not open');
  const id = nextRpcId++;
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => {
    pendingResponses.set(id, { resolve, reject });
    appserverWs.send(payload);
    setTimeout(() => {
      if (pendingResponses.has(id)) {
        pendingResponses.delete(id);
        reject(new Error(`codex appserver rpc '${method}' timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });
}

/** Inject one hive event as a turn into the codex thread. Returns the
 *  terminal outcome — caller branches on `outcome.kind` rather than catching.
 *  See codex-channel-runtime.ts for the design rationale (2026-05-26 incident
 *  notes). The eventId is used for cross-attempt idempotency: once an event
 *  has been handed to the tracker, the tracker refuses to re-issue
 *  `turn/start` for the same id, no matter what kind of failure intervened.
 *  This is the core defense against duplicate-turn injection. */
async function sendTurn(text: string, opts: { eventId?: string } = {}): Promise<TurnOutcome> {
  if (!turnTracker) throw new Error('turnTracker not initialized — did setupAppserver run?');
  return turnTracker.sendTurn(text, opts);
}

async function injectHistory(text: string, opts: { eventId?: string } = {}) {
  if (!historyInjector) throw new Error('HistoryItemInjector not initialized — did setupAppserver run?');
  return historyInjector.injectDeveloperText(text, opts);
}

/** Short prompt for appserver mode — context is persistent, so each event is
 *  just "here's what arrived + how to fetch full content". */
function buildEventTurnText(ev: ParsedEvent): string {
  const senderLabel = ev.from || ev.from_agent_id || 'unknown';
  const summary = ev.title || ev.preview || ev.raw || `(no summary)`;
  let fetchHint: string;
  if (ev.type === 'message' && ev.message_id != null) {
    fetchHint = `hive_dm_read({ message_id: ${ev.message_id} })`;
  } else if (ev.task_id) {
    fetchHint = `hive_check({ task_id: "${ev.task_id}" })`;
  } else if (ev.team_id) {
    fetchHint = ev.type === 'team-rules-update'
      ? `hive_team_info({ team_id: "${ev.team_id}" })  # rules updated; refresh`
      : `hive_team_events({ team_id: "${ev.team_id}" })`;
  } else {
    fetchHint = `hive_inbox()`;
  }
  return [
    `[hive event] type=${ev.type} from=${senderLabel}`,
    `summary: ${summary}`,
    `fetch:   ${fetchHint}`,
    // received: arrival time at THIS daemon. If you are reading this long
    // after that time (thread resumed with a backlog, turn was stuck), treat
    // the event as stale — do not reply as if it just happened.
    ...buildEventTimingLines(ev),
  ].join('\n');
}

/** Model-visible notification for foreground mode. It is history only: the
 *  app-server does not start inference, and Hive remains unread. The next
 *  real user turn reconciles against hive_inbox instead of trusting a stale
 *  notification captured earlier. */
function buildPendingEventHistoryText(ev: ParsedEvent): string {
  const senderLabel = ev.from || ev.from_agent_id || 'unknown';
  const summary = ev.title || ev.preview || ev.raw || `(no summary)`;
  return [
    `[kitty-hive pending event — foreground-only]`,
    `type: ${ev.type || 'unknown'}`,
    `from: ${senderLabel}`,
    `summary: ${summary}`,
    `event_id: ${eventDedupKey(ev)}`,
    ...buildEventTimingLines(ev),
    ``,
    `This notice was persisted without starting a model turn. It is not a`,
    `read receipt and Hive read cursors were not advanced. On the next real`,
    `user-authored foreground turn, call hive_start({ id: "${agentId}" }) if`,
    `needed, then hive_inbox() for the authoritative CURRENT unread state.`,
    `Fetch/handle only items still returned there; ignore stale notices.`,
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

/** Build a stable dedup key from a parsed event. Used as TurnTracker's
 *  eventId so even a retry/replay of the same logical hive event never
 *  produces a second `turn/start` on codex's side. Falls back to a content
 *  hash when nothing else is available. */
function eventDedupKey(ev: ParsedEvent): string {
  if (ev.event_id) return `evid:${ev.event_id}`;
  if (ev.message_id != null) return `dm:${ev.message_id}`;
  if (ev.task_id) return `task:${ev.task_id}:${ev.type || 'unknown'}`;
  if (ev.team_id) return `team:${ev.team_id}:${ev.type || 'unknown'}`;
  // Last resort — should be rare; hash content + sender so unrelated events
  // don't collide.
  return `raw:${ev.from_agent_id || 'unknown'}:${ev.type || 'unknown'}:${(ev.raw || ev.preview || '').slice(0, 80)}`;
}

async function shouldInjectQueuedEvent(ev: ParsedEvent): Promise<boolean> {
  if (!agentId) return true;
  const decision = await checkEventDeliveryBeforeInject(
    PUSH_DELIVERY_STATUS_URL,
    agentId,
    {
      event_id: ev.event_id,
      message_id: ev.message_id,
      task_id: ev.task_id,
      team_id: ev.team_id,
    },
  );
  if (!decision.deliver) {
    console.error(`[codex-channel] skipped stale/consumed event eventId=${eventDedupKey(ev)} reason=${decision.reason} seq=${decision.seq ?? decision.message_id ?? 'n/a'} cursor=${decision.cursor ?? 'n/a'} latest=${decision.latest_seq ?? 'n/a'}`);
    return false;
  }
  if (decision.reason === 'preflight_error') {
    console.error(`[codex-channel] event delivery preflight failed for eventId=${eventDedupKey(ev)}; fail-open inject: ${decision.error}`);
  }
  return true;
}

async function processNextEvent() {
  if (codexBusy) return;
  const next = eventQueue.shift();
  if (!next) return;
  codexBusy = true;
  try {
    const shouldInject = await shouldInjectQueuedEvent(next);
    const deliveryPath = decideEventDelivery(HIVE_EVENT_MODE, pushMode);
    if (!shouldInject) {
      // Consumed through hive_inbox / hive_dm_read while this push waited in
      // eventQueue. Do not start a duplicate Codex turn.
    } else if (deliveryPath !== 'background_turn') {
      if (deliveryPath === 'foreground_unavailable') {
        console.error(`[codex-channel] foreground event left unread: appserver unavailable (type=${next.type}, eventId=${eventDedupKey(next)})`);
      } else {
        const eventId = eventDedupKey(next);
        const text = buildPendingEventHistoryText(next);
        const outcome = await injectHistory(text, { eventId });
        if (outcome.kind === 'injected') {
          console.error(`[codex-channel] foreground event persisted without model turn (eventId=${eventId})`);
        } else if (outcome.kind === 'skipped_duplicate') {
          console.error(`[codex-channel] skipped duplicate foreground history item (eventId=${eventId})`);
        } else {
          console.error(`[codex-channel] foreground history injection failed; Hive remains unread (eventId=${eventId}): ${outcome.error.message}`);
        }
      }
    } else if (pushMode === 'appserver') {
      const text = buildEventTurnText(next);
      const eventId = eventDedupKey(next);
      console.error(`[codex-channel] inject turn (${text.length} chars) eventId=${eventId} into thread ${threadId?.slice(-8)}`);
      const outcome = await sendTurn(text, { eventId });
      // TurnOutcome is a closed union — each kind reflects a known terminal
      // state observed at codex's side. We DON'T retry locally on any of
      // these: re-issuing turn/start was the exact cause of the 2026-05-26
      // duplicate-turn incident. Loss recovery (if any is warranted) lives
      // a layer up: hive's pending_pushes / SSE replay across daemon
      // respawn delivers missed events again.
      switch (outcome.kind) {
        case 'completed':
          // Normal path. Nothing more to do.
          break;
        case 'failed':
          console.error(`[codex-channel] turn failed on codex (turnId=${outcome.turnId} willRetry=${outcome.willRetry}): ${JSON.stringify(outcome.error)}`);
          break;
        case 'interrupted':
          console.error(`[codex-channel] turn interrupted on codex (turnId=${outcome.turnId}) — event consumed`);
          break;
        case 'timeout':
          console.error(`[codex-channel] turn did not complete within ${outcome.afterMs}ms (turnId=${outcome.turnId}); leaving turn in-flight on codex, NOT retrying to avoid duplicate inject`);
          break;
        case 'rpc_send_error':
          console.error(`[codex-channel] turn/start RPC error (event eventId=${eventId}): ${outcome.error.message}`);
          if (!appserverWs || appserverWs.readyState !== 1) {
            console.error('[codex-channel] appserver WS appears dead; switching subsequent events to exec mode (daemon will exit shortly anyway)');
            pushMode = 'exec';
          }
          break;
        case 'skipped_duplicate':
          // Should only fire if the same eventId is enqueued twice in this
          // daemon lifetime — e.g. SSE drain replay after a brief disconnect.
          // Expected behavior; log at info to make it visible without alarm.
          console.error(`[codex-channel] skipped already-injected event (eventId=${outcome.eventId})`);
          break;
      }
    } else {
      await spawnCodex(buildPrompt(next));
    }
  } catch (err) {
    // Anything that throws now is genuinely unexpected (sendTurn no longer
    // throws — it returns TurnOutcome). Log loudly and move on; do not
    // re-queue, to preserve the no-duplicate guarantee.
    console.error('[codex-channel] unexpected processing error (event dropped to preserve no-duplicate guarantee):', err);
    console.error(`[codex-channel] dropped event: ${JSON.stringify({
      type: next.type, event_id: next.event_id, task_id: next.task_id,
      message_id: next.message_id, from: next.from || next.from_agent_id,
    })}`);
  } finally {
    codexBusy = false;
  }
  // Drain any events that piled up while codex was busy
  if (eventQueue.length > 0) setImmediate(processNextEvent);
}

function enqueue(ev: ParsedEvent) {
  ev.received_at ||= new Date().toISOString();
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

async function setupPushMode() {
  if (CODEX_CHANNEL_MODE === 'exec') {
    if (HIVE_EVENT_MODE === 'foreground') {
      throw new Error('foreground event mode requires codex app-server; legacy exec mode starts background model turns');
    }
    pushMode = 'exec';
    console.error(`[codex-channel] mode: exec (per-event codex spawn; forced via CODEX_CHANNEL_MODE=exec)`);
    return;
  }
  // 'auto' or 'appserver': try appserver
  try {
    await setupAppserver();
    pushMode = 'appserver';
    console.error(`[codex-channel] mode: appserver (long-lived codex thread; context persists across events)`);
  } catch (err) {
    if (CODEX_CHANNEL_MODE === 'appserver' || HIVE_EVENT_MODE === 'foreground') {
      console.error(`[codex-channel] appserver is required but setup failed: ${err}`);
      cleanupAppserver();
      throw err;
    }
    console.error(`[codex-channel] appserver setup failed, falling back to exec mode: ${err}`);
    cleanupAppserver();
    pushMode = 'exec';
  }
}

function cleanupAppserver() {
  if (controlServer) {
    try { controlServer.close(); } catch { /* ignore */ }
    controlServer = null;
    controlUrl = null;
  }
  if (appserverWs) {
    try { appserverWs.close(); } catch { /* ignore */ }
    appserverWs = null;
  }
  if (appserverProc?.pid) {
    // Kill the WHOLE process group (negative pid). Because we spawned with
    // `detached: true`, appserverProc.pid is also the group leader id; the
    // grandchild codex binary the wrapper exec'd is in the same group and
    // will receive SIGTERM too. Without this, the wrapper dies but the
    // grandchild codex binary stays alive holding the ws port.
    try { process.kill(-appserverProc.pid, 'SIGTERM'); } catch { /* ignore */ }
    // Fallback: also SIGTERM the wrapper itself in case kill -group missed.
    try { appserverProc.kill('SIGTERM'); } catch { /* ignore */ }
    appserverProc = null;
  }
  turnTracker = null;
  historyInjector = null;
  threadId = null;
}

function shutdown(reason: NodeJS.Signals | 'supervisor-exit') {
  // Mark intentional shutdown BEFORE killing children — otherwise
  // appserverProc.kill() triggers our death handler thinking app-server
  // crashed, racing process.exit(0) with process.exit(2).
  appserverDeathHandled = true;
  if (supervisorWatchdog) {
    clearInterval(supervisorWatchdog);
    supervisorWatchdog = null;
  }
  console.error(`[codex-channel] received ${reason}, shutting down...`);
  cleanupAppserver();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function startSupervisorWatchdog(): void {
  if (!HIVE_SUPERVISOR_PID) return;
  const checkSupervisor = () => {
    if (!supervisorProcessIsMissing(HIVE_SUPERVISOR_PID)) return;
    console.error(`[codex-channel] supervisor pid ${HIVE_SUPERVISOR_PID} is gone; cleaning up daemon process tree`);
    shutdown('supervisor-exit');
  };
  checkSupervisor();
  supervisorWatchdog = setInterval(checkSupervisor, 2000);
  supervisorWatchdog.unref();
}

async function main() {
  startSupervisorWatchdog();
  preflight();
  // 1. register on hive
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
  // 2. set up codex push mode (appserver preferred, exec fallback)
  await setupPushMode();
  // 3. subscribe to hive SSE
  await listenSSE();
}

main().catch((err) => {
  console.error('[codex-channel] fatal:', err);
  cleanupAppserver();
  process.exit(1);
});
