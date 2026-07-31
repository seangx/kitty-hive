#!/usr/bin/env node
/**
 * Persistent kitty-hive push bridge for OpenCode.
 *
 * One daemon owns one `opencode serve` backend and one OpenCode session.
 * Hive events are queued, checked for stale/read DMs, then injected into that
 * session. A visible TUI attaches to the same backend/session with:
 *
 *   opencode attach <server_url> --session <session_id> --password <password>
 */

import { randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import {
  OpenCodeClient,
  buildOpenCodePrompt,
  eventDedupKey,
  type HivePushEvent,
} from './src/opencode-channel-runtime.js';
import { checkEventDeliveryBeforeInject } from './src/codex-channel-runtime.js';

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--name' && process.argv[i + 1]) process.env.HIVE_AGENT_NAME = process.argv[++i];
  else if (arg === '--id' && process.argv[i + 1]) process.env.HIVE_AGENT_ID = process.argv[++i];
  else if (arg === '--key' && process.argv[i + 1]) process.env.HIVE_AGENT_KEY = process.argv[++i];
  else if (arg === '--url' && process.argv[i + 1]) process.env.HIVE_URL = process.argv[++i];
  else if (arg === '--cmd' && process.argv[i + 1]) process.env.OPENCODE_CMD = process.argv[++i];
  else if (arg === '--help' || arg === '-h') {
    console.log('Usage: kitty-hive opencode-channel [--name N|--id ID|--key K] [--url URL] [--cmd PATH]');
    process.exit(0);
  }
}

const HIVE_URL = process.env.HIVE_URL || 'http://127.0.0.1:4123/mcp';
const ENV_ID = process.env.HIVE_AGENT_ID || '';
const ENV_KEY = process.env.HIVE_AGENT_KEY || '';
const ENV_NAME = process.env.HIVE_AGENT_NAME || '';
const HIVE_AGENT_ROLES = process.env.HIVE_AGENT_ROLES || '';
const PERSISTED_SESSION_ID = (process.env.HIVE_AGENT_SESSION_ID || '').trim();
const OPENCODE_CMD = process.env.OPENCODE_CMD || 'opencode';
const OPENCODE_CWD = process.env.OPENCODE_SERVER_CWD || process.cwd();
const PUSH_DELIVERY_STATUS_URL = new URL('/admin/push-delivery-status', HIVE_URL).toString();

let hiveSessionId: string | null = null;
let hiveRpcId = 0;
let agentId = '';
let agentName = '';
let openCodeProcess: ChildProcess | null = null;
let openCodeClient: OpenCodeClient | null = null;
let openCodeServerUrl = '';
let openCodeVersion = '';
let openCodeSessionId = '';
let openCodeSessionResumed = false;
let controlServer: HttpServer | null = null;
let controlUrl: string | null = null;
let shuttingDown = false;
let processing = false;
const eventQueue: HivePushEvent[] = [];
const seenEvents = new Set<string>();

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(err => err ? reject(err) : resolve(port));
    });
  });
}

async function hivePost(method: string, params: unknown = {}, retried = false): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (hiveSessionId && method !== 'initialize') headers['Mcp-Session-Id'] = hiveSessionId;

  const res = await fetch(HIVE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++hiveRpcId, method, params }),
  });
  if (res.status === 404 && !retried && method !== 'initialize') {
    console.error('[opencode-channel] hive session stale; re-initializing');
    await initHiveSession();
    if (agentId) await hiveCallTool('hive_start', reconnectArgs(), true);
    return hivePost(method, params, true);
  }
  const sid = res.headers.get('mcp-session-id');
  if (sid) hiveSessionId = sid;
  const text = await res.text();
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = JSON.parse(line.slice(5));
    if (data.error) throw new Error(JSON.stringify(data.error));
    return data.result;
  }
  const data = JSON.parse(text);
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.result;
}

async function hiveCallTool(name: string, args: unknown = {}, retried = false): Promise<any> {
  const result = await hivePost('tools/call', { name, arguments: args }, retried);
  const text = result.content?.[0]?.text ?? '';
  if (result.isError) throw new Error(text);
  try { return JSON.parse(text); } catch { return text; }
}

async function initHiveSession() {
  hiveSessionId = null;
  await hivePost('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: { experimental: { 'kitty-hive/event-consumer': {} } },
    clientInfo: { name: 'opencode-channel', version: '1.0' },
  });
  await fetch(HIVE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Mcp-Session-Id': hiveSessionId!,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
}

function reconnectArgs() {
  return {
    id: agentId || ENV_ID || undefined,
    tool: 'opencode',
    roles: HIVE_AGENT_ROLES || undefined,
  };
}

async function registerAgent() {
  const args: Record<string, unknown> = { tool: 'opencode' };
  if (ENV_ID) args.id = ENV_ID;
  if (ENV_KEY) args.key = ENV_KEY;
  if (ENV_NAME) args.name = ENV_NAME;
  if (HIVE_AGENT_ROLES) args.roles = HIVE_AGENT_ROLES;
  const result = await hiveCallTool('hive_start', args);
  agentId = result.agent_id;
  agentName = result.display_name;
}

