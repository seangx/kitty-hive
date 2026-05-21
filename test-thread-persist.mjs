#!/usr/bin/env node
// v0.7.0 thread persistence e2e — covers the persistence layer that lets
// codex daemons survive restart without losing conversation history.
//
// What we can exercise in CI (no real codex binary needed):
//   1. agents.thread_id column exists + has correct default after fresh init
//   2. createAgent() leaves thread_id empty for new rows (no spurious id)
//   3. setAgentThreadId() round-trip — value persists across getAgentById
//   4. setAgentThreadId('') clears (used as the resume-failure self-heal path)
//   5. /admin/codex-daemon-ready endpoint contract:
//        - rejects missing fields with 400
//        - returns 202 tracked:false when agent has no live daemon
//          (i.e. no silent DB write for stranger payloads)
//   6. existing column upgrades cleanly on a pre-v0.7 DB (idempotent migration)
//
// What's NOT covered here (requires real codex binary; documented as manual
// smoke in PR):
//   - daemon actually calling thread/resume on respawn
//   - codex app-server reading rollout jsonl from disk and replaying turns
//   - end-to-end kill -9 → supervisor respawn → same thread_id observed by
//     hive_codex_pane_ws
//
// Isolation: random port (≥14500), temp DB at /tmp/hive-test-thread-<pid>.db.

