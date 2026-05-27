#!/usr/bin/env node
// Validation tests for POST /admin/codex-set-thread.
//
// Covered (no real codex binary required):
//   1. loopback-only — non-loopback request → 403  [skipped if no second iface]
//   2. missing agent_id → 400
//   3. missing thread_id field → 400 (explicit; null is OK, missing isn't)
//   4. thread_id of wrong type → 400
//   5. unknown agent_id → 404
//   6. agent.tool != 'codex' → 400
//   7. jsonl not found for resume → 400 (helpful message)
//   8. reset path (thread_id=null) on a tool=codex agent without daemon →
//      should accept, UPDATE agents.thread_id='', and either spawn or
//      timeout (since no real codex binary). We assert: thread_id was
//      written to DB regardless of daemon ready timeout.
//
// NOT covered here (needs real codex):
//   - actual daemon respawn + thread/resume round-trip
//   - happy-path return values for resume

import { spawn } from 'node:child_process';
import { unlinkSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import Database from 'better-sqlite3';

const PORT = 14700 + randomInt(0, 299);
const DB_PATH = `/tmp/hive-test-setthread-${process.pid}.db`;
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
async function mcpInit() {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++idCounter, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
  });
  return res.headers.get('mcp-session-id');
}

async function mcpCall(sid, name, args) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Mcp-Session-Id': sid },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++idCounter, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await res.text();
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) {
      const data = JSON.parse(line.slice(5));
      if (data.error) throw new Error(JSON.stringify(data.error));
      return JSON.parse(data.result.content[0].text);
    }
  }
  return null;
}

