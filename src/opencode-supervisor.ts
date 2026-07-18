import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentById, listLocalOpenCodeAgents, onAgentCreated, setAgentThreadId } from './db.js';
import { log } from './log.js';
import type { Agent } from './models.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface OpenCodeDaemonInfo {
  agentId: string;
  displayName: string;
  child: ChildProcess;
  pid: number;
  startedAt: Date;
  restartCount: number;
  serverUrl: string | null;
  sessionId: string | null;
  serverUsername: string | null;
  serverPassword: string | null;
  controlUrl: string | null;
  version: string | null;
  readyAt: Date | null;
  intentionalShutdown?: boolean;
  healthTimer?: NodeJS.Timeout;
}

export interface OpenCodeDaemonSnapshot {
  agent_id: string;
  display_name: string;
  pid: number;
  uptime_ms: number;
  restart_count: number;
  server_url: string | null;
  session_id: string | null;
  server_username: string | null;
  server_password: string | null;
  control_url: string | null;
  version: string | null;
  ready: boolean;
}

const daemons = new Map<string, OpenCodeDaemonInfo>();
let shuttingDown = false;
let supervisorPort = 4123;

function findNpx(): string {
  const probe = process.platform === 'win32' ? 'where npx' : 'command -v npx';
  try {
    return execSync(probe, { encoding: 'utf8' }).trim().split(/\r?\n/)[0] || 'npx';
  } catch {
    return 'npx';
  }
}

function locateChannelScript(): string {
  const packaged = join(__dirname, '..', 'opencode-channel.ts');
  if (existsSync(packaged)) return packaged;
  const dev = join(__dirname, '..', '..', 'opencode-channel.ts');
  if (existsSync(dev)) return dev;
  throw new Error(`cannot locate opencode-channel.ts (tried ${packaged})`);
}

function snapshot(info: OpenCodeDaemonInfo): OpenCodeDaemonSnapshot {
  return {
    agent_id: info.agentId,
    display_name: info.displayName,
    pid: info.pid,
    uptime_ms: Date.now() - info.startedAt.getTime(),
    restart_count: info.restartCount,
    server_url: info.serverUrl,
    session_id: info.sessionId,
    server_username: info.serverUsername,
    server_password: info.serverPassword,
    control_url: info.controlUrl,
    version: info.version,
    ready: !!info.readyAt,
  };
}

function spawnDaemon(agentId: string, displayName: string, restartCount = 0) {
  if (shuttingDown || daemons.has(agentId)) return;
  const eligible = getAgentById(agentId);
  if (!eligible || eligible.tool !== 'opencode' || eligible.origin_peer !== '') return;

  let script: string;
  try {
    script = locateChannelScript();
  } catch (err) {
    log('warn', `[opencode-supervisor] ${err}`);
    return;
  }

  const cleanEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('HIVE_')) continue;
    cleanEnv[key] = value;
  }
  cleanEnv.HIVE_AGENT_ID = agentId;
  cleanEnv.HIVE_AGENT_NAME = displayName;
  cleanEnv.HIVE_URL = `http://127.0.0.1:${supervisorPort}/mcp`;
  if (eligible.project_dir) cleanEnv.OPENCODE_SERVER_CWD = eligible.project_dir;
  if (eligible.thread_id) cleanEnv.HIVE_AGENT_SESSION_ID = eligible.thread_id;

  log('info', `[opencode-supervisor] spawning daemon for "${displayName}" (${agentId.slice(-12)}) restart=${restartCount}`);
  const child = spawn(findNpx(), ['-y', 'tsx', script], {
    env: cleanEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!child.pid) {
    log('warn', `[opencode-supervisor] failed to spawn daemon for "${displayName}": no pid`);
    return;
  }

  const info: OpenCodeDaemonInfo = {
    agentId,
    displayName,
    child,
    pid: child.pid,
    startedAt: new Date(),
    restartCount,
    serverUrl: null,
    sessionId: null,
    serverUsername: null,
    serverPassword: null,
    controlUrl: null,
    version: null,
    readyAt: null,
  };
  daemons.set(agentId, info);

  const prefix = `[opencode:${displayName}]`;
  child.stdout?.on('data', chunk => process.stderr.write(`${prefix} ${chunk}`));
  child.stderr?.on('data', chunk => process.stderr.write(`${prefix} ${chunk}`));
  child.on('error', err => log('warn', `[opencode-supervisor] daemon "${displayName}" process error: ${err}`));
  child.on('exit', (code, signal) => {
    const intentional = info.intentionalShutdown === true;
    if (info.healthTimer) clearTimeout(info.healthTimer);
    daemons.delete(agentId);
    log('info', `[opencode-supervisor] daemon "${displayName}" exited (code=${code}, signal=${signal}, intentional=${intentional})`);
    if (shuttingDown) return;
    const fresh = getAgentById(agentId);
    if (!fresh || fresh.tool !== 'opencode' || fresh.origin_peer !== '') return;
    const delayMs = intentional ? 0 : Math.min(60_000, 1_000 * Math.pow(2, restartCount));
    const nextCount = intentional ? 0 : restartCount + 1;
    setTimeout(() => spawnDaemon(fresh.id, fresh.display_name, nextCount), delayMs).unref?.();
  });
}

