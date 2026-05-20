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
 * Out of scope (deferred):
 *   - Hot reload on DB changes (poll / watch). Add/remove agents → must
 *     restart serve to pick up. Acceptable for now since codex agents are
 *     long-lived once configured.
 *   - Thread persistence across serve restarts. Each spawn → new codex thread
 *     → fresh context. Fine for task-driven workers.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { log } from './log.js';
import { listLocalCodexAgents, getAgentById } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface DaemonInfo {
  agentId: string;
  displayName: string;
  child: ChildProcess;
  pid: number;
  startedAt: Date;
  restartCount: number;
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
  };
  daemons.set(agentId, info);

  // Tee daemon output into serve's stderr with a label so user can see what
  // each daemon is doing without separate log files. We forward both stdout
  // and stderr to stderr (stdout would interleave with the http log lines).
  const prefix = `[codex:${displayName}]`;
  child.stdout?.on('data', (chunk) => process.stderr.write(`${prefix} ${chunk}`));
  child.stderr?.on('data', (chunk) => process.stderr.write(`${prefix} ${chunk}`));

  child.on('exit', (code, signal) => {
    daemons.delete(agentId);
    log('info', `[codex-supervisor] daemon "${displayName}" exited (code=${code}, signal=${signal})`);
    if (shuttingDown) return;

    // Refresh agent record — it may have been removed or modified
    const fresh = getAgentById(agentId);
    if (!fresh || fresh.tool !== 'codex' || fresh.origin_peer !== '') {
      log('info', `[codex-supervisor] daemon "${displayName}" no longer eligible for spawn (deleted / tool changed / now remote); not restarting`);
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, ... cap 60s
    const delayMs = Math.min(60000, 1000 * Math.pow(2, restartCount));
    log('warn', `[codex-supervisor] restarting "${fresh.display_name}" in ${delayMs}ms (attempt ${restartCount + 1})`);
    setTimeout(() => {
      spawnDaemon(fresh.id, fresh.display_name, restartCount + 1);
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
    log('info', '[codex-supervisor] no local tool=codex agents — nothing to spawn');
    return;
  }
  log('info', `[codex-supervisor] starting ${agents.length} codex daemon(s): ${agents.map(a => a.display_name).join(', ')}`);
  for (const agent of agents) {
    spawnDaemon(agent.id, agent.display_name, 0);
  }
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

// Status snapshot for `kitty-hive status` / `kitty-hive agent list`
export interface DaemonSnapshot {
  agent_id: string;
  display_name: string;
  pid: number;
  uptime_ms: number;
  restart_count: number;
}

export function getDaemonSnapshots(): DaemonSnapshot[] {
  const now = Date.now();
  return [...daemons.values()].map(info => ({
    agent_id: info.agentId,
    display_name: info.displayName,
    pid: info.pid,
    uptime_ms: now - info.startedAt.getTime(),
    restart_count: info.restartCount,
  }));
}
