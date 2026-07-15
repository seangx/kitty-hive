/**
 * Codex daemon supervisor.
 *
 * On hive serve boot, spawns one codex-channel daemon child per local agent
 * registered with `tool='codex'`. Daemons get push delivery via WebSocket to
 * a codex app-server they manage; the supervisor just keeps them alive.
 *
 * Design choices (settled with the user, 2026-05-20):
 *   - DB is the single source of truth: `WHERE tool='codex' AND origin_peer=''`
 *     decides what gets spawned. No separate config list, no opt-in flag —
 *     same UX as Claude plugin (install once, just works).
 *   - Restart with exponential backoff (1s → 2s → 4s → ... → cap 60s).
 *   - On serve SIGTERM, supervisor kills all children with SIGTERM and waits.
 *   - Daemon stderr/stdout are tee'd into serve's own stderr with an
 *     `[codex:<display_name>]` prefix.
 *
 * Thread persistence (v0.7.0):
 *   - daemon's codex thread_id is stored on agents.thread_id after first ready.
 *   - On respawn, supervisor injects HIVE_AGENT_THREAD_ID so daemon calls
 *     `thread/resume` (against the jsonl codex app-server already wrote to
 *     ~/.codex/sessions/) instead of `thread/start`. Conversation survives
 *     daemon kill / serve restart / machine reboot.
 *
 * Out of scope (deferred):
 *   - Hot reload on DB changes (poll / watch). Add/remove agents → must
 *     restart serve to pick up. Acceptable for now since codex agents are
 *     long-lived once configured.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { log } from './log.js';
import { listLocalCodexAgents, getAgentById, onAgentCreated, setAgentThreadId } from './db.js';
import type { Agent } from './models.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface DaemonInfo {
  agentId: string;
  displayName: string;
  child: ChildProcess;
  pid: number;
  startedAt: Date;
  restartCount: number;
  // Populated when the spawned codex-channel daemon POSTs to
  // /admin/codex-daemon-ready after its codex app-server is up and the
  // thread is created. null while the daemon is still booting.
  wsUrl: string | null;
  threadId: string | null;
  readyAt: Date | null;
  // Daemon's local control-server base URL (http://127.0.0.1:<port>), used
  // for in-process thread switches. null when the daemon predates the
  // control server or it failed to start — switch falls back to respawn.
  controlUrl: string | null;
  // Set by requestDaemonRespawn (i.e. /admin/codex-set-thread or any other
  // operator-triggered restart) BEFORE the SIGTERM. The exit handler reads
  // this to decide the respawn cadence: intentional restart → immediate
  // respawn + restartCount reset to 0; unintentional crash → exponential
  // backoff (up to 60s cap) tied to accumulated restartCount.
  //
  // The 2026-07-12 my-game incident (restart_count=89, kitty called
  // set-thread on every session restart) revealed the bug: intentional
  // respawns were sharing the crash-loop backoff table, so once the
  // counter climbed past ~6 attempts every subsequent set-thread waited
  // 60s to spawn — well past kitty's 10s ws-poll timeout. Kitty saw the
  // daemon as "never ready" even though supervisor was faithfully
  // respawning it, just slowly.
  intentionalShutdown?: boolean;
  // Handle for the "healthy for 30s → clear crash counter" timer scheduled
  // by markDaemonReady. Cleared on daemon exit so we don't leak a
  // reference to a dead DaemonInfo. See markDaemonReady() below.
  healthTimer?: NodeJS.Timeout;
}

const daemons = new Map<string, DaemonInfo>();
let shuttingDown = false;
let supervisorPort = 4123;  // set by startCodexSupervisor

function findNpx(): string {
  const probe = process.platform === 'win32' ? 'where npx' : 'command -v npx';
  try {
    const out = execSync(probe, { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
    return out || 'npx';
  } catch { return 'npx'; }
}

function locateCodexChannelScript(): string {
  // dist/codex-supervisor.js → ../codex-channel.ts (package root)
  const p = join(__dirname, '..', 'codex-channel.ts');
  if (existsSync(p)) return p;
  // Fallback if running from src/ directly via tsx (dev)
  const dev = join(__dirname, '..', '..', 'codex-channel.ts');
  if (existsSync(dev)) return dev;
  throw new Error(`cannot locate codex-channel.ts (tried ${p})`);
}

function spawnDaemon(agentId: string, displayName: string, restartCount = 0): void {
  if (shuttingDown) return;
  if (daemons.has(agentId)) return; // already running

  // Re-check eligibility at spawn time, not just at scheduling time. A crash
  // backoff setTimeout can be pending for up to 60s; if the agent's tool was
  // switched away from codex in that window (claude⇄codex morph via
  // `agent register --switch-tool`), the deferred spawn must not fire.
  const eligible = getAgentById(agentId);
  if (!eligible || eligible.tool !== 'codex' || eligible.origin_peer !== '') {
    log('info', `[codex-supervisor] skip spawn for "${displayName}" (${agentId.slice(-12)}): agent deleted / tool changed / now remote`);
    return;
  }

  let scriptPath: string;
  try {
    scriptPath = locateCodexChannelScript();
  } catch (err) {
    log('warn', `[codex-supervisor] ${err}`);
    return;
  }

  log('info', `[codex-supervisor] spawning daemon for "${displayName}" (${agentId.slice(-12)}) restart=${restartCount}`);

  // CRITICAL: scrub inherited HIVE_* env vars from the operator's shell.
  // Without this, if `kitty-hive serve` was launched from a shell with
  // HIVE_AGENT_KEY set (e.g. for a Claude session bound to a different
  // agent), the daemon would carry that key over, and codex-channel.ts's
  // hive_start() would `key`-match to the operator's agent — silently
  // taking it over (display_name + tool overwritten). Real incident on
  // 2026-05-20: smoke test renamed `kitty-hive` to `test-codex-1` because
  // the operator shell had HIVE_AGENT_KEY=<kitty-hive's external_key>.
  //
  // Daemon gets a minimal env: system basics (PATH, HOME, etc.) + EXACTLY
  // the hive identity overrides we want.
  const cleanEnv: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('HIVE_')) continue;  // drop any HIVE_* inherited from operator shell
    cleanEnv[k] = v;
  }
  cleanEnv.HIVE_AGENT_ID = agentId;
  cleanEnv.HIVE_AGENT_NAME = displayName;
  // HIVE_URL: explicitly set so daemon talks to *this* serve (whose port the
  // supervisor knows), not whatever was in the operator shell or the daemon's
  // own fallback default.
  cleanEnv.HIVE_URL = `http://127.0.0.1:${supervisorPort}/mcp`;
  // CODEX_APPSERVER_CWD: codex-channel.ts reads this and passes to thread/start
  // as cwd. Determines where the codex agent thinks it's running — must match
  // the operator's intent (the project the kitty pane was launched for), not
  // the cwd hive serve happens to be running from. agent.project_dir is
  // operator-set via `agent register --project-dir`; empty falls back to
  // serve's own cwd.
  const fresh = getAgentById(agentId);
  if (fresh?.project_dir) cleanEnv.CODEX_APPSERVER_CWD = fresh.project_dir;
  // HIVE_AGENT_THREAD_ID: presence tells codex-channel to `thread/resume` an
  // existing codex thread (jsonl already on disk in ~/.codex/sessions/)
  // instead of `thread/start`. Set on every spawn after the first ready
  // (markDaemonReady persists it to agents.thread_id). On a respawn after
  // resume failure, codex-channel announces a brand-new thread_id and
  // markDaemonReady overwrites — old jsonl is orphaned but content survives
  // on disk.
  if (fresh?.thread_id) cleanEnv.HIVE_AGENT_THREAD_ID = fresh.thread_id;

  const child = spawn(findNpx(), ['-y', 'tsx', scriptPath], {
    env: cleanEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (!child.pid) {
    log('warn', `[codex-supervisor] failed to spawn daemon for ${displayName}: no pid`);
    return;
  }

  const info: DaemonInfo = {
    agentId, displayName, child, pid: child.pid,
    startedAt: new Date(), restartCount,
    wsUrl: null, threadId: null, readyAt: null, controlUrl: null,
  };
  daemons.set(agentId, info);

  // Tee daemon output into serve's stderr with a label so user can see what
  // each daemon is doing without separate log files. We forward both stdout
  // and stderr to stderr (stdout would interleave with the http log lines).
  const prefix = `[codex:${displayName}]`;
  child.stdout?.on('data', (chunk) => process.stderr.write(`${prefix} ${chunk}`));
  child.stderr?.on('data', (chunk) => process.stderr.write(`${prefix} ${chunk}`));

  child.on('exit', (code, signal) => {
    const wasIntentional = info.intentionalShutdown === true;
    // Cancel any pending health-timer — the DaemonInfo is about to be
    // deleted and we don't want the timer firing against a stale ref.
    if (info.healthTimer) clearTimeout(info.healthTimer);
    daemons.delete(agentId);
    log('info', `[codex-supervisor] daemon "${displayName}" exited (code=${code}, signal=${signal}, intentional=${wasIntentional})`);
    if (shuttingDown) return;

    // Refresh agent record — it may have been removed or modified
    const fresh = getAgentById(agentId);
    if (!fresh || fresh.tool !== 'codex' || fresh.origin_peer !== '') {
      log('info', `[codex-supervisor] daemon "${displayName}" no longer eligible for spawn (deleted / tool changed / now remote); not restarting`);
      return;
    }

    // Intentional restart (requestDaemonRespawn / operator SIGTERM):
    // immediate respawn AND clear restartCount. The counter is a
    // "unwanted crash frequency" signal — a user-driven restart is not
    // a crash and shouldn't have inflated the backoff table anyway.
    // Unintentional exit: exponential backoff 1s, 2s, 4s, 8s ... cap 60s
    const delayMs = wasIntentional ? 0 : Math.min(60000, 1000 * Math.pow(2, restartCount));
    const nextRestartCount = wasIntentional ? 0 : restartCount + 1;
    if (wasIntentional) {
      log('info', `[codex-supervisor] respawning "${fresh.display_name}" immediately (intentional restart, counter reset)`);
    } else {
      log('warn', `[codex-supervisor] restarting "${fresh.display_name}" in ${delayMs}ms (attempt ${nextRestartCount})`);
    }
    setTimeout(() => {
      spawnDaemon(fresh.id, fresh.display_name, nextRestartCount);
    }, delayMs);
  });

  child.on('error', (err) => {
    log('warn', `[codex-supervisor] daemon "${displayName}" process error: ${err}`);
  });
}

export function startCodexSupervisor(port: number = 4123): void {
  supervisorPort = port;
  const agents = listLocalCodexAgents();
  if (agents.length === 0) {
    log('info', '[codex-supervisor] no local tool=codex agents — nothing to spawn at boot');
  } else {
    log('info', `[codex-supervisor] starting ${agents.length} codex daemon(s): ${agents.map(a => a.display_name).join(', ')}`);
    for (const agent of agents) {
      spawnDaemon(agent.id, agent.display_name, 0);
    }
  }

  // Dynamic spawn: kitty / any other launcher may register a NEW codex agent
  // while serve is running. Listen for agent-create events and spawn a daemon
  // on the fly so the launcher doesn't have to restart serve. Subscribe AFTER
  // initial boot scan so we don't double-spawn the already-spawned set above.
  onAgentCreated((agent: Agent) => {
    if (agent.tool !== 'codex' || agent.origin_peer !== '') return;
    if (daemons.has(agent.id)) return; // already spawning
    log('info', `[codex-supervisor] new local tool=codex agent registered: "${agent.display_name}" (${agent.id.slice(-12)}) → spawning daemon`);
    spawnDaemon(agent.id, agent.display_name, 0);
  });
}

export function stopCodexSupervisor(): Promise<void> {
  shuttingDown = true;
  if (daemons.size === 0) return Promise.resolve();
  log('info', `[codex-supervisor] stopping ${daemons.size} daemon(s)...`);
  return new Promise((resolve) => {
    const pending = new Set<string>();
    for (const info of daemons.values()) {
      pending.add(info.agentId);
      info.child.once('exit', () => {
        pending.delete(info.agentId);
        if (pending.size === 0) resolve();
      });
      try { info.child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    // Hard timeout: if children don't exit in 5s, SIGKILL and resolve
    setTimeout(() => {
      if (pending.size === 0) return;
      log('warn', `[codex-supervisor] ${pending.size} daemon(s) didn't exit cleanly; SIGKILL`);
      for (const info of daemons.values()) {
        if (pending.has(info.agentId)) {
          try { info.child.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }
      resolve();
    }, 5000);
  });
}

// Status snapshot for `kitty-hive status` / `kitty-hive agent list` and the
// /admin/codex-daemons endpoint.
export interface DaemonSnapshot {
  agent_id: string;
  display_name: string;
  pid: number;
  uptime_ms: number;
  restart_count: number;
  // Populated after the daemon POSTs to /admin/codex-daemon-ready. Until then
  // ws_url/thread_id are null (daemon still booting codex app-server).
  ws_url: string | null;
  thread_id: string | null;
  ready: boolean;
  control_url: string | null;
}

export function getDaemonSnapshots(): DaemonSnapshot[] {
  const now = Date.now();
  return [...daemons.values()].map(info => ({
    agent_id: info.agentId,
    display_name: info.displayName,
    pid: info.pid,
    uptime_ms: now - info.startedAt.getTime(),
    restart_count: info.restartCount,
    ws_url: info.wsUrl,
    thread_id: info.threadId,
    ready: !!info.readyAt,
    control_url: info.controlUrl,
  }));
}

/** Look up the live daemon for an agent, by agent_id or external_key.
 *  Returns null when no daemon is running for that agent. */
