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

import { spawn, type ChildProcess } from 'node:child_process';
import { execSync } from 'node:child_process';
import { createServer } from 'node:net';

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
  // Internal: count of processNextEvent retries already attempted for this
  // event. Capped at MAX_EVENT_RETRIES below — without the cap, a single
  // failing event (e.g. codex thread stuck so `turn/start` never reaches
  // turn/completed → 10-min timeout → unshift) keeps re-injecting the same
  // logical event forever. Real incident 2026-05-21: one daemon spammed
  // an agent with ~48 copies of the same step-start over 8 hours.
  _retries?: number;
}

// After this many failed processing attempts, drop the event and log loudly.
// 3 retries × the natural delay between failures (typically the sendTurn
// timeout of 600s) ≈ 30 minutes total before we give up — long enough to
// ride out a transient codex hiccup, short enough that a stuck event won't
// flood the agent's thread.
const MAX_EVENT_RETRIES = 3;

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

// ===== Appserver mode (codex ≥ 0.124) =====
// Long-lived codex via `codex app-server --listen ws://127.0.0.1:<port>`.
// One JSON-RPC WebSocket connection, one persistent thread, one turn per
// hive event injected via turn/start. Thread context survives across events
// — no codex startup overhead, no fresh-context loss.

let pushMode: 'appserver' | 'exec' | null = null;
let appserverProc: ChildProcess | null = null;
let appserverWs: any /* WebSocket */ = null;
let appserverWsUrl: string | null = null;  // ws://127.0.0.1:<port> — for outside callers via supervisor
let threadId: string | null = null;
let appserverDeathHandled = false;  // guard so multiple death signals only exit once

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
  try { appserverWs?.close(); } catch { /* ignore */ }
  try { appserverProc?.kill('SIGTERM'); } catch { /* ignore */ }
  // exit code 2 distinguishes "app-server crash" from "clean shutdown via SIGTERM"
  process.exit(2);
}
let nextRpcId = 100;
const pendingResponses = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();
const turnCompleteWaiters: Array<() => void> = [];

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
  appserverProc = spawn(CODEX_CMD, ['app-server', '--listen', `ws://127.0.0.1:${port}`], {
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
    // Notification
    if (msg.method === 'turn/completed' || msg.method === 'turn/interrupt') {
      const w = turnCompleteWaiters.shift();
      if (w) w();
    }
    // Optional: tap into item/agentMessage/delta etc. for live progress — skipped.
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

  // 2. thread/start (new thread per daemon lifetime — keep it simple)
  const threadResp = await rpcCall('thread/start', { cwd: CODEX_APPSERVER_CWD });
  threadId = threadResp?.thread?.id;
  if (!threadId) throw new Error(`thread/start did not return thread.id: ${JSON.stringify(threadResp)}`);
  appserverWsUrl = `ws://127.0.0.1:${port}`;
  console.error(`[codex-channel] appserver thread started: ${threadId}`);

  // 2a. Announce ready signal back to hive supervisor so kitty-kitty (or any
  // other launcher) can query the (ws_url, thread_id) pair via
  // hive_codex_pane_ws / GET /admin/codex-daemons. Best-effort: failure here
  // just means the daemon's pane info isn't immediately discoverable; daemon
  // still processes pushes normally.
  await announceReady().catch(err => {
    console.error('[codex-channel] failed to announce ready to supervisor:', err);
  });

  // 3. intro turn — establishes hive identity in the persistent thread.
  // Subsequent per-event turns are short because context persists.
  const intro = [
    `You are kitty-hive agent "${agentName}" (id: ${agentId}).`,
    ``,
    `You are running inside a persistent codex thread driven by the kitty-hive`,
    `codex-channel daemon. The daemon will inject one short message per hive`,
    `event into this thread; you handle the event and wait for the next.`,
    ``,
    `FIRST ACTION: call hive_start({ id: "${agentId}" }) to bind your MCP`,
    `session to your hive identity. This makes every hive_* tool call run`,
    `as you (not as a new agent). Do this BEFORE handling the first event.`,
    ``,
    `For each event:`,
    `- Push notifications are id-only by design — call the fetch tool the`,
    `  daemon points to (hive_dm_read / hive_check / hive_team_events /`,
    `  hive_team_info) BEFORE acting on the event content.`,
    `- Handle per type (DM, task-propose, step-start, awaiting_approval,`,
    `  team-message, ...) using the matching hive_* tools.`,
    `- When done, just stop. The next event will arrive as a new turn.`,
    ``,
    `Acknowledge readiness briefly, then wait for the first event.`,
  ].join('\n');
  await sendTurn(intro);
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
    }),
  });
  if (!res.ok) {
    throw new Error(`POST ${adminUrl} → ${res.status} ${await res.text().catch(() => '')}`);
  }
  console.error(`[codex-channel] announced ready: ws=${appserverWsUrl} thread=${threadId.slice(0, 8)}...`);
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

