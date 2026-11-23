#!/usr/bin/env node
/**
 * 端到端集成测试：真实 kitty-hive serve + agy-channel + agy-relay + agy-hook.mjs
 *
 * 验证完整链路：
 * 1. agy-channel 通过 stdio MCP 注册 tool='antigravity' 的 agent 并建立 SSE 推送流；
 * 2. agy-relay 通过本地 Unix socket 连上 agy-channel，并以 stub agentapi 验证收到 DM 时触发 send-message；
 * 3. PreInvocation hook 上报新的 conversationId（模拟 /clear 或 /resume），后续 DM 准确投递到新会话；
 * 4. agy-relay 退出后，新到达的 DM 由 Stop hook 返回 decision='continue' 兜底交付。
 */

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';

const ROOT = new URL('.', import.meta.url).pathname;
const DIST_INDEX = join(ROOT, 'dist', 'index.js');
const HOOK_SCRIPT = join(ROOT, 'antigravity-plugin', 'scripts', 'agy-hook.mjs');

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

async function waitFor(fn, timeoutMs = 8000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

class StdioMcpClient {
  constructor(child) {
    this.child = child;
    this.id = 0;
    this.pending = new Map();
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }

  request(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }
}

async function hiveHttpRpc(url, sid, method, params) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (sid) headers['Mcp-Session-Id'] = sid;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params }),
  });
  const nextSid = res.headers.get('mcp-session-id') || sid;
  const text = await res.text();
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) {
      const data = JSON.parse(line.slice(5));
      if (data.error) throw new Error(JSON.stringify(data.error));
      return { sid: nextSid, result: data.result };
    }
  }
  const data = JSON.parse(text);
  if (data.error) throw new Error(JSON.stringify(data.error));
  return { sid: nextSid, result: data.result };
}

function runHook(socketPath, stdinObj) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [HOOK_SCRIPT],
      { env: { ...process.env, HIVE_AGY_BRIDGE_SOCKET: socketPath }, timeout: 5000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`hook failed: ${stderr || err.message}`));
        resolve(JSON.parse(stdout.trim()));
      },
    );
    child.stdin.end(JSON.stringify(stdinObj));
  });
}

const workDir = mkdtempSync(join(tmpdir(), 'kitty-hive-agy-e2e-'));
const dbPath = join(workDir, 'hive.db');
const socketPath = join(workDir, 'bridge.sock');
const agentApiLog = join(workDir, 'agentapi.jsonl');
const stubAgentApi = join(workDir, 'stub-agentapi.mjs');

writeFileSync(
  stubAgentApi,
  `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(agentApiLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
`,
);
chmodSync(stubAgentApi, 0o755);

const port = await pickFreePort();
const hiveUrl = `http://127.0.0.1:${port}/mcp`;
const children = [];