export function getDaemonForAgent(
  lookup: { agentId?: string; agentKey?: string },
): DaemonSnapshot | null {
  let info: DaemonInfo | undefined;
  if (lookup.agentId) {
    info = daemons.get(lookup.agentId);
  } else if (lookup.agentKey) {
    // No reverse index — small N, just scan. Need DB lookup to map key→id.
    // To avoid pulling db in here, callers should resolve key→agent_id
    // upstream (the MCP tool does that) and pass agent_id.
    return null;
  }
  if (!info) return null;
  return {
    agent_id: info.agentId,
    display_name: info.displayName,
    pid: info.pid,
    uptime_ms: Date.now() - info.startedAt.getTime(),
    restart_count: info.restartCount,
    ws_url: info.wsUrl,
    thread_id: info.threadId,
    ready: !!info.readyAt,
    control_url: info.controlUrl,
  };
}

/** Called by /admin/codex-daemon-ready when a daemon's codex app-server is up
 *  and its thread is created. Stores ws_url + thread_id on the DaemonInfo so
 *  outside callers can attach via `codex --remote <ws_url>`. */
export function markDaemonReady(agentId: string, wsUrl: string, threadId: string, controlUrl?: string | null): boolean {
  const info = daemons.get(agentId);
  if (!info) return false;
  info.wsUrl = wsUrl;
  info.threadId = threadId;
  info.readyAt = new Date();
  if (controlUrl !== undefined) info.controlUrl = controlUrl;
  // Persist thread_id so next spawn (after daemon kill / serve restart) can
  // resume the same codex thread instead of starting fresh. Idempotent —
  // setting the same id is a cheap UPDATE.
  try { setAgentThreadId(agentId, threadId); } catch (err) {
    log('warn', `[codex-supervisor] failed to persist thread_id for ${agentId}: ${err}`);
  }
  log('info', `[codex-supervisor] daemon "${info.displayName}" ready: ws=${wsUrl} thread=${threadId.slice(0, 8)}...`);

  // Crash-loop counter auto-reset: if this daemon stays alive for 30s,
  // clear restartCount so the next unlucky crash doesn't inherit an
  // inflated exp-backoff. Rationale: once a daemon is stably running for
  // ≥30s it's demonstrably not in a tight crash loop; the point of the
  // backoff table is protection against pathological respawn storms, not
  // permanent penalty for one bad startup. Without this reset, my-game
  // (89 crashes) would sit at 60s backoff forever even if the underlying
  // issue self-resolved. The 30s window is comfortably longer than a
  // healthy codex app-server startup (~5s) so we don't false-reset.
  //
  // Uses the DaemonInfo's own pid to guard against stale timers firing
  // after the daemon was replaced by a new one — restartCount belongs
  // to the *current* daemon instance identified by pid.
  if (info.healthTimer) clearTimeout(info.healthTimer);
  const originalPid = info.pid;
  info.healthTimer = setTimeout(() => {
    const current = daemons.get(agentId);
    if (current && current.pid === originalPid && current.restartCount !== 0) {
      log('info', `[codex-supervisor] daemon "${current.displayName}" healthy 30s → reset restartCount ${current.restartCount}→0`);
      current.restartCount = 0;
    }
  }, 30_000);
  // Don't hold the event loop hostage on shutdown just to check a counter.
  info.healthTimer.unref?.();

  return true;
}