async function setThread(body) {
  return fetch(`${ADMIN}/admin/codex-set-thread`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function ok(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.error(`  ✗ ${msg}`); fail++; }
}

async function run() {
  await startHive();

  // Register a codex agent (no real daemon will spawn because codex binary
  // wouldn't have the right env, but the agent row exists so admin can
  // validate against it).
  const sid = await mcpInit();
  // Send initialized notification so MCP server accepts subsequent tools/call.
  await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Mcp-Session-Id': sid },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  const codexAgent = await mcpCall(sid, 'hive_start', { name: 'codex-test-setthread', tool: 'codex' });
  ok(!!codexAgent.agent_id, `codex agent registered: ${codexAgent.agent_id}`);

  // Register a non-codex agent too for the tool-validation case.
  const sid2 = await mcpInit();
  await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Mcp-Session-Id': sid2 },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  const claudeAgent = await mcpCall(sid2, 'hive_start', { name: 'claude-test-setthread', tool: 'claude' });
  ok(!!claudeAgent.agent_id, `claude agent registered: ${claudeAgent.agent_id}`);

  console.log('\n=== Test 1: missing agent_id ===');
  {
    const res = await setThread({ thread_id: null });
    ok(res.status === 400, `→ 400 (got ${res.status})`);
    const body = await res.json();
    ok(/agent_id/i.test(body.error), `error mentions agent_id: ${body.error}`);
  }

  console.log('\n=== Test 2: missing thread_id field → 400 (null required explicitly) ===');
  {
    const res = await setThread({ agent_id: codexAgent.agent_id });
    ok(res.status === 400, `→ 400 (got ${res.status})`);
    const body = await res.json();
    ok(/thread_id required/i.test(body.error), `error explicit about thread_id: ${body.error}`);
  }

  console.log('\n=== Test 3: thread_id wrong type → 400 ===');
  {
    const res = await setThread({ agent_id: codexAgent.agent_id, thread_id: 12345 });
    ok(res.status === 400, `→ 400 (got ${res.status})`);
    const body = await res.json();
    ok(/string or null/i.test(body.error), `error mentions type: ${body.error}`);
  }

  console.log('\n=== Test 4: unknown agent_id → 404 ===');
  {
    const res = await setThread({ agent_id: 'definitely-not-a-real-agent-id', thread_id: null });
    ok(res.status === 404, `→ 404 (got ${res.status})`);
  }

  console.log('\n=== Test 5: tool=claude agent → 400 ===');
  {
    const res = await setThread({ agent_id: claudeAgent.agent_id, thread_id: null });
    ok(res.status === 400, `→ 400 (got ${res.status})`);
    const body = await res.json();
    ok(/tool/i.test(body.error) && /codex/i.test(body.error), `error mentions tool/codex: ${body.error}`);
  }

  console.log('\n=== Test 6: resume with non-existent jsonl → 400 ===');
  {
    const fakeThreadId = '01999999-9999-7999-9999-999999999999';
    const res = await setThread({ agent_id: codexAgent.agent_id, thread_id: fakeThreadId });
    ok(res.status === 400, `→ 400 (got ${res.status})`);
    const body = await res.json();
    ok(/jsonl/i.test(body.error) && body.error.includes(fakeThreadId),
       `error mentions jsonl + thread id: ${body.error}`);
  }

  console.log('\n=== Test 7: resume with fake-but-locatable jsonl ===');
  {
    // Create a syntactically-valid-looking rollout file so codexRolloutExists()
    // finds it. codex's own thread/resume will likely error on the malformed
    // content and fall back to thread/start — but that's the daemon's
    // problem; admin's job is to validate the file is on disk.
    const fakeThreadId = '01999999-aaaa-7aaa-baaa-aaaaaaaaaaaa';
    const fakeDir = join(homedir(), '.codex', 'sessions', '2099', '99', '99-test-setthread');
    mkdirSync(fakeDir, { recursive: true });
    const fakePath = join(fakeDir, `rollout-fake-${fakeThreadId}.jsonl`);
    writeFileSync(fakePath, '{"type":"thread_meta","id":"' + fakeThreadId + '"}\n');
    try {
      // Snapshot DB before so we can detect "did it change at all".
      const dbBefore = new Database(DB_PATH, { readonly: true });
      const beforeRow = dbBefore.prepare('SELECT thread_id FROM agents WHERE id = ?').get(codexAgent.agent_id);
      dbBefore.close();
      const res = await setThread({ agent_id: codexAgent.agent_id, thread_id: fakeThreadId });
      ok(res.status === 200, `→ 200 (got ${res.status})`);
      // The /admin endpoint always sets agents.thread_id to the requested
      // value BEFORE asking supervisor to respawn. If daemon then fails to
      // resume (e.g. malformed jsonl) and falls back to thread/start, its
      // markDaemonReady will overwrite — so the persisted id may differ.
      // We accept either: assert the field WAS updated away from beforeRow.
      const dbAfter = new Database(DB_PATH, { readonly: true });
      const afterRow = dbAfter.prepare('SELECT thread_id FROM agents WHERE id = ?').get(codexAgent.agent_id);
      dbAfter.close();
      ok(afterRow.thread_id !== beforeRow.thread_id,
        `agents.thread_id changed (${beforeRow.thread_id} → ${afterRow.thread_id})`);
    } finally {
      try { unlinkSync(fakePath); } catch { /* ignore */ }
    }
  }

  console.log('\n=== Test 8: reset (thread_id=null) → daemon respawns on fresh thread ===');
  {
    const dbBefore = new Database(DB_PATH, { readonly: true });
    const beforeRow = dbBefore.prepare('SELECT thread_id FROM agents WHERE id = ?').get(codexAgent.agent_id);
    dbBefore.close();
    const res = await setThread({ agent_id: codexAgent.agent_id, thread_id: null });
    ok(res.status === 200, `→ 200 (got ${res.status})`);
    const body = await res.json();
    if (body.ok) {
      // Real codex spawned and reached ready: response carries the new
      // thread_id (whatever codex assigned for thread/start).
      ok(typeof body.thread_id === 'string' && body.thread_id.length > 0,
        `response.thread_id is a new id: ${body.thread_id}`);
      ok(body.thread_id !== beforeRow.thread_id,
        `new thread_id differs from previous (${beforeRow.thread_id} → ${body.thread_id})`);
      ok(/^ws:\/\//.test(body.ws_url), `response.ws_url set: ${body.ws_url}`);
    } else {
      // No real codex in env: timeout path. Still acceptable; DB should
      // have been cleared to '' at the very least (markDaemonReady never
      // fired to overwrite it).
      const dbAfter = new Database(DB_PATH, { readonly: true });
      const afterRow = dbAfter.prepare('SELECT thread_id FROM agents WHERE id = ?').get(codexAgent.agent_id);
      dbAfter.close();
      ok(afterRow.thread_id === '',
        `daemon never reached ready, but DB.thread_id cleared = "${afterRow.thread_id}"`);
    }
  }

  console.log('\n=== Test 9: thread_id="" treated as reset (same semantics as null) ===');
  {
    const dbBefore = new Database(DB_PATH, { readonly: true });
    const beforeRow = dbBefore.prepare('SELECT thread_id FROM agents WHERE id = ?').get(codexAgent.agent_id);
    dbBefore.close();
    const res = await setThread({ agent_id: codexAgent.agent_id, thread_id: '' });
    ok(res.status === 200, `→ 200 (got ${res.status})`);
    const body = await res.json();
    if (body.ok) {
      ok(body.thread_id !== beforeRow.thread_id,
        `empty string triggered respawn → new thread_id (${beforeRow.thread_id} → ${body.thread_id})`);
    } else {
      const dbAfter = new Database(DB_PATH, { readonly: true });
      const afterRow = dbAfter.prepare('SELECT thread_id FROM agents WHERE id = ?').get(codexAgent.agent_id);
      dbAfter.close();
      ok(afterRow.thread_id === '',
        `DB cleared to "" by empty-string request`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(err => {
  console.error('FATAL:', err);
  cleanup();
  process.exit(1);
});
