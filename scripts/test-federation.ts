#!/usr/bin/env tsx
/**
 * End-to-end federation test.
 *
 * Spawns two hive servers in temp dirs, peers them, and walks through:
 *   - ping handshake
 *   - remote.agents listing
 *   - DM alice→bob, bob→alice
 *   - task alice→bob, propose, approve, step-complete
 *
 * Usage:  bun run scripts/test-federation.ts
 *    or:  npx tsx scripts/test-federation.ts
 */

import { spawn, ChildProcess, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const HIVE_BIN = join(ROOT, 'dist', 'index.js');
const PORT_A = 4191, PORT_B = 4192;
const NAME_A = 'alice-node', NAME_B = 'bob-node';

const SHARED_SECRET = 'sk_test_' + Math.random().toString(36).slice(2);

type Json = any;
let stepNum = 0;
function step(msg: string) {
  stepNum++;
  console.log(`\n\x1b[1;36m[${stepNum}] ${msg}\x1b[0m`);
}
function pass(msg: string) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
function fail(msg: string): never {
  console.log(`  \x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
}

function ensureBuilt() {
  if (!existsSync(HIVE_BIN)) {
    console.log('Building dist/...');
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  }
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(url: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url, { method: 'GET' }); if (r.status < 500) return; } catch {}
    await sleep(100);
  }
  throw new Error(`server at ${url} not ready within ${timeoutMs}ms`);
}

function spawnHive(name: string, port: number, dir: string): ChildProcess {
  // No --db: rely on HOME so CLI and serve resolve to same ~/.kitty-hive/hive.db
  const child = spawn('node', [HIVE_BIN, 'serve', '--port', String(port)], {
    env: { ...process.env, HOME: dir, USERPROFILE: dir },
    cwd: ROOT, stdio: 'ignore',
  });
  child.on('error', err => console.error(`[${name}] spawn error:`, err));
  return child;
}

function setNodeName(dir: string, name: string) {
  // The CLI reads ~/.kitty-hive/config.json; with HOME=dir, it'll write to dir/.kitty-hive/config.json
  execFileSync('node', [HIVE_BIN, 'config', 'set', 'name', name], {
    env: { ...process.env, HOME: dir, USERPROFILE: dir },
    cwd: ROOT, stdio: 'pipe',
  });
}

// --- Tiny MCP client ---

class MCP {
  private sessionId: string | null = null;
  private rpcId = 0;
  constructor(public baseUrl: string) {}

  private async post(method: string, params: any = {}, _retried = false): Promise<any> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    if (this.sessionId && method !== 'initialize') headers['Mcp-Session-Id'] = this.sessionId;
    const res = await fetch(this.baseUrl, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.rpcId, method, params }),
    });
    if (res.status === 404 && !_retried && method !== 'initialize') {
      this.sessionId = null;
      await this.init();
      return this.post(method, params, true);
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
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

  async init(): Promise<void> {
    this.sessionId = null;
    await this.post('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-fed', version: '1.0' },
    });
    await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Mcp-Session-Id': this.sessionId!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
  }

  async call(name: string, args: Json = {}): Promise<Json> {
    const result = await this.post('tools/call', { name, arguments: args });
    const text = result.content[0].text;
    if (result.isError) throw new Error(text);
    try { return JSON.parse(text); } catch { return text; }
  }
}

// --- Test ---

async function main() {
  ensureBuilt();

  const dirA = mkdtempSync(join(tmpdir(), 'hive-a-'));
  const dirB = mkdtempSync(join(tmpdir(), 'hive-b-'));
  let procA: ChildProcess | null = null, procB: ChildProcess | null = null;

  const cleanup = () => {
    procA?.kill('SIGTERM'); procB?.kill('SIGTERM');
    setTimeout(() => {
      try { rmSync(dirA, { recursive: true, force: true }); } catch {}
      try { rmSync(dirB, { recursive: true, force: true }); } catch {}
    }, 200);
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  step(`set node names: ${NAME_A} (port ${PORT_A}), ${NAME_B} (port ${PORT_B})`);
  setNodeName(dirA, NAME_A);
  setNodeName(dirB, NAME_B);

  step('boot two hive servers');
  procA = spawnHive('A', PORT_A, dirA);
  procB = spawnHive('B', PORT_B, dirB);
  await waitFor(`http://localhost:${PORT_A}/mcp`);
  await waitFor(`http://localhost:${PORT_B}/mcp`);
  pass(`both servers up`);

  const mcpA = new MCP(`http://localhost:${PORT_A}/mcp`);
  const mcpB = new MCP(`http://localhost:${PORT_B}/mcp`);
  await mcpA.init(); await mcpB.init();

  step('register users: alice on A, bob on B');
  const alice = await mcpA.call('hive.start', { name: 'alice', tool: 'test' });
  const bob = await mcpB.call('hive.start', { name: 'bob', tool: 'test' });
  if (!alice.agent_id || !bob.agent_id) fail('missing agent ids');
  pass(`alice=${alice.agent_id.slice(0,8)} bob=${bob.agent_id.slice(0,8)}`);

  step('cross-add peers with shared secret');
  // On A: peer named "B-peer" pointing at hive B, expose alice (so B can interact with alice)
  execFileSync('node', [HIVE_BIN, 'peer', 'add', 'bob-peer', `http://localhost:${PORT_B}/mcp`,
    '--secret', SHARED_SECRET, '--expose', alice.agent_id],
    { env: { ...process.env, HOME: dirA }, cwd: ROOT, stdio: 'pipe' });
  // On B: peer named "alice-peer" pointing at hive A, expose bob
  execFileSync('node', [HIVE_BIN, 'peer', 'add', 'alice-peer', `http://localhost:${PORT_A}/mcp`,
    '--secret', SHARED_SECRET, '--expose', bob.agent_id],
    { env: { ...process.env, HOME: dirB }, cwd: ROOT, stdio: 'pipe' });
  pass('peers configured');

  step('ping handshake (via hive.peers + manual)');
  const peersA = await mcpA.call('hive.peers');
  if (!Array.isArray(peersA) || peersA.length !== 1) fail(`expected 1 peer on A, got ${JSON.stringify(peersA)}`);
  const peersB = await mcpB.call('hive.peers');
  if (!Array.isArray(peersB) || peersB.length !== 1) fail(`expected 1 peer on B, got ${JSON.stringify(peersB)}`);
  pass(`peers visible from both sides`);

  step('hive.remote.agents from A → B');
  const remoteB = await mcpA.call('hive.remote.agents', { peer: 'bob-peer', fresh: true });
  if (!remoteB.agents || !remoteB.agents.find((a: any) => a.id === bob.agent_id))
    fail(`expected bob in remote agents, got ${JSON.stringify(remoteB)}`);
  pass(`saw bob via federation`);

  step('DM alice → bob via id@peer');
  await mcpA.call('hive.dm', { as: alice.agent_id, to: `${bob.agent_id}@bob-peer`, content: 'hello bob' });
  await sleep(150);
  const inboxBob = await mcpB.call('hive.inbox', { as: bob.agent_id });
  const dmFromAlice = inboxBob.find((u: any) => u.kind === 'dm' && u.unread_count > 0 && u.latest.some((l: any) => l.preview.includes('hello bob')));
  if (!dmFromAlice) fail(`bob did not receive DM: ${JSON.stringify(inboxBob)}`);
  pass(`bob saw DM from alice`);

  step('bob replies via local placeholder for alice');
  // bob sees a placeholder agent for alice in his DB; he can DM that placeholder.
  // We use "alice-peer" as the node, alice.agent_id as the remote id.
  await mcpB.call('hive.dm', { as: bob.agent_id, to: `${alice.agent_id}@alice-peer`, content: 'hello alice' });
  await sleep(150);
  const inboxAlice = await mcpA.call('hive.inbox', { as: alice.agent_id });
  const dmFromBob = inboxAlice.find((u: any) => u.kind === 'dm' && u.latest.some((l: any) => l.preview.includes('hello alice')));
  if (!dmFromBob) fail(`alice did not receive reply: ${JSON.stringify(inboxAlice)}`);
  pass(`alice saw reply from bob`);

  step('alice delegates task to bob');
  const task = await mcpA.call('hive.task', { as: alice.agent_id, to: `${bob.agent_id}@bob-peer`, title: 'review PR' });
  if (!task.task_id) fail(`task creation failed: ${JSON.stringify(task)}`);
  pass(`shadow task on alice id=${task.task_id.slice(0,8)} status=${task.status}`);
  await sleep(150);

  // Bob should see a real task with the same title and originator_peer set
  const bobTasks = await mcpB.call('hive.tasks', { as: bob.agent_id });
  const bobTask = bobTasks.find((t: any) => t.title === 'review PR');
  if (!bobTask) fail(`bob did not see task: ${JSON.stringify(bobTasks)}`);
  pass(`bob sees task ${bobTask.task_id.slice(0,8)} status=${bobTask.status}`);

  step('bob proposes workflow');
  await mcpB.call('hive.workflow.propose', {
    as: bob.agent_id, task_id: bobTask.task_id,
    workflow: [
      { step: 1, title: 'review code', assignees: [bob.agent_id], action: 'review', completion: 'all' },
    ],
  });
  await sleep(200);
  // Alice's shadow task should also have a workflow recorded
  const aliceCheck = await mcpA.call('hive.check', { task_id: task.task_id });
  if (!aliceCheck.workflow || aliceCheck.workflow.steps.length !== 1) fail(`alice did not see proposed workflow: ${JSON.stringify(aliceCheck)}`);
  pass(`alice's shadow task got the proposed workflow`);

  step('alice approves the workflow');
  await mcpA.call('hive.workflow.approve', { as: alice.agent_id, task_id: task.task_id });
  await sleep(200);
  // Bob's task should now be in_progress
  const bobCheck1 = await mcpB.call('hive.check', { task_id: bobTask.task_id });
  if (bobCheck1.status !== 'in_progress') fail(`bob's task not in_progress: ${JSON.stringify(bobCheck1)}`);
  pass(`bob's task is in_progress`);

  step('bob completes step 1');
  await mcpB.call('hive.workflow.step.complete', { as: bob.agent_id, task_id: bobTask.task_id, step: 1, result: 'LGTM' });
  await sleep(200);
  // Both sides should be completed
  const bobCheck2 = await mcpB.call('hive.check', { task_id: bobTask.task_id });
  const aliceCheck2 = await mcpA.call('hive.check', { task_id: task.task_id });
  if (bobCheck2.status !== 'completed') fail(`bob's task not completed: ${JSON.stringify(bobCheck2)}`);
  if (aliceCheck2.status !== 'completed') fail(`alice's shadow task not completed: ${JSON.stringify(aliceCheck2)}`);
  pass(`task completed on both sides`);

  console.log('\n\x1b[1;32m✓ all federation flows verified\x1b[0m');
  process.exit(0);
}

main().catch(err => {
  console.error('\n\x1b[31mTEST FAILED:\x1b[0m', err);
  process.exit(1);
});