try {
  // 1. 启动临时 kitty-hive serve
  const server = spawn(process.execPath, [DIST_INDEX, 'serve', '--port', String(port), '--db', dbPath, '-q'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(server);

  await waitFor(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/mcp`);
      return r.status === 400; // missing session id → server ready
    } catch {
      return false;
    }
  }, 8000, 'hive serve');

  // 2. 启动 agy-channel (stdio MCP) — 清理宿主的 HIVE_AGENT_* 环境变量，确保测试隔离
  const channelEnv = { ...process.env, HIVE_URL: hiveUrl, HIVE_AGY_BRIDGE_SOCKET: socketPath };
  delete channelEnv.HIVE_AGENT_ID;
  delete channelEnv.HIVE_AGENT_KEY;
  delete channelEnv.HIVE_AGENT_NAME;
  delete channelEnv.HIVE_AGENT_ROLES;
  const channel = spawn(process.execPath, [DIST_INDEX, 'agy-channel'], {
    env: channelEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(channel);

  const mcp = new StdioMcpClient(channel);
  await mcp.request('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'agy-test-client', version: '1.0' },
  });
  mcp.notify('notifications/initialized');

  const toolsRes = await mcp.request('tools/list', {});
  const toolNames = toolsRes.tools.map((t) => t.name);
  assert.ok(toolNames.includes('hive-whoami'), 'expected hive-whoami');
  assert.ok(toolNames.includes('hive-dm'), 'expected hive-dm');
  assert.ok(toolNames.includes('hive-dm-read'), 'expected hive-dm-read');

  // 注册 Antigravity agent
  const whoamiRes = await mcp.request('tools/call', {
    name: 'hive-whoami',
    arguments: { name: 'agy-worker' },
  });
  const whoami = JSON.parse(whoamiRes.content[0].text);
  assert.equal(whoami.agent_name, 'agy-worker');
  assert.equal(whoami.tool, 'antigravity');
  assert.equal(whoami.relay_connected, false);

  // 3. 启动 agy-relay 守护进程（使用 stub agentapi）
  const relay = spawn(process.execPath, [DIST_INDEX, 'agy-relay', '--socket', socketPath], {
    env: {
      ...process.env,
      ANTIGRAVITY_AGENTAPI_EXE: stubAgentApi,
      ANTIGRAVITY_CONVERSATION_ID: 'conv-initial',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(relay);

  await waitFor(async () => {
    const res = await mcp.request('tools/call', { name: 'hive-whoami', arguments: {} });
    return JSON.parse(res.content[0].text).relay_connected === true;
  }, 6000, 'relay connected');

  // 模拟 SessionStart hook 上报 conv-1
  const h1 = await runHook(socketPath, { hookEventName: 'SessionStart', conversationId: 'conv-1', cwd: workDir });
  assert.deepEqual(h1, {});

  // 4. 另一个 agent 给 agy-worker 发 DM
  const initSender = await hiveHttpRpc(hiveUrl, null, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'sender-test', version: '1.0' },
  });
  const senderStart = await hiveHttpRpc(hiveUrl, initSender.sid, 'tools/call', {
    name: 'hive_start',
    arguments: { name: 'master-sender', tool: 'claude' },
  });
  const senderId = JSON.parse(senderStart.result.content[0].text).agent_id;

  await hiveHttpRpc(hiveUrl, initSender.sid, 'tools/call', {
    name: 'hive_dm',
    arguments: { as: senderId, to: whoami.agent_id, content: 'hello agy 1' },
  });

  const readAgentApiCalls = () => {
    try {
      return readFileSync(agentApiLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };

  const calls1 = await waitFor(() => {
    const c = readAgentApiCalls();
    return c.length >= 1 ? c : null;
  }, 6000, 'first agentapi send-message');
  assert.equal(calls1[0][0], 'send-message');
  assert.equal(calls1[0][1], '--title');
  assert.equal(calls1[0][3], 'conv-1');
  assert.match(calls1[0][4], /hive-dm-read/);

  // 5. 模拟 /clear 或 /resume → PreInvocation hook 切到 conv-2，再发第二条 DM
  const h2 = await runHook(socketPath, { hookEventName: 'PreInvocation', conversationId: 'conv-2', cwd: workDir });
  assert.deepEqual(h2, {});

  await hiveHttpRpc(hiveUrl, initSender.sid, 'tools/call', {
    name: 'hive_dm',
    arguments: { as: senderId, to: whoami.agent_id, content: 'hello agy 2' },
  });

  const calls2 = await waitFor(() => {
    const c = readAgentApiCalls();
    return c.length >= 2 ? c : null;
  }, 6000, 'second agentapi send-message on conv-2');
  assert.equal(calls2[1][3], 'conv-2');

  // 6. 停掉 relay，发第三条 DM，验证 Stop hook 兜底注入
  relay.kill('SIGTERM');
  await waitFor(async () => {
    const res = await mcp.request('tools/call', { name: 'hive-whoami', arguments: {} });
    return JSON.parse(res.content[0].text).relay_connected === false;
  }, 6000, 'relay disconnect');

  await hiveHttpRpc(hiveUrl, initSender.sid, 'tools/call', {
    name: 'hive_dm',
    arguments: { as: senderId, to: whoami.agent_id, content: 'hello fallback 3' },
  });

  await waitFor(async () => {
    const res = await mcp.request('tools/call', { name: 'hive-whoami', arguments: {} });
    return JSON.parse(res.content[0].text).pending_pushes >= 1;
  }, 6000, 'pending push buffered');

  const stopRes = await runHook(socketPath, {
    hookEventName: 'Stop',
    conversationId: 'conv-2',
    continuationActive: false,
  });
  assert.equal(stopRes.decision, 'continue');
  assert.match(stopRes.reason, /hive-dm-read/);

  console.log('PASS: test-agy-channel.mjs (all assertions succeeded)');
} finally {
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch {}
  }
  rmSync(workDir, { recursive: true, force: true });
}
