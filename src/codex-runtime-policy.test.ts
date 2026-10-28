import assert from 'node:assert/strict';
import test from 'node:test';
import { canStopCodexRuntime, shouldWakeCodexForEvent, selectCodexBootAgents } from './codex-runtime-policy.js';
import { confirmThreadIdle } from './codex-channel-runtime.js';
import { codexChannelLaunch, stopCodexRuntime } from './codex-supervisor.js';
import * as db from './db.js';
import { sessions, agentSessions, activeSSE, eventConsumers, notifyAgents, drainPushesForAgent } from './sessions.js';
import { spawnSync } from 'node:child_process';

test('runtime stop fails closed for attached, busy, unknown and starting runtimes', () => {
  const idle = { ready: true, attachedConnections: 1, activeTask: false };
  assert.equal(canStopCodexRuntime(idle), true);
  for (const attachedConnections of [null, 0, 2, 3]) assert.equal(canStopCodexRuntime({ ...idle, attachedConnections }), false);
  assert.equal(canStopCodexRuntime({ ...idle, activeTask: true }), false);
  assert.equal(canStopCodexRuntime({ ...idle, ready: false }), false);
});

test('only enabled local automatic Codex agents wake for queued events', () => {
  const agent = { tool: 'codex', origin_peer: '', runtime_enabled: 1, event_mode: 'auto' };
  assert.equal(shouldWakeCodexForEvent(agent), true);
  for (const other of [undefined, { ...agent, event_mode: 'foreground' }, { ...agent, runtime_enabled: 0 }, { ...agent, origin_peer: 'remote' }, { ...agent, tool: 'claude' }]) {
    assert.equal(shouldWakeCodexForEvent(other), false);
  }
});

test('boot does not allocate 35 registered agents and restores only enabled background demand', () => {
  const agents = Array.from({ length: 35 }, (_, id) => ({ id: String(id), tool: 'codex', origin_peer: '', runtime_enabled: 1, event_mode: 'auto' }));
  assert.deepEqual(selectCodexBootAgents(agents, () => false), []);
  agents[1].event_mode = 'foreground';
  agents[2].runtime_enabled = 0;
  assert.deepEqual(selectCodexBootAgents(agents, id => Number(id) < 4).map(agent => agent.id), ['0', '3']);
});

test('idle probe reads metadata only and never mutates goals or interrupts turns', async () => {
  const calls: string[] = [];
  await confirmThreadIdle({ call: async (method, params) => {
    calls.push(method);
    if (method === 'thread/read') {
      assert.deepEqual(params, { threadId: 'original-thread', includeTurns: false });
      return { thread: { status: { type: 'idle' } } };
    }
    return { goal: null };
  } }, 'original-thread');
  assert.deepEqual(calls, ['thread/read', 'thread/goal/get']);
});

test('idle probe protects active, unknown, unreachable threads and active goals', async () => {
  for (const status of ['active', 'systemError', undefined]) {
    await assert.rejects(confirmThreadIdle({ call: async () => ({ thread: { status: { type: status } } }) }, 't'), /not confirmed idle/);
  }
  for (const status of ['active', 'unknown', undefined]) {
    await assert.rejects(confirmThreadIdle({ call: async method => method === 'thread/read'
      ? { thread: { status: { type: 'idle' } } } : { goal: { status } } }, 't'), /active or unknown goal/);
  }
  await assert.rejects(confirmThreadIdle({ call: async () => { throw new Error('timeout'); } }, 't'), /timeout/);
  for (const response of [null, undefined, {}, { goal: undefined }, { goal: false }, { goal: 0 }, { goal: '' }]) {
    await assert.rejects(confirmThreadIdle({ call: async method => method === 'thread/read'
      ? { thread: { status: { type: 'idle' } } } : response }, 't'), /Unknown goal response/);
  }
  await confirmThreadIdle({ call: async method => {
    if (method === 'thread/read') return { thread: { status: { type: 'idle' } } };
    throw new Error('goals feature is disabled');
  } }, 't');
});

test('channel launcher uses one Node process and the installed TypeScript loader', () => {
  const launch = codexChannelLaunch('/tmp/channel.ts');
  assert.equal(launch.command, process.execPath);
  assert.equal(launch.args[0], '--import');
  const result = spawnSync(launch.command, launch.args.slice(0, 2).concat(['--input-type=module', '-e', 'console.log(process.pid)']), { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(Number(result.stdout.trim()), result.pid);
});

test('late events never go to a retiring SSE and remain durable while waiting for replacement', async () => {
  const database = db.initDB(':memory:');
  const agent = db.createAgent('Retiring', 'codex', '', '', { eventMode: 'auto' });
  const sid = 'old-runtime-session';
  let delivered = 0;
  sessions[sid] = { server: { sendLoggingMessage: async () => { delivered++; }, server: { sendResourceUpdated() {} } } } as any;
  agentSessions.set(agent.id, new Set([sid]));
  activeSSE.add(sid);
  eventConsumers.add(sid);
  try {
    assert.equal((await stopCodexRuntime(agent.id)).ok, true);
    // A start/demand may re-enable the row before its replacement is ready.
    database.prepare('UPDATE agents SET runtime_enabled = 1 WHERE id = ?').run(agent.id);
    await notifyAgents([agent.id], undefined, JSON.stringify({ type: 'dm', event_id: 'late-event' }));
    await drainPushesForAgent(agent.id);
    assert.equal(delivered, 0);
    assert.equal(db.listPendingPushes(agent.id).length, 1);
  } finally {
    delete sessions[sid];
    agentSessions.delete(agent.id);
    activeSSE.delete(sid);
    eventConsumers.delete(sid);
    database.close();
  }
});
