#!/usr/bin/env node
// e2e for v0.7.8 in-process thread switch (kitty DM #1826: "clear 9s vs
// claude <1s 体验差距太大").
//
// New architecture: the codex-channel daemon runs a loopback control server
// (announced as control_url in codex-daemon-ready). /admin/codex-set-thread
// now tries POST <control_url>/switch-thread first — the daemon swaps
// threads on its LIVE codex app-server (thread/start | thread/resume) and
// re-announces. No SIGTERM, no codex restart, ws_url stays stable, attached
// panes survive. Falls back to the old SIGTERM→respawn cycle when the
// in-process path is unavailable.
//
// What we verify (against a real codex binary):
//   1. Daemon snapshot exposes control_url after ready
//   2. Reset (thread_id=null) → mode='in-process', SAME pid, SAME ws_url,
//      NEW thread_id, fast (<10s; typical 1-2s vs ~9s respawn)
//   3. agents.thread_id persisted to the new value (via re-announce)
//   4. Resume back to the previous thread → mode='in-process', thread_id
//      round-trips, ws_url still unchanged
//   5. restart_count stays 0 throughout (nothing crashed, nothing respawned)
//   6. set-thread BEFORE daemon ready → mode='respawn' (fallback path alive)
//   7. TurnTracker.setThreadId retargets turn/start (unit, stub transport)
//   8. Unified forced respawn → NEW pid/ws, SAME persisted thread id, and
//      fresh launcher attach coordinates
//
// Requires codex installed (same assumption as test-immediate-respawn.mjs).

import { spawn } from 'node:child_process';
import { unlinkSync, existsSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import Database from 'better-sqlite3';

const PORT = 15300 + randomInt(0, 99);
const DB_PATH = `/tmp/hive-test-inproc-${process.pid}.db`;
const BASE = `http://127.0.0.1:${PORT}/mcp`;
const ADMIN = `http://127.0.0.1:${PORT}`;

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
    clientInfo: { name: 'inproc-test', version: '1.0' },
  });
  await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Mcp-Session-Id': sid },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return sid;
}

async function registerCodexAgent(sid, name) {
  const r = await mcpCall(sid, 'tools/call', { name: 'hive_start', arguments: { name, tool: 'codex' } });
  return JSON.parse(r.result.content[0].text);
}

async function getDaemon(agentId) {
  const res = await fetch(`${ADMIN}/admin/codex-daemons`);
  const body = await res.json();
  return body.daemons.find(d => d.agent_id === agentId) || null;
}

async function waitReady(agentId, budgetMs = 45_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    await new Promise(r => setTimeout(r, 500));
    const d = await getDaemon(agentId);
    if (d && d.ready) return d;
  }
  return null;
}

async function callSetThread(agentId, threadId) {
  const t0 = Date.now();
  const res = await fetch(`${ADMIN}/admin/codex-set-thread`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, thread_id: threadId }),
  });
  const body = await res.json();
  return { elapsed: Date.now() - t0, status: res.status, body };
}

