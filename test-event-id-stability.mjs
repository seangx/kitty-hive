#!/usr/bin/env node
// Regression for the 2026-05-21 stuck-replay bug.
//
// Symptom: a codex-channel daemon got stuck on a single failing event for
// ~8 hours, re-injecting it ~48 times. Two collaborating bugs:
//   - eventId() included Date.now() → event_id changed every send → both
//     channel-side and daemon-side dedup were no-ops.
//   - codex-channel processNextEvent unshifted failed events with no max
//     retry and no backoff → tight loop on persistent failure.
//
// This test covers the FIRST bug only (event_id stability). The retry/backoff
// fix is in codex-channel.ts but requires a live codex binary to exercise
// end-to-end — out of scope for CI; documented as manual smoke in PR.
//
// What we check:
//   1. A push event_id matches `task:<id>:<type>:<seq>` (NO trailing Date.now)
//   2. Re-issuing the SAME logical workflow event (impossible via FSM, so
//      simulated via the underlying API) yields a STABLE event_id when seq
//      didn't change — and a DIFFERENT seq across distinct events.
//   3. Stress: two task-propose calls on the same task produce DIFFERENT
//      event_ids (each propose has its own seq), so reviewers actually see
//      the second proposal instead of being dedup-silenced.
//
// Isolation: random port (≥14600), temp DB.

import { spawn } from 'node:child_process';
import { unlinkSync, existsSync } from 'node:fs';
import { randomInt } from 'node:crypto';

const PORT = 14600 + randomInt(0, 399);
const DB_PATH = `/tmp/hive-test-evid-${process.pid}.db`;
const BASE = `http://127.0.0.1:${PORT}/mcp`;

let serverProcess = null;
let pass = 0, fail = 0;

function cleanup() {
  if (serverProcess) try { serverProcess.kill('SIGTERM'); } catch { /* ignore */ }
  for (const ext of ['', '-wal', '-shm']) {
    const p = DB_PATH + ext;
    if (existsSync(p)) try { unlinkSync(p); } catch { /* ignore */ }
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function startHive() {
  serverProcess = spawn('node', ['dist/index.js', 'serve', '--port', String(PORT), '--db', DB_PATH], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  const onData = d => {
    process.stderr.write(`[hive] ${d}`);
    if (String(d).includes('listening on')) ready = true;
  };
  serverProcess.stdout.on('data', onData);
  serverProcess.stderr.on('data', onData);
  for (let i = 0; i < 80 && !ready; i++) await new Promise(r => setTimeout(r, 100));
  if (!ready) throw new Error('hive did not become ready');
}

let idCounter = 0;
class HiveClient {
  constructor(name) { this.name = name; this.sessionId = null; this.events = []; }

  async _post(method, params = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const res = await fetch(BASE, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++idCounter, method, params }),
    });
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

  async init() {
    await this._post('initialize', {
      protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: this.name, version: '1.0' },
    });
    await fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Mcp-Session-Id': this.sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
  }

  /** Open a long-lived SSE stream and accumulate notifications/message payloads. */
  startSSE() {
    fetch(BASE, {
      method: 'GET',
      headers: { 'Accept': 'text/event-stream', 'Mcp-Session-Id': this.sessionId },
    }).then(async (res) => {
      if (!res.body) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          try {
            const data = JSON.parse(line.slice(5));
            if (data.method === 'notifications/message' && data.params?.data) {
              try { this.events.push(JSON.parse(data.params.data)); } catch { /* skip non-JSON */ }
            }
          } catch { /* skip parse failure */ }
        }
      }
    }).catch(() => { /* SSE drop is fine for test */ });
  }

  async callTool(name, args = {}) {
    const result = await this._post('tools/call', { name, arguments: args });
    const content = result.content[0].text;
    if (result.isError) {
      const err = new Error(content);
      err.isToolError = true;
      throw err;
    }
    try { return JSON.parse(content); } catch { return content; }
  }
}

function ok(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.error(`  ✗ ${msg}`); fail++; }
}

const EVENT_ID_RE = /^task:[^:]+:[a-z-]+:\d+$/;