export function startOpenCodeSupervisor(port = 4123) {
  supervisorPort = port;
  const agents = listLocalOpenCodeAgents();
  if (agents.length === 0) {
    log('info', '[opencode-supervisor] no local tool=opencode agents — nothing to spawn at boot');
  } else {
    log('info', `[opencode-supervisor] starting ${agents.length} daemon(s): ${agents.map(agent => agent.display_name).join(', ')}`);
    for (const agent of agents) spawnDaemon(agent.id, agent.display_name);
  }
  onAgentCreated((agent: Agent) => {
    if (agent.tool === 'opencode' && agent.origin_peer === '') spawnDaemon(agent.id, agent.display_name);
  });
}

export function stopOpenCodeSupervisor(): Promise<void> {
  shuttingDown = true;
  if (daemons.size === 0) return Promise.resolve();
  return new Promise(resolve => {
    const pending = new Set(daemons.keys());
    for (const info of daemons.values()) {
      info.child.once('exit', () => {
        pending.delete(info.agentId);
        if (pending.size === 0) resolve();
      });
      try { info.child.kill('SIGTERM'); } catch { pending.delete(info.agentId); }
    }
    setTimeout(() => {
      for (const info of daemons.values()) {
        if (!pending.has(info.agentId)) continue;
        try { info.child.kill('SIGKILL'); } catch { /* ignore */ }
      }
      resolve();
    }, 5_000).unref?.();
  });
}

export function getOpenCodeDaemonSnapshots(): OpenCodeDaemonSnapshot[] {
  return [...daemons.values()].map(snapshot);
}

export function getOpenCodeDaemonForAgent(agentId: string): OpenCodeDaemonSnapshot | null {
  const info = daemons.get(agentId);
  return info ? snapshot(info) : null;
}

export function markOpenCodeDaemonReady(input: {
  agentId: string;
  serverUrl: string;
  sessionId: string;
  serverUsername: string;
  serverPassword: string;
  controlUrl?: string | null;
  version?: string | null;
}): boolean {
  const info = daemons.get(input.agentId);
  if (!info) return false;
  info.serverUrl = input.serverUrl;
  info.sessionId = input.sessionId;
  info.serverUsername = input.serverUsername;
  info.serverPassword = input.serverPassword;
  info.controlUrl = input.controlUrl || null;
  info.version = input.version || null;
  info.readyAt = new Date();
  setAgentThreadId(input.agentId, input.sessionId);
  log('info', `[opencode-supervisor] daemon "${info.displayName}" ready: server=${input.serverUrl} session=${input.sessionId.slice(0, 12)}... version=${info.version || 'unknown'}`);

  if (info.healthTimer) clearTimeout(info.healthTimer);
  const pid = info.pid;
  info.healthTimer = setTimeout(() => {
    const current = daemons.get(input.agentId);
    if (current?.pid === pid) current.restartCount = 0;
  }, 30_000);
  info.healthTimer.unref?.();
  return true;
}

export function notifyOpenCodeAgentCreated(agentId: string): boolean {
  if (daemons.has(agentId)) return false;
  const agent = getAgentById(agentId);
  if (!agent || agent.tool !== 'opencode' || agent.origin_peer !== '') return false;
  spawnDaemon(agent.id, agent.display_name);
  return true;
}

export function notifyOpenCodeAgentRemoved(agentId: string): boolean {
  const info = daemons.get(agentId);
  if (!info) return false;
  try { info.child.kill('SIGTERM'); } catch { /* ignore */ }
  return true;
}

export async function switchOpenCodeSession(
  agentId: string,
  sessionId: string | null,
  timeoutMs = 30_000,
): Promise<OpenCodeDaemonSnapshot | null> {
  const info = daemons.get(agentId);
  if (!info?.readyAt || !info.controlUrl) return null;
  try {
    const res = await fetch(`${info.controlUrl}/switch-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => null) as { ok?: boolean; session_id?: string; error?: string } | null;
    if (!res.ok || !body?.ok || !body.session_id) {
      log('warn', `[opencode-supervisor] switch-session failed for "${info.displayName}": ${body?.error || `HTTP ${res.status}`}`);
      return null;
    }
    info.sessionId = body.session_id;
    setAgentThreadId(agentId, body.session_id);
    return snapshot(info);
  } catch (err) {
    log('warn', `[opencode-supervisor] switch-session error for "${info.displayName}": ${err}`);
    return null;
  }
}

export async function requestOpenCodeDaemonRespawn(agentId: string, timeoutMs = 45_000): Promise<OpenCodeDaemonSnapshot | null> {
  const existing = daemons.get(agentId);
  const kickedAt = Date.now();
  if (existing) {
    existing.intentionalShutdown = true;
    try { existing.child.kill('SIGTERM'); } catch { /* ignore */ }
  } else {
    notifyOpenCodeAgentCreated(agentId);
  }
  while (Date.now() - kickedAt < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 200));
    const current = daemons.get(agentId);
    if (!current?.readyAt) continue;
    if (existing && current.startedAt.getTime() <= kickedAt) continue;
    return snapshot(current);
  }
  return null;
}
