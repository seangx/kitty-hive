#!/usr/bin/env node
// e2e for the simple (no-workflow) task lane — hive_task_complete + the
// 'proposing' FSM gap fixes.
//
// Root incident (2026-07-15, reported via screenshot from a codex agent):
// every assigned/claimed task enters status 'proposing' (workflow proposal
// expected), but for tasks that never get a workflow the simple FSM had NO
// transitions out of 'proposing' — cancel returned "Invalid task transition"
// and completion had no tool at all. Consequence: agents were FORCED to
// propose a 1-step workflow for every trivial task (creator-approval
// round-trip each time), and stuck tasks piled up as un-cancelable shells.
//
// What we verify (real serve, temp DB, MCP over HTTP):
//   1. create assigned task → status 'proposing'
//   2. assignee hive_task_complete → completed (+ result recorded in events)
//   3. THE screenshot bug: creator cancels a workflow-less 'proposing' task
//      → canceled (no "Invalid task transition")
//   4. workflow task: complete errors with pointer to step_complete
//   5. non-assignee (creator included) cannot task_complete
//   6. unassigned 'created' task cannot be completed (invalid transition)
//   7. completed task cannot be re-completed / canceled (terminal guard)
//   8. hive_task_claim → proposing → hive_task_complete also works (claim lane)

import { spawn } from 'node:child_process';
import { unlinkSync, existsSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import Database from 'better-sqlite3';

const PORT = 15500 + randomInt(0, 99);
const DB_PATH = `/tmp/hive-test-simple-complete-${process.pid}.db`;
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

function ok(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.error(`  ✗ ${msg}`); fail++; }
}

async function startHive() {
  serverProcess = spawn('node', ['dist/index.js', 'serve', '--port', String(PORT), '--db', DB_PATH], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  const onData = d => { if (String(d).includes('listening on')) ready = true; };
  serverProcess.stdout.on('data', onData);
  serverProcess.stderr.on('data', onData);
  for (let i = 0; i < 80 && !ready; i++) await new Promise(r => setTimeout(r, 100));
  if (!ready) throw new Error('hive did not become ready');
}

let idCounter = 0;
async function mcpCall(sid, method, params) {
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
  if (sid) headers['Mcp-Session-Id'] = sid;
  const res = await fetch(BASE, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++idCounter, method, params }),
  });
  const newSid = res.headers.get('mcp-session-id');
  const text = await res.text();
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) {
      const data = JSON.parse(line.slice(5));
      if (data.error) throw new Error(JSON.stringify(data.error));
      return { sid: newSid, result: data.result };
    }
  }
  const data = JSON.parse(text);
  if (data.error) throw new Error(JSON.stringify(data.error));
  return { sid: newSid, result: data.result };
}

async function initClient() {
  const { sid } = await mcpCall(null, 'initialize', {
    protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 'simple-complete-test', version: '1.0' },
  });
  await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Mcp-Session-Id': sid },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return sid;
}

/** Call a hive tool; returns { ok, data } — data parsed from text, ok=false
 *  when the tool returned isError. */
async function tool(sid, name, args) {
  const { result } = await mcpCall(sid, 'tools/call', { name, arguments: args });
  const text = result.content[0].text;
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: !result.isError, data, text };
}