/** Called by /admin/notify-agent-created when a CLI-side `agent register`
 *  inserts a row. The CLI runs in its own process so the in-process
 *  onAgentCreated hook doesn't reach the supervisor; this is the bridge.
 *  Idempotent: returns false if already spawned, true if a new spawn started. */
export function notifyAgentCreated(agentId: string): boolean {
  if (daemons.has(agentId)) return false;
  const agent = getAgentById(agentId);
  if (!agent) return false;
  if (agent.tool !== 'codex' || agent.origin_peer !== '') return false;
  log('info', `[codex-supervisor] notify-agent-created: "${agent.display_name}" (${agentId.slice(-12)}) → spawning daemon`);
  spawnDaemon(agent.id, agent.display_name, 0);
  return true;
}

/** Kill the daemon (if any) for an agent that just got removed. Mirror of
 *  notifyAgentCreated for the delete path. Without this, `kitty-hive agent
 *  remove` deletes the row but leaves a ghost daemon (and its codex
 *  app-server + ws) running — see Bug 1 reported on 2026-05-20: a stale
 *  ws confused TUI routing into a schism. SIGTERM the child; the existing
 *  child.on('exit') handler in spawnDaemon checks `getAgentById(agentId)`
 *  before respawning, so a deleted row naturally short-circuits the
 *  respawn logic — no per-daemon "intentional kill" flag needed.
 *  Returns true if a daemon was killed. */