function rememberEvent(key: string): boolean {
  if (seenEvents.has(key)) return false;
  seenEvents.add(key);
  if (seenEvents.size > 10_000) {
    const oldest = seenEvents.values().next().value;
    if (oldest) seenEvents.delete(oldest);
  }
  return true;
}

async function shouldInject(ev: HivePushEvent): Promise<boolean> {
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
    console.error(`[opencode-channel] skipped stale/consumed event event=${eventDedupKey(ev)} reason=${decision.reason} seq=${decision.seq ?? decision.message_id ?? 'n/a'} cursor=${decision.cursor ?? 'n/a'} latest=${decision.latest_seq ?? 'n/a'}`);
    return false;
  }
  if (decision.reason === 'preflight_error') {
    console.error(`[opencode-channel] event preflight failed; fail-open event=${eventDedupKey(ev)}: ${decision.error}`);
  }
  return true;
}

function enqueue(ev: HivePushEvent) {
  ev.received_at ||= new Date().toISOString();
  const key = eventDedupKey(ev);
  if (!rememberEvent(key)) return;
  eventQueue.push(ev);
  void processNextEvent();
}

function enqueueSessionBrief(type: 'daemon-intro' | 'daemon-rebind') {
  enqueue({
    type,
    event_id: `${type}:${agentId}:${openCodeSessionId}:${Date.now()}`,
  });
}

async function processNextEvent() {
  if (processing || !openCodeClient || !openCodeSessionId) return;
  const ev = eventQueue.shift();
  if (!ev) return;
  processing = true;
  const key = eventDedupKey(ev);
  try {
    if (!(await shouldInject(ev))) return;
    const prompt = buildOpenCodePrompt(ev, { id: agentId, name: agentName });
    console.error(`[opencode-channel] inject event=${key} session=${openCodeSessionId.slice(-10)}`);
    const outcome = await openCodeClient.inject(openCodeSessionId, key, prompt);
    if (outcome.kind !== 'completed' && outcome.kind !== 'skipped_duplicate') {
      console.error(`[opencode-channel] inject outcome=${outcome.kind} event=${key}${outcome.kind === 'failed' ? ` error=${outcome.error.message}` : ''}`);
    }
  } catch (err) {
    console.error(`[opencode-channel] unexpected event failure; event consumed without retry (${key}):`, err);
  } finally {
    processing = false;
    void processNextEvent();
  }
}