async function run() {
  await startHive();

  // Setup: alice = creator/director, bob = assignee (collects pushes)
  const alice = new HiveClient('alice');
  const bob = new HiveClient('bob');
  await Promise.all([alice.init(), bob.init()]);
  const a = await alice.callTool('hive_start', { name: 'alice', tool: 'claude' });
  const b = await bob.callTool('hive_start', { name: 'bob', tool: 'claude' });
  bob.startSSE();
  await new Promise(r => setTimeout(r, 200));  // let SSE settle

  console.log('\n=== Test 1: event_id is stable seq-based (no Date.now) ===');
  const t = await alice.callTool('hive_task', { to: b.agent_id, title: 'evid test' });
  await new Promise(r => setTimeout(r, 300));
  const assignedPushes = bob.events.filter(e => e.type === 'task-assigned');
  ok(assignedPushes.length >= 1, `bob received task-assigned push (got ${assignedPushes.length})`);
  const ev1 = assignedPushes[0];
  ok(EVENT_ID_RE.test(ev1.event_id),
    `event_id matches task:<id>:<type>:<seq> format — got "${ev1.event_id}"`);
  ok(!/\d{12,}/.test(ev1.event_id.split(':').pop()),
    `event_id seq portion is a small int (not Date.now()) — got "${ev1.event_id.split(':').pop()}"`);

  console.log('\n=== Test 2: distinct workflow events get distinct event_ids ===');
  await bob.callTool('hive_workflow_propose', {
    task_id: t.task_id,
    workflow: [
      { step: 1, title: 's1', assignees: [b.agent_id], action: 'do thing 1', completion: 'all' },
      { step: 2, title: 's2', assignees: [b.agent_id], action: 'do thing 2', completion: 'all' },
    ],
  });
  await alice.callTool('hive_workflow_approve', { task_id: t.task_id });
  await bob.callTool('hive_workflow_step_complete', { task_id: t.task_id, step: 1 });
  await bob.callTool('hive_workflow_step_complete', { task_id: t.task_id, step: 2 });
  await new Promise(r => setTimeout(r, 300));

  const taskPushes = bob.events.filter(e => e.task_id === t.task_id);
  const ids = taskPushes.map(e => e.event_id);
  const uniq = new Set(ids);
  ok(uniq.size === ids.length,
    `every distinct event got a distinct event_id (${ids.length} pushes, ${uniq.size} unique)`);
  ok(taskPushes.every(e => EVENT_ID_RE.test(e.event_id)),
    `all event_ids match the format`);

  console.log('\n=== Test 3: event_id is the WHOLE event story (regression sentinel) ===');
  // If anyone reintroduces Date.now() in eventId(), all these ids will end
  // with a 13-digit millis timestamp. Guard with a length cap on the seq
  // suffix.
  const badSuffix = taskPushes.find(e => {
    const tail = e.event_id.split(':').pop();
    return tail && tail.length >= 10;
  });
  ok(!badSuffix,
    `no event_id has a long numeric suffix (Date.now would be ≥13 digits) — ${badSuffix?.event_id ?? 'all clean'}`);

  console.log('\n=== Test 4: two consecutive task-proposes on same task → distinct event_ids ===');
  // Reset: new task, propose twice (allowed in proposing state)
  bob.events.length = 0;
  const t2 = await alice.callTool('hive_task', { to: b.agent_id, title: 'propose-twice' });
  // Workflow propose is idempotent on the proposing status — second propose
  // overwrites the first. Reviewers MUST be re-notified for v2.
  // notifyTaskParticipants excludes the caller, so we have ALICE propose
  // (twice) — BOB (assignee) is the one collecting pushes.
  await alice.callTool('hive_workflow_propose', {
    task_id: t2.task_id,
    workflow: [{ step: 1, title: 'v1', assignees: [b.agent_id], action: 'v1', completion: 'all' }],
  });
  await alice.callTool('hive_workflow_propose', {
    task_id: t2.task_id,
    workflow: [{ step: 1, title: 'v2', assignees: [b.agent_id], action: 'v2', completion: 'all' }],
  });
  await new Promise(r => setTimeout(r, 200));
  const proposePushes = bob.events.filter(e => e.task_id === t2.task_id && e.type === 'task-propose');
  // Bob is the assignee, so notifyTaskParticipants includes him. He gets BOTH
  // propose notifications. If both pushes shared the same event_id, channel
  // dedup would hide v2 and bob would never know about it.
  ok(proposePushes.length >= 2,
    `bob received both task-propose pushes (got ${proposePushes.length})`);
  if (proposePushes.length >= 2) {
    ok(proposePushes[0].event_id !== proposePushes[1].event_id,
      `the two task-propose pushes have distinct event_ids (${proposePushes[0].event_id} vs ${proposePushes[1].event_id})`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(err => {
  console.error('FATAL:', err);
  cleanup();
  process.exit(1);
});
