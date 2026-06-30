#!/usr/bin/env node
// e2e for `kitty-hive team close / reopen / delete` operator commands.
//
// Drives the CLI as a subprocess against an isolated hive (random port,
// temp DB). Verifies:
//   1. close — sets closed_at, MCP-side join is rejected after
//   2. reopen — clears closed_at, MCP join works again
//   3. delete on an active team — rejected (must close first)
//   4. close + delete — team row + members + events all wiped
//   5. close idempotency — closing an already-closed team is a no-op success
//   6. close with --yes works without prompt (non-interactive)
//   7. team commands resolve team by id AND by name

import { spawn } from 'node:child_process';
import { unlinkSync, existsSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import Database from 'better-sqlite3';

const PORT = 14900 + randomInt(0, 99);
const DB_PATH = `/tmp/hive-test-teamcli-${process.pid}.db`;
const BASE = `http://127.0.0.1:${PORT}/mcp`;
const CLI = ['node', 'dist/index.js'];

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

function runCli(...cmdArgs) {
  return new Promise((resolve) => {
    const child = spawn(CLI[0], [...CLI.slice(1), ...cmdArgs, '--db', DB_PATH], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
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

async function expectError(fn, pattern, msg) {
  try { await fn(); ok(false, `${msg} — expected error, succeeded`); }
  catch (err) {
    const matched = pattern instanceof RegExp ? pattern.test(err.message) : String(err.message).includes(pattern);
    ok(matched, `${msg} — got: ${err.message}`);
  }
}

async function run() {
  await startHive();

  // Setup: host + 2 members + 1 outsider
  const host = new HiveClient('host');
  const m1 = new HiveClient('m1');
  const outsider = new HiveClient('outsider');
  await Promise.all([host.init(), m1.init(), outsider.init()]);
  const hostInfo = await host.callTool('hive_start', { name: 'host', tool: 'claude' });
  await m1.callTool('hive_start', { name: 'm1', tool: 'claude' });
  await outsider.callTool('hive_start', { name: 'outsider', tool: 'claude' });

  const team = await host.callTool('hive_team_create', { name: 'cli-ops-test' });
  await m1.callTool('hive_team_join', { team_id: team.team_id });

  console.log('\n=== Test 1: close active team via CLI (--yes, by id) ===');
  {
    const r = await runCli('team', 'close', team.team_id, '--yes');
    ok(r.code === 0, `exit 0 (got ${r.code}); stderr=${r.stderr.slice(0, 200)}`);
    ok(/Closed team/.test(r.stdout), `stdout confirms close: ${r.stdout.trim()}`);
    // Verify DB
    const db = new Database(DB_PATH, { readonly: true });
    const row = db.prepare('SELECT closed_at FROM teams WHERE id = ?').get(team.team_id);
    db.close();
    ok(row.closed_at != null, `closed_at set in DB (got ${row.closed_at})`);
  }

  console.log('\n=== Test 2: closed team rejects MCP join ===');
  await expectError(
    () => outsider.callTool('hive_team_join', { team_id: team.team_id }),
    /closed/i,
    'outsider join rejected on closed team',
  );

  console.log('\n=== Test 3: closed team rejects MCP message ===');
  await expectError(
    () => host.callTool('hive_team_message', { team_id: team.team_id, content: 'should fail' }),
    /closed/i,
    'team_message rejected on closed team',
  );

  console.log('\n=== Test 4: reopen via CLI ===');
  {
    const r = await runCli('team', 'reopen', team.team_id, '--yes');
    ok(r.code === 0, `exit 0 (got ${r.code})`);
    ok(/Reopened team/.test(r.stdout), `stdout confirms reopen: ${r.stdout.trim()}`);
    // MCP join now works
    const outsider2 = new HiveClient('outsider2');
    await outsider2.init();
    await outsider2.callTool('hive_start', { name: 'outsider2', tool: 'claude' });
    const join = await outsider2.callTool('hive_team_join', { team_id: team.team_id });
    ok(join.team_id === team.team_id, `outsider2 join succeeded after reopen`);
  }

  console.log('\n=== Test 5: delete active team rejected ===');
  {
    const r = await runCli('team', 'delete', team.team_id, '--yes');
    ok(r.code !== 0, `exit non-zero (got ${r.code})`);
    ok(/still active/i.test(r.stderr) || /Close it first/i.test(r.stderr),
      `stderr says must close first: ${r.stderr.slice(0, 200)}`);
  }

  console.log('\n=== Test 6: close + delete cascade wipes everything ===');
  {
    await runCli('team', 'close', team.team_id, '--yes');
    // Pre-delete: rows exist
    const db = new Database(DB_PATH, { readonly: true });
    const memCount = db.prepare('SELECT COUNT(*) as n FROM team_members WHERE team_id = ?').get(team.team_id).n;
    const evCount = db.prepare('SELECT COUNT(*) as n FROM team_events WHERE team_id = ?').get(team.team_id).n;
    db.close();
    ok(memCount > 0, `pre-delete: team_members count > 0 (got ${memCount})`);
    ok(evCount > 0, `pre-delete: team_events count > 0 (got ${evCount})`);

    const r = await runCli('team', 'delete', team.team_id, '--yes');
    ok(r.code === 0, `delete exit 0 (got ${r.code})`);
    ok(/Deleted team/.test(r.stdout), `stdout confirms: ${r.stdout.trim()}`);

    const db2 = new Database(DB_PATH, { readonly: true });
    const t = db2.prepare('SELECT * FROM teams WHERE id = ?').get(team.team_id);
    const mems = db2.prepare('SELECT COUNT(*) as n FROM team_members WHERE team_id = ?').get(team.team_id).n;
    const evs = db2.prepare('SELECT COUNT(*) as n FROM team_events WHERE team_id = ?').get(team.team_id).n;
    db2.close();
    ok(!t, `teams row gone`);
    ok(mems === 0, `team_members rows gone (got ${mems})`);
    ok(evs === 0, `team_events rows gone (got ${evs})`);
  }

  console.log('\n=== Test 7: close idempotent (closing already-closed = no-op success) ===');
  {
    // Create + close one
    const t = await host.callTool('hive_team_create', { name: 'idem-test' });
    await runCli('team', 'close', t.team_id, '--yes');
    // Close again
    const r = await runCli('team', 'close', t.team_id, '--yes');
    ok(r.code === 0, `second close exit 0 (got ${r.code})`);
    ok(/already closed/i.test(r.stdout), `stdout reports already closed: ${r.stdout.trim()}`);
    // Cleanup
    await runCli('team', 'delete', t.team_id, '--yes');
  }

  console.log('\n=== Test 8: resolve team by name (not just id) ===');
  {
    const t = await host.callTool('hive_team_create', { name: 'by-name-test' });
    const r = await runCli('team', 'close', 'by-name-test', '--yes');
    ok(r.code === 0, `close by name exit 0`);
    ok(/Closed team/.test(r.stdout), `by-name resolution works: ${r.stdout.trim()}`);
    await runCli('team', 'delete', t.team_id, '--yes');
  }

  console.log('\n=== Test 9: nonexistent team → error ===');
  {
    const r = await runCli('team', 'close', 'definitely-not-a-team', '--yes');
    ok(r.code !== 0, `nonexistent → exit non-zero (got ${r.code})`);
    ok(/not found/i.test(r.stderr), `stderr says not found: ${r.stderr.slice(0, 200)}`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(err => {
  console.error('FATAL:', err);
  cleanup();
  process.exit(1);
});