export function notifyAgentRemoved(agentId: string): boolean {
  const info = daemons.get(agentId);
  if (!info) return false;
  log('info', `[codex-supervisor] notify-agent-removed: "${info.displayName}" (${agentId.slice(-12)}) → killing daemon`);
  try { info.child.kill('SIGTERM'); } catch { /* ignore */ }
  return true;
}

/** Try an IN-PROCESS thread switch: POST to the daemon's control server so it
 *  swaps threads on its live codex app-server (thread/resume or thread/start)
 *  without dying. ~1-2s vs ~9s for the SIGTERM→respawn cycle, and ws_url
 *  stays stable so an attached pane survives.
 *
 *  Returns the updated snapshot on success, or null when the in-process path
 *  is unavailable/failed — caller falls back to requestDaemonRespawn. Reasons
 *  for null: no live daemon, daemon not ready yet, daemon predates the
 *  control server (no controlUrl), control request errored or timed out.
 *
 *  `threadId` semantics mirror /admin/codex-set-thread: non-empty → resume
 *  that thread; empty string → reset to a fresh thread. The daemon re-POSTs
 *  codex-daemon-ready during the switch (updating info.threadId +
 *  agents.thread_id via markDaemonReady) before its control response returns,
 *  so the snapshot we build afterwards is already fresh. */