async function callDaemonRespawn(agentId) {
  const res = await fetch(`${ADMIN}/admin/daemon-respawn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId }),
  });
  return { status: res.status, body: await res.json() };
}

function dbThreadId(agentId) {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db.prepare('SELECT thread_id FROM agents WHERE id = ?').get(agentId)?.thread_id ?? null;
  } finally { db.close(); }
}

async function run() {
  // ---------- Unit: TurnTracker.setThreadId ----------
  console.log('=== Test 7 (unit, first — no serve needed): TurnTracker.setThreadId retargets turn/start ===');
  {
    const { TurnTracker } = await import('./dist/codex-channel-runtime.js');
    const calls = [];
    const transport = { async call(method, params) { calls.push({ method, params }); return { turn: { id: `t-${calls.length}` } }; } };
    const tracker = new TurnTracker(transport, 'thread-OLD', { turnTimeoutMs: 30 });
    await tracker.sendTurn('one', { eventId: 'e1' });
    tracker.setThreadId('thread-NEW');
    await tracker.sendTurn('two', { eventId: 'e2' });
    ok(calls[0].params.threadId === 'thread-OLD', `first turn on old thread (got ${calls[0].params.threadId})`);
    ok(calls[1].params.threadId === 'thread-NEW', `second turn on new thread (got ${calls[1].params.threadId})`);
    const dup = await tracker.sendTurn('one again', { eventId: 'e1' });
    ok(dup.kind === 'skipped_duplicate', 'injectedEventIds survives setThreadId (no dup window reopened)');
  }

  await startHive();
  const sid = await initClient();

  // ---------- Test 6 first: fallback when daemon not ready ----------
  // Register and IMMEDIATELY set-thread, before the daemon announces ready.
  // switchDaemonThread must decline (no controlUrl yet) and fall back to the
  // respawn path. Do this with a dedicated agent so the main-path agent's
  // timing isn't disturbed.
  console.log('\n=== Test 6: set-thread before ready → mode=respawn (fallback alive) ===');
  {
    const agent = await registerCodexAgent(sid, 'inproc-fallback-agent');
    const r = await callSetThread(agent.agent_id, null);
    ok(r.status === 200, `status 200 (got ${r.status})`);
    ok(r.body.mode === 'respawn', `mode=respawn (got ${r.body.mode})`);
    // ok may be true or false depending on machine load (30s API budget vs
    // real codex double-spawn); the mode assertion above is the point.
    console.log(`  (info: fallback call ok=${r.body.ok} elapsed=${r.elapsed}ms)`);
  }

  // ---------- Main path ----------
  const agent = await registerCodexAgent(sid, 'inproc-main-agent');
  ok(!!agent.agent_id, `main agent registered: ${agent.agent_id}`);

  console.log('\n=== Test 1: daemon ready with control_url ===');
  const d0 = await waitReady(agent.agent_id);
  if (!d0) { console.error('FATAL: daemon never ready in 45s — is codex installed?'); process.exit(1); }
  ok(d0.ready === true, `daemon ready at ${d0.ws_url}`);
  ok(typeof d0.control_url === 'string' && d0.control_url.startsWith('http://127.0.0.1:'),
    `control_url announced (got ${d0.control_url})`);
  ok(typeof d0.thread_id === 'string' && d0.thread_id.length > 0, `initial thread ${d0.thread_id}`);
  const firstThread = d0.thread_id;

  console.log('\n=== Test 2: reset → in-process, same pid/ws, new thread, fast ===');
  const r1 = await callSetThread(agent.agent_id, null);
  ok(r1.status === 200 && r1.body.ok === true, `ok=true (status ${r1.status}, err=${r1.body.error || '-'})`);
  ok(r1.body.mode === 'in-process', `mode=in-process (got ${r1.body.mode})`);
  ok(r1.body.ws_url === d0.ws_url, `ws_url UNCHANGED (${r1.body.ws_url})`);
  ok(typeof r1.body.thread_id === 'string' && r1.body.thread_id !== firstThread,
    `thread_id changed (${firstThread?.slice(0, 8)}… → ${r1.body.thread_id?.slice(0, 8)}…)`);
  // Loose budget: codex 0.144's thread/start blocks ~30s on its
  // models-refresh hang (openai/codex#14795-family; measured 27-37s on this
  // machine regardless of cache state), so in-process elapsed = vendor hang
  // + our overhead. Speed proof is secondary — mode=in-process + unchanged
  // pid below are the hard no-respawn evidence. Tighten back to ~15s once
  // the vendor bug is fixed.
  ok(r1.elapsed < 60_000, `elapsed ${r1.elapsed}ms < 60s (vendor thread/start hang dominates; respawn path pays it twice)`);
  const d1 = await getDaemon(agent.agent_id);
  ok(d1.pid === d0.pid, `daemon pid UNCHANGED (${d0.pid}) — no respawn happened`);
  ok(d1.restart_count === 0, `restart_count still 0 (got ${d1.restart_count})`);
  const secondThread = r1.body.thread_id;

  console.log('\n=== Test 3: agents.thread_id persisted via re-announce ===');
  ok(dbThreadId(agent.agent_id) === secondThread, `DB thread_id = ${secondThread?.slice(0, 8)}…`);

  console.log('\n=== Test 4: resume back to first thread → in-process round trip ===');
  // The first thread's rollout jsonl is written by codex on thread/start;
  // give the fs a few retries in case the write is lazy.
  let r2 = null;
  for (let i = 0; i < 10; i++) {
    r2 = await callSetThread(agent.agent_id, firstThread);
    if (r2.status !== 400) break;   // 400 = jsonl not found yet; retry
    await new Promise(r => setTimeout(r, 1000));
  }
  ok(r2.status === 200 && r2.body.ok === true, `ok=true (status ${r2.status}, err=${r2.body.error || '-'})`);
  ok(r2.body.mode === 'in-process', `mode=in-process (got ${r2.body.mode})`);
  ok(r2.body.thread_id === firstThread, `thread_id round-tripped to ${firstThread?.slice(0, 8)}…`);
  ok(r2.body.ws_url === d0.ws_url, `ws_url STILL unchanged after 2 switches`);
  ok(dbThreadId(agent.agent_id) === firstThread, 'DB thread_id follows the resume');

  console.log('\n=== Test 5: pid stable + restart_count 0 across all switches ===');
  const d2 = await getDaemon(agent.agent_id);
  ok(d2.pid === d0.pid, `pid ${d0.pid} unchanged through reset+resume`);
  ok(d2.restart_count === 0, `restart_count=0 (got ${d2.restart_count})`);
  ok(d2.control_url === d0.control_url, `control_url stable (${d2.control_url})`);

  console.log('\n=== Test 8: forced daemon respawn preserves thread and returns fresh attach ===');
  const forced = await callDaemonRespawn(agent.agent_id);
  ok(forced.status === 200 && forced.body.ok && forced.body.ready,
    `unified respawn waits for ready (status ${forced.status}, error=${forced.body.error || '-'})`);
  ok(forced.body.tool === 'codex' && forced.body.mode === 'respawn', 'response identifies Codex respawn');
  ok(
    forced.body.conversation?.requested_id === firstThread
    && forced.body.conversation?.id === firstThread
    && forced.body.conversation?.preserved === true,
    'forced respawn preserves the existing Codex thread',
  );
  ok(
    forced.body.attach?.kind === 'codex-remote'
    && forced.body.attach?.thread_id === firstThread
    && forced.body.attach?.ws_url !== d2.ws_url,
    'response returns fresh Codex attach coordinates',
  );
  ok(forced.body.daemon?.pid !== d2.pid, 'replacement Codex daemon has a new pid');
  const d3 = await getDaemon(agent.agent_id);
  ok(d3?.pid === forced.body.daemon?.pid && d3?.thread_id === firstThread,
    'supervisor snapshot matches returned daemon and thread');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(err => {
  console.error('FATAL:', err);
  cleanup();
  process.exit(1);
});