async function sendTurn(text: string, turnTimeoutMs = 600000 /* 10 min */): Promise<void> {
  const turnDone = new Promise<void>((resolve) => { turnCompleteWaiters.push(resolve); });
  await rpcCall('turn/start', {
    threadId,
    input: [{ type: 'text', text }],
  });
  await Promise.race([
    turnDone,
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`turn did not complete within ${turnTimeoutMs}ms`)), turnTimeoutMs)),
  ]);
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
    if (pushMode === 'appserver') {
      const text = buildEventTurnText(next);
      console.error(`[codex-channel] inject turn (${text.length} chars) into thread ${threadId?.slice(-8)}`);
      await sendTurn(text);
    } else {
      await spawnCodex(buildPrompt(next));
    }
  } catch (err) {
    const attempts = (next._retries || 0) + 1;
    next._retries = attempts;
    console.error(`[codex-channel] event processing failed (attempt ${attempts}/${MAX_EVENT_RETRIES}):`, err);
    // If appserver died, fall back to exec for subsequent events
    if (pushMode === 'appserver' && (!appserverWs || appserverWs.readyState !== 1)) {
      console.error('[codex-channel] appserver appears dead; switching remaining events to exec mode');
      pushMode = 'exec';
    }
    if (attempts < MAX_EVENT_RETRIES) {
      // Re-queue at head so order is preserved across the retry. Use a
      // backoff timer (5s, 15s, 45s …) instead of setImmediate so a
      // persistent failure mode (e.g. codex thread permanently wedged)
      // doesn't tight-loop on the same event before sendTurn's own 10-min
      // timeout fires. Without backoff, even a 600s timeout still produces
      // hundreds of retries over a day.
      eventQueue.unshift(next);
      const backoffMs = Math.min(60_000, 5_000 * Math.pow(3, attempts - 1));
      console.error(`[codex-channel] will retry in ${backoffMs}ms`);
      codexBusy = false;
      setTimeout(() => { if (!codexBusy) processNextEvent(); }, backoffMs);
      return;
    }
    // Out of retries — drop the event so the queue can move on. Logged at
    // ERROR level so the operator can investigate (and so codex thread
    // history shows the gap if any inspection is done later).
    console.error(`[codex-channel] DROPPING event after ${MAX_EVENT_RETRIES} failed attempts: ${JSON.stringify({
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
    if (CODEX_CHANNEL_MODE === 'appserver') {
      console.error(`[codex-channel] appserver mode forced but setup failed: ${err}`);
      cleanupAppserver();
      process.exit(1);
    }
    console.error(`[codex-channel] appserver setup failed, falling back to exec mode: ${err}`);
    cleanupAppserver();
    pushMode = 'exec';
  }
}

function cleanupAppserver() {
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
  threadId = null;
}

function shutdown(signal: NodeJS.Signals) {
  // Mark intentional shutdown BEFORE killing children — otherwise
  // appserverProc.kill() triggers our death handler thinking app-server
  // crashed, racing process.exit(0) with process.exit(2).
  appserverDeathHandled = true;
  console.error(`[codex-channel] received ${signal}, shutting down...`);
  cleanupAppserver();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function main() {
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