export async function switchDaemonThread(agentId: string, threadId: string, timeoutMs = 15_000): Promise<DaemonSnapshot | null> {
  const info = daemons.get(agentId);
  if (!info || !info.readyAt || !info.controlUrl) {
    log('info', `[codex-supervisor] switchDaemonThread: no in-process path for ${agentId.slice(-12)} (daemon=${!!info} ready=${!!info?.readyAt} control=${!!info?.controlUrl})`);
    return null;
  }
  try {
    const res = await fetch(`${info.controlUrl}/switch-thread`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thread_id: threadId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => null) as { ok?: boolean; thread_id?: string; error?: string } | null;
    if (!res.ok || !body?.ok || !body.thread_id) {
      log('warn', `[codex-supervisor] switchDaemonThread failed for "${info.displayName}": ${body?.error || `http ${res.status}`} — falling back to respawn`);
      return null;
    }
    // markDaemonReady normally already ran via the daemon's re-announce, but
    // don't depend on that ordering — set the authoritative value here too.
    info.threadId = body.thread_id;
    log('info', `[codex-supervisor] in-process thread switch for "${info.displayName}": → ${body.thread_id.slice(0, 8)}... (ws unchanged)`);
    return getDaemonForAgent({ agentId });
  } catch (err: any) {
    log('warn', `[codex-supervisor] switchDaemonThread error for "${info.displayName}": ${err?.message || err} — falling back to respawn`);
    return null;
  }
}

