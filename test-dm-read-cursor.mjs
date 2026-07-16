#!/usr/bin/env node
// e2e for hive_dm_read marking messages read (管家's side note, DM #1978:
// dm_read fetched full content but never advanced the read cursor — only
// hive_inbox did, so unread counts accumulated for agents that read every
// message via dm_read pushes).
//
// Semantics under test (read-up-to, matching hive_inbox):
//   1. A→B msg1+msg2; B dm_read(msg1) → B inbox shows 1 unread from A (msg2)
//   2. B dm_read(msg2) → B inbox shows nothing from A
//   3. Cursor is forward-only: B dm_read(msg1) again → still nothing unread
//   4. Sender reading their own sent message does NOT touch recipient state
//   5. response carries marked_read: true for recipient, false for others

import { spawn } from 'node:child_process';
import { unlinkSync, existsSync } from 'node:fs';
import { randomInt } from 'node:crypto';

const PORT = 15600 + randomInt(0, 99);
const DB_PATH = `/tmp/hive-test-dmread-${process.pid}.db`;
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
    clientInfo: { name: 'dmread-test', version: '1.0' },
  });
  await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Mcp-Session-Id': sid },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return sid;
}

async function tool(sid, name, args) {
  const { result } = await mcpCall(sid, 'tools/call', { name, arguments: args });
  const text = result.content[0].text;
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: !result.isError, data, text };
}

/** Unread DM count that agent (via its session) sees from a given sender.
 *  NOTE: hive_inbox marks returned items read, so only call when the test
 *  step WANTS that side effect — order of assertions matters. */
async function unreadFrom(sid, senderId) {
  const inbox = (await tool(sid, 'hive_inbox', {})).data;
  if (!Array.isArray(inbox)) return 0;
  const entry = inbox.find(e => e.type === 'dm' && e.id === senderId);
  return entry ? entry.unread_count : 0;
}

async function run() {
  await startHive();
  const sidA = await initClient();
  const sidB = await initClient();
  const A = (await tool(sidA, 'hive_start', { name: 'alice' })).data;
  const B = (await tool(sidB, 'hive_start', { name: 'bob' })).data;
  ok(!!A.agent_id && !!B.agent_id, 'alice + bob registered');

  const m1 = (await tool(sidA, 'hive_dm', { to: B.agent_id, content: 'first' })).data;
  const m2 = (await tool(sidA, 'hive_dm', { to: B.agent_id, content: 'second' })).data;
  ok(m1.message_id < m2.message_id, `two DMs sent (${m1.message_id}, ${m2.message_id})`);

  console.log('\n=== 1. dm_read(msg1) leaves msg2 unread ===');
  const r1 = (await tool(sidB, 'hive_dm_read', { message_id: m1.message_id })).data;
  ok(r1.marked_read === true, `recipient read → marked_read=true (got ${r1.marked_read})`);
  // Direct DB check to avoid inbox's mark-read side effect
  const { default: Database } = await import('better-sqlite3');
  const db1 = new Database(DB_PATH, { readonly: true });
  const cur1 = db1.prepare("SELECT last_seq FROM read_cursors WHERE agent_id=? AND target_type='dm' AND target_id=?").get(B.agent_id, A.agent_id);
  db1.close();
  ok(cur1?.last_seq === m1.message_id, `cursor advanced to msg1 (got ${cur1?.last_seq})`);

  console.log('\n=== 2. dm_read(msg2) clears the rest ===');
  const r2 = (await tool(sidB, 'hive_dm_read', { message_id: m2.message_id })).data;
  ok(r2.marked_read === true, 'second read marked');
  const n2 = await unreadFrom(sidB, A.agent_id);
  ok(n2 === 0, `inbox shows 0 unread from alice (got ${n2})`);

  console.log('\n=== 3. forward-only: re-reading msg1 does not rewind ===');
  await tool(sidB, 'hive_dm_read', { message_id: m1.message_id });
  const db3 = new Database(DB_PATH, { readonly: true });
  const cur3 = db3.prepare("SELECT last_seq FROM read_cursors WHERE agent_id=? AND target_type='dm' AND target_id=?").get(B.agent_id, A.agent_id);
  db3.close();
  ok(cur3?.last_seq === m2.message_id, `cursor stays at msg2 (got ${cur3?.last_seq})`);

  console.log('\n=== 4+5. sender re-reading own message: marked_read=false, recipient unaffected ===');
  const m3 = (await tool(sidA, 'hive_dm', { to: B.agent_id, content: 'third' })).data;
  const r4 = (await tool(sidA, 'hive_dm_read', { message_id: m3.message_id })).data;
  ok(r4.marked_read === false, `sender read → marked_read=false (got ${r4.marked_read})`);
  const n4 = await unreadFrom(sidB, A.agent_id);
  ok(n4 === 1, `bob still has 1 unread (msg3) (got ${n4})`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(err => {
  console.error('FATAL:', err);
  cleanup();
  process.exit(1);
});
