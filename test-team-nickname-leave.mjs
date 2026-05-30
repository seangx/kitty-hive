#!/usr/bin/env node
// e2e for hive_team_rename_nickname + hive_team_leave (v0.7.4).
//
// Motivated by a real user request 2026-05-30 ("赛博上坟" wanted to set her
// team nickname after joining without one, but no MCP tool existed — admin
// had to UPDATE the row directly). These tools close that gap.
//
// Scope (no external deps; isolated hive on temp DB):
//   1. rename_nickname happy path — change blank → "主策划" → event written
//   2. rename to a colliding nickname → error
//   3. rename by non-member → error
//   4. rename clears nickname (empty string)
//   5. leave team happy path — member gone + 'leave' event written
//   6. leave by non-member → error
//   7. leave by host → error (cannot orphan host duties)
//   8. re-join after leave works (and member can set a nickname)
//   9. team-events shows rename + leave entries with the right actor

import { spawn } from 'node:child_process';
import { unlinkSync, existsSync } from 'node:fs';
import { randomInt } from 'node:crypto';

const PORT = 14800 + randomInt(0, 199);
const DB_PATH = `/tmp/hive-test-teamops-${process.pid}.db`;
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
  try {
    await fn();
    ok(false, `${msg} — expected error matching ${pattern}, but call succeeded`);
  } catch (err) {
    const matched = pattern instanceof RegExp ? pattern.test(err.message) : String(err.message).includes(pattern);
    ok(matched, `${msg} — got error: ${err.message}`);
  }
}

async function run() {
  await startHive();

  // Setup: 4 agents — host, m1, m2, outsider; one team with the first three.
  const host = new HiveClient('host');
  const m1 = new HiveClient('m1');
  const m2 = new HiveClient('m2');
  const outsider = new HiveClient('outsider');
  await Promise.all([host.init(), m1.init(), m2.init(), outsider.init()]);
  await host.callTool('hive_start', { name: 'host', tool: 'claude' });
  const m1Info = await m1.callTool('hive_start', { name: 'm1', tool: 'claude' });
  const m2Info = await m2.callTool('hive_start', { name: 'm2', tool: 'claude' });
  await outsider.callTool('hive_start', { name: 'outsider', tool: 'claude' });

  const team = await host.callTool('hive_team_create', { name: 'team-ops-test' });
  // host is auto-member as host. m1 joins blank, m2 joins with nickname 'beta'.
  await m1.callTool('hive_team_join', { team_id: team.team_id });
  await m2.callTool('hive_team_join', { team_id: team.team_id, nickname: 'beta' });

  console.log('\n=== Test 1: rename happy path ===');
  const res1 = await m1.callTool('hive_team_rename_nickname', { team_id: team.team_id, nickname: '主策划' });
  ok(res1.nickname === '主策划', `nickname set to 主策划 (got ${res1.nickname})`);
  ok(res1.previous_nickname === null, `previous_nickname null (got ${JSON.stringify(res1.previous_nickname)})`);

  console.log('\n=== Test 2: rename to colliding nickname → error ===');
  await expectError(
    () => m1.callTool('hive_team_rename_nickname', { team_id: team.team_id, nickname: 'beta' }),
    /already taken/i,
    'colliding nickname rejected',
  );

  console.log('\n=== Test 3: non-member cannot rename ===');
  await expectError(
    () => outsider.callTool('hive_team_rename_nickname', { team_id: team.team_id, nickname: 'whatever' }),
    /not a member/i,
    'outsider rejected',
  );

  console.log('\n=== Test 4: rename to empty clears nickname ===');
  const res4 = await m1.callTool('hive_team_rename_nickname', { team_id: team.team_id, nickname: '' });
  ok(res4.nickname === null, `cleared to null (got ${JSON.stringify(res4.nickname)})`);
  ok(res4.previous_nickname === '主策划', `previous was 主策划 (got ${JSON.stringify(res4.previous_nickname)})`);
  // hive_teams should now show nickname null
  const teams4 = await m1.callTool('hive_teams', {});
  const meEntry = teams4.teams.find(t => t.team_id === team.team_id);
  ok(meEntry && meEntry.nickname === null, `hive_teams reflects nickname=null (got ${JSON.stringify(meEntry?.nickname)})`);

  console.log('\n=== Test 5: leave happy path ===');
  const before5 = await host.callTool('hive_team_info', { team_id: team.team_id });
  ok(before5.members.some(m => m.id === m1Info.agent_id), 'm1 is a member before leave');
  await m1.callTool('hive_team_leave', { team_id: team.team_id });
  const after5 = await host.callTool('hive_team_info', { team_id: team.team_id });
  ok(!after5.members.some(m => m.id === m1Info.agent_id), 'm1 gone after leave');

  console.log('\n=== Test 6: non-member cannot leave ===');
  await expectError(
    () => outsider.callTool('hive_team_leave', { team_id: team.team_id }),
    /not a member/i,
    'outsider rejected on leave',
  );

  console.log('\n=== Test 7: host cannot leave ===');
  await expectError(
    () => host.callTool('hive_team_leave', { team_id: team.team_id }),
    /host/i,
    'host rejected on leave',
  );

  console.log('\n=== Test 8: rejoin after leave works (with nickname) ===');
  const rejoin = await m1.callTool('hive_team_join', { team_id: team.team_id, nickname: 'm1-redux' });
  ok(rejoin.team_id === team.team_id, `rejoined team_id matches`);
  const teams8 = await m1.callTool('hive_teams', {});
  const me8 = teams8.teams.find(t => t.team_id === team.team_id);
  ok(me8 && me8.nickname === 'm1-redux', `nickname set on rejoin (got ${JSON.stringify(me8?.nickname)})`);

  console.log('\n=== Test 9: team-events shows rename + leave entries ===');
  const events = await host.callTool('hive_team_events', { team_id: team.team_id, limit: 50 });
  const renameEvents = events.events.filter(e => e.type === 'rename');
  const leaveEvents = events.events.filter(e => e.type === 'leave');
  ok(renameEvents.length >= 2, `>=2 rename events recorded (got ${renameEvents.length})`);
  ok(leaveEvents.length >= 1, `>=1 leave event recorded (got ${leaveEvents.length})`);
  const m1RenameEvents = renameEvents.filter(e => e.actor_agent_id === m1Info.agent_id);
  ok(m1RenameEvents.length >= 2, `rename events attributed to m1 (got ${m1RenameEvents.length})`);
  const m1LeaveEvent = leaveEvents.find(e => e.actor_agent_id === m1Info.agent_id);
  ok(!!m1LeaveEvent, `leave event attributed to m1 (actor_agent_id=${m1LeaveEvent?.actor_agent_id})`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(err => {
  console.error('FATAL:', err);
  cleanup();
  process.exit(1);
});