async function run() {
  await startHive();
  // IMPORTANT: one MCP session per agent. resolveAgent prefers the SESSION
  // binding over the `as` param, and hive_start binds the session — a second
  // hive_start on the same session would rebind it and silently run every
  // subsequent "as creator" call as the worker.
  const sidC = await initClient();
  const sidW = await initClient();
  const creator = (await tool(sidC, 'hive_start', { name: 'boss' })).data;
  const worker = (await tool(sidW, 'hive_start', { name: 'worker' })).data;
  ok(!!creator.agent_id && !!worker.agent_id, 'creator + worker registered');

  console.log('\n=== Test 1+2: assigned task → proposing → assignee completes ===');
  const t1 = (await tool(sidC, 'hive_task', { to: worker.agent_id, title: 'simple job' })).data;
  ok(t1.status === 'proposing', `created assigned task status=proposing (got ${t1.status})`);
  const c1 = await tool(sidW, 'hive_task_complete', { task_id: t1.task_id, result: 'did the thing' });
  ok(c1.ok && c1.data.status === 'completed', `task_complete → completed (got ${JSON.stringify(c1.data)})`);
  const chk1 = (await tool(sidC, 'hive_check', { task_id: t1.task_id })).data;
  ok(chk1.status === 'completed', `hive_check confirms completed`);
  const cursorDb = new Database(DB_PATH, { readonly: true });
  const taskCursor = cursorDb.prepare(
    "SELECT last_seq FROM read_cursors WHERE agent_id = ? AND target_type = 'task' AND target_id = ?"
  ).get(creator.agent_id, t1.task_id);
  cursorDb.close();
  ok(taskCursor?.last_seq === chk1.recent_events.at(-1).seq, 'hive_check advances the bound agent task cursor');
  const preflightRes = await fetch(`http://127.0.0.1:${PORT}/admin/push-delivery-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: creator.agent_id,
      event_id: `task:${t1.task_id}:task-assigned:1`,
      task_id: t1.task_id,
    }),
  });
  const preflight = await preflightRes.json();
  ok(preflightRes.ok && !preflight.deliver && preflight.reason === 'already_read', 'HTTP preflight suppresses stale task assignment after hive_check');
  ok(chk1.recent_events.some(e => e.type === 'task-complete' && JSON.parse(e.payload_json || '{}').result === 'did the thing'),
    'task-complete event carries result');

  console.log('\n=== Test 3: THE bug — cancel a workflow-less proposing task ===');
  const t2 = (await tool(sidC, 'hive_task', { to: worker.agent_id, title: 'doomed job' })).data;
  const c2 = await tool(sidC, 'hive_task_cancel', { task_id: t2.task_id, reason: 'changed my mind' });
  ok(c2.ok && c2.data.status === 'canceled', `cancel from proposing (no workflow) → canceled (got ${c2.text})`);

  console.log('\n=== Test 4: workflow task rejects task_complete ===');
  const t3 = (await tool(sidC, 'hive_task', { to: worker.agent_id, title: 'complex job' })).data;
  const wf = await tool(sidW, 'hive_workflow_propose', { task_id: t3.task_id, workflow: [
    { step: 1, title: 'one', assignees: [worker.agent_id], action: 'do it', completion: 'all' },
  ]});
  ok(wf.ok, 'workflow proposed');
  const c3 = await tool(sidW, 'hive_task_complete', { task_id: t3.task_id });
  ok(!c3.ok && /workflow.*step_complete/i.test(c3.text), `rejected with pointer to step_complete (got ${c3.text})`);

  console.log('\n=== Test 5: non-assignee cannot complete ===');
  const t4 = (await tool(sidC, 'hive_task', { to: worker.agent_id, title: 'not yours' })).data;
  const c4 = await tool(sidC, 'hive_task_complete', { task_id: t4.task_id });
  ok(!c4.ok && /assignee/i.test(c4.text), `creator blocked (got ${c4.text})`);

  console.log('\n=== Test 6: unassigned created task cannot be completed ===');
  const t5 = (await tool(sidC, 'hive_task', { title: 'floating job' })).data;
  ok(t5.status === 'created', `unassigned task status=created`);
  const c5 = await tool(sidW, 'hive_task_complete', { task_id: t5.task_id });
  ok(!c5.ok, `complete on unassigned rejected (got ${c5.text})`);

  console.log('\n=== Test 7: terminal guards ===');
  const c6 = await tool(sidW, 'hive_task_complete', { task_id: t1.task_id });
  ok(!c6.ok && /terminal/i.test(c6.text), `re-complete blocked (got ${c6.text})`);
  const c7 = await tool(sidC, 'hive_task_cancel', { task_id: t1.task_id });
  ok(!c7.ok && /terminal/i.test(c7.text), `cancel completed blocked (got ${c7.text})`);

  console.log('\n=== Test 8: claim lane — claim → proposing → complete ===');
  const c8 = await tool(sidW, 'hive_task_claim', { task_id: t5.task_id });
  ok(c8.ok && c8.data.status === 'proposing', `claimed → proposing (got ${JSON.stringify(c8.data.status)})`);
  const c9 = await tool(sidW, 'hive_task_complete', { task_id: t5.task_id, result: 'claimed and done' });
  ok(c9.ok && c9.data.status === 'completed', `claimed task completes without workflow`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(err => {
  console.error('FATAL:', err);
  cleanup();
  process.exit(1);
});