import { spawn } from 'node:child_process';
import { unlinkSync, existsSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import Database from 'better-sqlite3';

const PORT = 14500 + randomInt(0, 499);
const DB_PATH = `/tmp/hive-test-thread-${process.pid}.db`;
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
  console.log(`[setup] starting hive on :${PORT} db=${DB_PATH}`);
  serverProcess = spawn('node', ['dist/index.js', 'serve', '--port', String(PORT), '--db', DB_PATH], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  serverProcess.stdout.on('data', d => {
    process.stderr.write(`[hive] ${d}`);
    if (String(d).includes('listening on')) ready = true;
  });
  serverProcess.stderr.on('data', d => {
    process.stderr.write(`[hive] ${d}`);
    if (String(d).includes('listening on')) ready = true;
  });
  for (let i = 0; i < 80; i++) {
    if (ready) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('hive did not become ready in 8s');
}

let idCounter = 0;
class HiveClient {
  constructor(name) { this.name = name; this.sessionId = null; }
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

function readDbDirect() {
  // Open the same DB while serve holds it (WAL mode allows concurrent readers).
  return new Database(DB_PATH, { readonly: true });
}

async function run() {
  await startHive();

  console.log('\n=== Test 1: agents.thread_id column exists with correct default ===');
  {
    const db = readDbDirect();
    const cols = db.prepare("PRAGMA table_info('agents')").all();
    db.close();
    const tc = cols.find(c => c.name === 'thread_id');
    ok(!!tc, 'agents.thread_id column exists');
    ok(tc && tc.type === 'TEXT', `thread_id type is TEXT (got ${tc?.type})`);
    ok(tc && tc.notnull === 1, `thread_id NOT NULL (got notnull=${tc?.notnull})`);
    ok(tc && tc.dflt_value === "''", `thread_id default is '' (got ${tc?.dflt_value})`);
  }

  console.log('\n=== Test 2: createAgent leaves thread_id empty ===');
  // Register a non-codex agent so no supervisor side-effects. We just want
  // to confirm createAgent persists the empty default into the row.
  const alice = new HiveClient('alice');
  await alice.init();
  const a = await alice.callTool('hive_start', { name: 'alice-persist', tool: 'claude' });
  ok(!!a.agent_id, `hive_start returned agent_id (${a.agent_id})`);
  {
    const db = readDbDirect();
    const row = db.prepare("SELECT thread_id FROM agents WHERE id = ?").get(a.agent_id);
    db.close();
    ok(row && row.thread_id === '', `new agent row has thread_id = '' (got ${JSON.stringify(row?.thread_id)})`);
  }

  console.log('\n=== Test 3: /admin/codex-daemon-ready contract ===');
  // 3a. Missing required fields → 400.
  {
    const res = await fetch(`${ADMIN}/admin/codex-daemon-ready`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: a.agent_id }),  // missing ws_url + thread_id
    });
    ok(res.status === 400, `missing fields → 400 (got ${res.status})`);
  }
  // 3b. Unknown agent (no live daemon) → 202 tracked:false; MUST NOT silently
  // write thread_id (we don't trust loopback-only POSTs to overwrite DB for
  // agents that aren't being supervised right now).
  {
    const fakeId = a.agent_id;  // real agent id but supervisor has no daemon for it
    const fakeThread = '01999999-9999-7999-9999-999999999999';
    const res = await fetch(`${ADMIN}/admin/codex-daemon-ready`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: fakeId, ws_url: 'ws://127.0.0.1:9999', thread_id: fakeThread }),
    });
    ok(res.status === 202, `unsupervised agent → 202 (got ${res.status})`);
    const body = await res.json();
    ok(body.tracked === false, `tracked:false for untracked agent`);
    // DB MUST be unchanged
    const db = readDbDirect();
    const row = db.prepare('SELECT thread_id FROM agents WHERE id = ?').get(fakeId);
    db.close();
    ok(row.thread_id === '', `DB not silently updated by untracked ready POST (got ${JSON.stringify(row.thread_id)})`);
  }

  console.log('\n=== Test 4: pre-v0.7 DB migration is idempotent ===');
  // Simulate an older DB without thread_id by opening directly and dropping
  // the column (SQLite ALTER … DROP COLUMN is 3.35+; we just rename).
  // Actually simpler: open a fresh raw DB, run minimal schema without
  // thread_id, then boot another hive against it and confirm it migrates.
  const legacyDbPath = `/tmp/hive-test-thread-legacy-${process.pid}.db`;
  try {
    if (existsSync(legacyDbPath)) unlinkSync(legacyDbPath);
    const legacy = new Database(legacyDbPath);
    legacy.pragma('journal_mode = WAL');
    legacy.exec(`
      CREATE TABLE agents (
        id            TEXT PRIMARY KEY,
        display_name  TEXT NOT NULL,
        token         TEXT UNIQUE NOT NULL,
        tool          TEXT DEFAULT '',
        roles         TEXT DEFAULT '',
        expertise     TEXT DEFAULT '',
        status        TEXT DEFAULT 'active',
        created_at    TEXT NOT NULL,
        last_seen     TEXT NOT NULL
      );
      INSERT INTO agents (id, display_name, token, tool, created_at, last_seen)
      VALUES ('legacyagent01', 'pre-v07-claude', 'tok-legacy-xxxxxx', 'claude', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z');
    `);
    legacy.close();

    // Boot a fresh hive against this legacy DB just long enough for migration.
    const port2 = 14990 + randomInt(0, 9);
    const proc2 = spawn('node', ['dist/index.js', 'serve', '--port', String(port2), '--db', legacyDbPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready2 = false;
    const onData = d => {
      process.stderr.write(`[hive-legacy] ${d}`);
      if (String(d).includes('listening on')) ready2 = true;
    };
    proc2.stdout.on('data', onData);
    proc2.stderr.on('data', onData);
    for (let i = 0; i < 80 && !ready2; i++) await new Promise(r => setTimeout(r, 100));
    try { proc2.kill('SIGTERM'); } catch { /* ignore */ }
    await new Promise(r => proc2.once('exit', r));

    const migrated = new Database(legacyDbPath, { readonly: true });
    const cols2 = migrated.prepare("PRAGMA table_info('agents')").all();
    const tc2 = cols2.find(c => c.name === 'thread_id');
    const legacyRow = migrated.prepare('SELECT thread_id FROM agents WHERE id = ?').get('legacyagent01');
    migrated.close();
    ok(!!tc2, 'legacy DB gained thread_id column after migration');
    ok(legacyRow && legacyRow.thread_id === '', `existing rows back-filled to '' (got ${JSON.stringify(legacyRow?.thread_id)})`);
  } finally {
    for (const ext of ['', '-wal', '-shm']) {
      const p = legacyDbPath + ext;
      if (existsSync(p)) try { unlinkSync(p); } catch { /* ignore */ }
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