async function startOpenCode() {
  const versionProbe = spawnSync(OPENCODE_CMD, ['--version'], { encoding: 'utf8' });
  if (versionProbe.status !== 0) {
    throw new Error(`OpenCode CLI not available: ${versionProbe.stderr || versionProbe.error || OPENCODE_CMD}`);
  }
  openCodeVersion = String(versionProbe.stdout || '').trim();
  const port = await freePort();
  const username = 'opencode';
  const password = randomBytes(24).toString('hex');
  openCodeServerUrl = `http://127.0.0.1:${port}`;

  const env = {
    ...process.env,
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
  };
  openCodeProcess = spawn(OPENCODE_CMD, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: OPENCODE_CWD,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  if (!openCodeProcess.pid) throw new Error('OpenCode serve spawn returned no pid');
  openCodeProcess.stdout?.on('data', chunk => process.stderr.write(`[opencode-server] ${chunk}`));
  openCodeProcess.stderr?.on('data', chunk => process.stderr.write(`[opencode-server] ${chunk}`));
  openCodeProcess.on('exit', (code, signal) => {
    console.error(`[opencode-channel] OpenCode server exited code=${code} signal=${signal}`);
    if (!shuttingDown) process.exit(2);
  });
  openCodeProcess.on('error', err => {
    console.error('[opencode-channel] OpenCode server process error:', err);
    if (!shuttingDown) process.exit(2);
  });

  openCodeClient = new OpenCodeClient(openCodeServerUrl, username, password);
  const started = Date.now();
  let healthy = false;
  while (Date.now() - started < 30_000) {
    try {
      const health = await openCodeClient.health();
      openCodeVersion = health.version || openCodeVersion;
      healthy = true;
      break;
    } catch {
      await sleep(200);
    }
  }
  if (!healthy) throw new Error('OpenCode server did not become healthy within 30s');

  if (PERSISTED_SESSION_ID) {
    try {
      const session = await openCodeClient.getSession(PERSISTED_SESSION_ID);
      openCodeSessionId = session.id;
      openCodeSessionResumed = true;
      console.error(`[opencode-channel] resumed session ${openCodeSessionId}`);
    } catch (err) {
      console.error(`[opencode-channel] persisted session unavailable (${PERSISTED_SESSION_ID}); creating fresh: ${err}`);
    }
  }
  if (!openCodeSessionId) {
    const session = await openCodeClient.createSession(`kitty-hive: ${agentName}`);
    openCodeSessionId = session.id;
    openCodeSessionResumed = false;
    console.error(`[opencode-channel] created session ${openCodeSessionId}`);
  }
  return { username, password };
}

async function startControlServer(): Promise<string> {
  const port = await freePort();
  controlServer = createServer(async (req, res) => {
    if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::1' && req.socket.remoteAddress !== '::ffff:127.0.0.1') {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== 'POST' || req.url !== '/switch-session') {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
      return;
    }
    if (processing) {
      res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'session has an in-flight daemon turn; retry when idle' }));
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (!Object.prototype.hasOwnProperty.call(body, 'session_id')) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'session_id required; use null to create fresh' }));
        return;
      }
      let briefType: 'daemon-intro' | 'daemon-rebind';
      if (typeof body.session_id === 'string' && body.session_id) {
        const session = await openCodeClient!.getSession(body.session_id);
        openCodeSessionId = session.id;
        openCodeSessionResumed = true;
        briefType = 'daemon-rebind';
      } else if (body.session_id === null || body.session_id === '') {
        const session = await openCodeClient!.createSession(`kitty-hive: ${agentName}`);
        openCodeSessionId = session.id;
        openCodeSessionResumed = false;
        briefType = 'daemon-intro';
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'session_id must be string, empty string, or null' }));
        return;
      }
      await openCodeClient!.selectTuiSession(openCodeSessionId).catch(err => {
        console.error('[opencode-channel] TUI session selection was not acknowledged:', err);
      });
      await announceReady(currentCredentials.username, currentCredentials.password);
      enqueueSessionBrief(briefType);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, session_id: openCodeSessionId }));
    } catch (err: any) {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(err?.message || err) }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    controlServer!.once('error', reject);
    controlServer!.listen(port, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${port}`;
}

let currentCredentials = { username: '', password: '' };

async function announceReady(username: string, password: string) {
  const adminUrl = new URL('/admin/opencode-daemon-ready', HIVE_URL).toString();
  const res = await fetch(adminUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: agentId,
      server_url: openCodeServerUrl,
      session_id: openCodeSessionId,
      server_username: username,
      server_password: password,
      control_url: controlUrl,
      version: openCodeVersion,
    }),
  });
  if (!res.ok) throw new Error(`ready announce failed: HTTP ${res.status} ${await res.text()}`);
}

async function listenHiveSSE() {
  while (!shuttingDown) {
    try {
      const res = await fetch(HIVE_URL, {
        method: 'GET',
        headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': hiveSessionId! },
      });
      if (!res.ok || !res.body) {
        console.error(`[opencode-channel] hive SSE HTTP ${res.status}; re-registering`);
        await initHiveSession();
        await hiveCallTool('hive_start', reconnectArgs());
        await sleep(3_000);
        continue;
      }
      console.error('[opencode-channel] hive SSE connected');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!shuttingDown) {
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
            let parsed: HivePushEvent;
            try { parsed = JSON.parse(raw); } catch { parsed = { type: 'message', preview: raw, raw }; }
            if (parsed.type === 'join' || parsed.type === 'leave') continue;
            console.error(`[opencode-channel] push type=${parsed.type || 'unknown'} from=${parsed.from || parsed.from_agent_id || 'unknown'}`);
            enqueue(parsed);
          } catch (err) {
            console.error('[opencode-channel] hive SSE parse error:', err);
          }
        }
      }
    } catch (err) {
      if (!shuttingDown) console.error('[opencode-channel] hive SSE error:', err);
    }
    if (!shuttingDown) await sleep(3_000);
  }
}

function stopChild() {
  const child = openCodeProcess;
  if (!child?.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch { /* already gone */ }
}

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[opencode-channel] received ${signal}; shutting down`);
  controlServer?.close();
  stopChild();
  setTimeout(() => process.exit(0), 500).unref();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { void shutdown(signal); });
}

async function main() {
  if (!ENV_ID && !ENV_KEY && !ENV_NAME) {
    throw new Error('must provide HIVE_AGENT_ID, HIVE_AGENT_KEY, or HIVE_AGENT_NAME');
  }
  await initHiveSession();
  await registerAgent();
  console.error(`[opencode-channel] connected as "${agentName}" (${agentId})`);
  currentCredentials = await startOpenCode();
  controlUrl = await startControlServer();
  await announceReady(currentCredentials.username, currentCredentials.password);
  console.error(`[opencode-channel] ready server=${openCodeServerUrl} session=${openCodeSessionId} version=${openCodeVersion}`);

  enqueueSessionBrief(openCodeSessionResumed ? 'daemon-rebind' : 'daemon-intro');
  await listenHiveSSE();
}

main().catch(err => {
  console.error('[opencode-channel] fatal:', err);
  stopChild();
  process.exit(1);
});