/** Force a daemon to (re)spawn for an agent, then wait up to `timeoutMs` for
 *  it to reach ready state. Used by /admin/codex-set-thread when the caller
 *  has just mutated agents.thread_id and needs the daemon to pick up the
 *  new value (either via thread/resume of a different thread, or thread/start
 *  for a fresh thread when thread_id was cleared).
 *
 *  Two paths:
 *   - Daemon already running → mark intentionalShutdown, SIGTERM it;
 *     supervisor's on-exit handler sees the flag, respawns immediately
 *     (skipping the crash-loop exp backoff) and resets restartCount to 0.
 *     The new daemon picks up the fresh agents.thread_id at its
 *     env-injection step.
 *   - No daemon → call notifyAgentCreated (skips if not eligible).
 *
 *  The intentionalShutdown flag matters when a daemon has accumulated
 *  restartCount from previous unrelated crashes: without it, the exit
 *  handler would apply exp backoff (up to 60s) even though the operator
 *  just wanted a quick thread swap. Real incident 2026-07-12 (my-game
 *  restart_count=89) blocked kitty's set-thread flow for 60s per call.
 *
 *  After kicking, polls `daemons.get(agentId)` for readiness every 200ms.
 *  Returns the ready snapshot, or null on timeout. The caller is expected to
 *  have validated that the agent exists and is tool=codex; this function
 *  trusts that. */
export async function requestDaemonRespawn(agentId: string, timeoutMs = 30_000): Promise<DaemonSnapshot | null> {
  const existing = daemons.get(agentId);
  if (existing) {
    log('info', `[codex-supervisor] requestDaemonRespawn: SIGTERM existing daemon for "${existing.displayName}" (${agentId.slice(-12)}), intentional=true`);
    existing.intentionalShutdown = true;
    try { existing.child.kill('SIGTERM'); } catch { /* ignore */ }
  } else {
    log('info', `[codex-supervisor] requestDaemonRespawn: no live daemon for ${agentId.slice(-12)}, requesting spawn`);
    notifyAgentCreated(agentId);
  }

  const startedAt = Date.now();
  // Wait for the OLD daemon (if any) to exit and the supervisor's restart
  // backoff to fire, plus the new daemon to call markDaemonReady (which
  // happens after thread/resume or thread/start succeeds and the daemon
  // POSTs /admin/codex-daemon-ready). Poll cheaply: 200ms is well below the
  // typical daemon spawn-to-ready time (~5s) and short enough to bound
  // perceived latency for the kitty UI caller.
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise(r => setTimeout(r, 200));
    const snap = daemons.get(agentId);
    if (!snap) continue;        // still respawning; existing was killed, new not yet started
    if (!snap.readyAt) continue; // spawned but codex app-server / thread not ready yet
    // Don't return the old daemon's snapshot if we just SIGTERM'd it — the
    // pid will have changed when the new daemon spawns. Use startedAt as a
    // sentinel: the new daemon's startedAt > our startedAt.
    if (existing && snap.startedAt.getTime() <= startedAt) continue;
    return {
      agent_id: snap.agentId,
      display_name: snap.displayName,
      pid: snap.pid,
      uptime_ms: Date.now() - snap.startedAt.getTime(),
      restart_count: snap.restartCount,
      ws_url: snap.wsUrl,
      thread_id: snap.threadId,
      ready: true,
      control_url: snap.controlUrl,
    };
  }
  return null;
}
