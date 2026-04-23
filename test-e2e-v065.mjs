#!/usr/bin/env node
// v0.6.5 e2e — protocol-level coverage for:
//   1. step.action.maxLength(400) schema enforcement
//   2. findAgentByRole double-layer (roles → display_name fallback)
//   3. role:xxx team-scoped lookup when source_team_id is set
//   4. hive_tasks team filter + member auth (403 for non-members)
//   5. hive_update_role add/remove (idempotent, dedup, sorted)
//
// CRITICAL: this test runs against an isolated hive instance:
//   - random port (>= 14000)
//   - temp DB at /tmp/hive-test-v065-<pid>.db
//   - DB is deleted on exit
// It MUST NOT touch ~/.kitty-hive/hive.db or default port 4123.

import { spawn } from 'node:child_process';
import { unlinkSync, existsSync } from 'node:fs';
import { randomInt } from 'node:crypto';

const PORT = 14000 + randomInt(0, 999);
const DB_PATH = `/tmp/hive-test-v065-${process.pid}.db`;
const BASE = `http://127.0.0.1:${PORT}/mcp`;

let serverProcess = null;
let idCounter = 0;
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
  serverProcess.stderr.on('data', d => process.stderr.write(`[hive] ${d}`));
  // Wait for the "listening" line, with a hard cap
  for (let i = 0; i < 80; i++) {
    if (ready) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('hive did not become ready in 8s');
}

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
      // Schema-validation errors come back through isError
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

async function run() {
  await startHive();

  // --- Setup: 4 agents (alice, bob, alpha-tester, beta-tester) + 1 team ---
  const alice = new HiveClient('alice');
  const bob = new HiveClient('bob');
  const alphaT = new HiveClient('alpha');
  const betaT = new HiveClient('beta');
  await Promise.all([alice.init(), bob.init(), alphaT.init(), betaT.init()]);

  const a = await alice.callTool('hive_start', { name: 'alice', tool: 'claude' });
  const b = await bob.callTool('hive_start', { name: 'bob', tool: 'claude' });
  const at = await alphaT.callTool('hive_start', { name: 'alpha-tester', tool: 'claude' });
  const bt = await betaT.callTool('hive_start', { name: 'beta-tester', tool: 'claude' });

  console.log('\n=== Test 1: step.action.maxLength(400) schema enforcement ===');
  // First, set up a task so we have something to propose against
  const setupTask = await alice.callTool('hive_task', { to: b.agent_id, title: 'len test' });
  // 401-char action should fail
  const longAction = 'x'.repeat(401);
  let rejected = false;
  try {
    await bob.callTool('hive_workflow_propose', {
      task_id: setupTask.task_id,
      workflow: [{ step: 1, title: 's', assignees: [b.agent_id], action: longAction, completion: 'all' }],
    });
  } catch (err) {
    rejected = err.isToolError || /400|max|length/i.test(err.message);
  }
  ok(rejected, '401-char action is rejected by schema');

  // 400-char action should pass
  const okAction = 'x'.repeat(400);
  let accepted = false;
  try {
    await bob.callTool('hive_workflow_propose', {
      task_id: setupTask.task_id,
      workflow: [{ step: 1, title: 's', assignees: [b.agent_id], action: okAction, completion: 'all' }],
    });
    accepted = true;
  } catch (err) {
    console.error('  unexpected reject:', err.message);
  }
  ok(accepted, '400-char action is accepted');

  console.log('\n=== Test 2: findAgentByRole display_name fallback ===');
  // alpha-tester has roles='' but display_name contains "tester"
  // Create a task with role:tester — should resolve to alpha-tester (most-recent active match)
  const t2 = await alice.callTool('hive_task', { to: 'role:tester', title: 'fallback test' });
  // Either alpha-tester or beta-tester could match — both qualify. Just need ONE of them.
  ok(t2.assignee && (t2.assignee.id === at.agent_id || t2.assignee.id === bt.agent_id),
     `role:tester resolved to a tester via display_name fallback (got ${t2.assignee?.display_name})`);

  console.log('\n=== Test 3: role:xxx team-scoped (source_team_id) ===');
  // Create a team containing alice + alphaT only. Then create task with source_team_id and role:tester.
  // Should resolve to alpha-tester (in team), NOT beta-tester (outside team).
  const team = await alice.callTool('hive_team_create', { name: 'team-A' });
  await alphaT.callTool('hive_team_join', { name: 'team-A' });

  const t3 = await alice.callTool('hive_task', {
    to: 'role:tester', title: 'team-scoped test', source_team_id: team.team_id,
  });
  ok(t3.assignee?.id === at.agent_id,
     `role:tester with source_team_id picked alpha-tester (in team) not beta-tester (got ${t3.assignee?.display_name})`);

  console.log('\n=== Test 4: hive_tasks team filter + auth ===');
  // Alice (member) → can see team tasks
  const aliceView = await alice.callTool('hive_tasks', { team: 'team-A' });
  ok(Array.isArray(aliceView) && aliceView.some(t => t.id === t3.task_id),
     `alice (member) sees team-A task in hive_tasks(team='team-A')`);

  // Bob (non-member) → 403 (returned as JSON {error: ...})
  const bobView = await bob.callTool('hive_tasks', { team: 'team-A' });
  ok(bobView && bobView.error && /not a member/i.test(bobView.error),
     `bob (non-member) gets error: ${bobView.error}`);

  // Verify projection: returned rows should NOT contain workflow_json or task_events
  const sample = aliceView[0];
  const forbiddenFields = ['workflow_json', 'task_events', 'input_json', 'workflow'];
  const leaked = forbiddenFields.filter(f => f in sample);
  ok(leaked.length === 0,
     `list projection strips heavy fields (no leak of: ${forbiddenFields.join(', ')})`);
  ok('step' in sample && 'creator' in sample && 'assignee' in sample,
     `list projection includes expected fields (step/creator/assignee)`);

  console.log('\n=== Test 5: hive_update_role add/remove ===');
  let r5 = await alphaT.callTool('hive_update_role', { add: ['tester', 'reviewer'] });
  ok(r5.new_roles === 'reviewer,tester', `add ['tester','reviewer'] → roles="${r5.new_roles}" (sorted, deduped)`);

  // Add 'tester' again — should not duplicate
  r5 = await alphaT.callTool('hive_update_role', { add: ['tester'] });
  ok(r5.new_roles === 'reviewer,tester', `add 'tester' again is idempotent → "${r5.new_roles}"`);

  // Remove 'tester' → should leave 'reviewer'
  r5 = await alphaT.callTool('hive_update_role', { remove: ['tester'] });
  ok(r5.new_roles === 'reviewer', `remove 'tester' → "${r5.new_roles}"`);

  // Comma-in-string should split
  r5 = await alphaT.callTool('hive_update_role', { add: ['frontend,backend'] });
  ok(r5.new_roles === 'backend,frontend,reviewer',
     `add ['frontend,backend'] (comma in string) splits → "${r5.new_roles}"`);

  // Now that alphaT has explicit roles=tester... wait, we removed tester. Let's verify
  // roles match takes priority over display_name fallback by giving alphaT 'reviewer'
  // and asking for role:reviewer (no one's display_name has "reviewer" → must come from roles).
  const t5 = await alice.callTool('hive_task', { to: 'role:reviewer', title: 'priority test' });
  ok(t5.assignee?.id === at.agent_id,
     `role:reviewer matches alphaT via explicit roles field (got ${t5.assignee?.display_name})`);

  console.log('\n=== Test 6: step accepts string (LLM quote-mistake tolerance, v0.6.7) ===');
  // LLMs sometimes quote numbers in tool calls. z.coerce.number() accepts both.
  const t6 = await alice.callTool('hive_task', { to: bt.agent_id, title: 'coerce test' });
  // Propose a workflow with step as STRING (simulating buggy LLM output)
  let acceptedString = false;
  try {
    await betaT.callTool('hive_workflow_propose', {
      task_id: t6.task_id,
      workflow: [{ step: '1', title: 's', assignees: [bt.agent_id], action: 'go', completion: 'all' }],
    });
    acceptedString = true;
  } catch (err) {
    console.error('  unexpected reject on step="1":', err.message);
  }
  ok(acceptedString, 'workflow_propose accepts step as string "1" (coerced to number)');

  // Approve, then complete with step as STRING
  await alice.callTool('hive_workflow_approve', { task_id: t6.task_id });
  let completed = false;
  try {
    await betaT.callTool('hive_workflow_step_complete', { task_id: t6.task_id, step: '1', result: 'ok' });
    completed = true;
  } catch (err) {
    console.error('  unexpected reject on step="1" complete:', err.message);
  }
  ok(completed, 'workflow_step_complete accepts step as string "1" (coerced to number)');

  console.log(`\n=== Done: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(2);
});
