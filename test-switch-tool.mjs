#!/usr/bin/env node
// v0.7.7 --switch-tool — explicit tool switching on key-matched agents
// (kitty Alt+X claude⇄codex morph, DM #1845/#1847).
//
// Two layers:
//
//   A. handleStart unit tests (import dist/ directly, temp DB):
//      1.  key match + tool change WITHOUT switchTool → refused (guard intact)
//      2.  key match + tool change WITH switchTool → applied
//      3.  switchTool does NOT unlock display_name via key path
//      4.  id match still allows tool change without the flag (unchanged trust)
//      5.  codex→claude→codex round trip preserves thread_id
//      6.  previous_tool/tool output fields correct on update & create
//      7.  fresh create with switchTool → behaves like plain create
//
//   B. CLI contract (spawn dist/index.js with --db temp file):
//      8.  register --switch-tool flips tool and prints agent_id on stdout
//      9.  register WITHOUT the flag leaves tool untouched (old-CLI silent
//          ignore semantics stay observable: exit 0, no error)
//
// No serve process needed: daemon spawn/kill notifies are best-effort fetches
// against a dead port and must not affect exit code (covered implicitly by
// test 8/9 exiting 0 with no serve running on the random port).

import { spawnSync } from 'node:child_process';
import { unlinkSync, existsSync } from 'node:fs';
import { randomInt } from 'node:crypto';

const DB_UNIT = `/tmp/hive-test-switchtool-unit-${process.pid}.db`;
const DB_CLI = `/tmp/hive-test-switchtool-cli-${process.pid}.db`;
const DEAD_PORT = 14500 + randomInt(0, 499); // nothing listens here

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.error(`  ✗ ${msg}`); fail++; }
}

function cleanup() {
  for (const base of [DB_UNIT, DB_CLI]) {
    for (const ext of ['', '-wal', '-shm']) {
      const p = base + ext;
      if (existsSync(p)) try { unlinkSync(p); } catch { /* ignore */ }
    }
  }
}
process.on('exit', cleanup);

// ---------- Layer A: handleStart unit ----------

const { initDB, getAgentById, setAgentThreadId } = await import('./dist/db.js');
initDB(DB_UNIT);
const { handleStart } = await import('./dist/tools/start.js');

console.log('\n=== A1: key match + tool change WITHOUT switchTool → refused ===');
const created = handleStart({ key: 'sess-1', name: 'morpher', tool: 'claude' });
ok(created.previous_tool === null, `create: previous_tool is null (got ${JSON.stringify(created.previous_tool)})`);
ok(created.tool === 'claude', `create: tool = ${created.tool}`);
const refused = handleStart({ key: 'sess-1', tool: 'codex' });
ok(refused.agent_id === created.agent_id, 'key matched same agent');
ok(refused.tool === 'claude', `tool unchanged without flag (got ${refused.tool})`);
ok(getAgentById(created.agent_id).tool === 'claude', 'DB row still claude');

console.log('\n=== A2: key match + tool change WITH switchTool → applied ===');
const switched = handleStart({ key: 'sess-1', tool: 'codex', switchTool: true });
ok(switched.agent_id === created.agent_id, 'same agent');
ok(switched.previous_tool === 'claude', `previous_tool = ${switched.previous_tool}`);
ok(switched.tool === 'codex', `tool now codex (got ${switched.tool})`);
ok(getAgentById(created.agent_id).tool === 'codex', 'DB row is codex');

console.log('\n=== A3: switchTool does NOT unlock display_name via key path ===');
const renamed = handleStart({ key: 'sess-1', name: 'evil-rename', tool: 'claude', switchTool: true });
ok(renamed.display_name === 'morpher', `display_name still "morpher" (got "${renamed.display_name}")`);
ok(renamed.tool === 'claude', 'tool switch itself still applied alongside refused rename');

console.log('\n=== A4: id match still allows tool change without flag ===');
const byId = handleStart({ id: created.agent_id, tool: 'codex' });
ok(byId.tool === 'codex', `id-path tool change works without flag (got ${byId.tool})`);

console.log('\n=== A5: thread_id preserved across claude⇄codex round trip ===');
setAgentThreadId(created.agent_id, 'thread-abc-123');
handleStart({ key: 'sess-1', tool: 'claude', switchTool: true });
handleStart({ key: 'sess-1', tool: 'codex', switchTool: true });
ok(getAgentById(created.agent_id).thread_id === 'thread-abc-123',
  `thread_id survives round trip (got "${getAgentById(created.agent_id).thread_id}")`);

console.log('\n=== A6: same-tool register with switchTool is a no-op ===');
const noop = handleStart({ key: 'sess-1', tool: 'codex', switchTool: true });
ok(noop.previous_tool === 'codex' && noop.tool === 'codex', 'previous_tool === tool, nothing changed');

console.log('\n=== A7: fresh create with switchTool behaves like plain create ===');
const fresh = handleStart({ key: 'sess-new', name: 'newbie', tool: 'codex', switchTool: true });
ok(fresh.previous_tool === null && fresh.tool === 'codex', 'created directly with requested tool');

// ---------- Layer B: CLI contract ----------

function cli(...extra) {
  return spawnSync('node', ['dist/index.js', 'agent', 'register',
    '--db', DB_CLI, '--port', String(DEAD_PORT), ...extra],
    { encoding: 'utf8', timeout: 15000 });
}

console.log('\n=== B8: CLI --switch-tool flips tool, exits 0, agent_id on stdout ===');
const r1 = cli('--key', 'cli-sess', '--display-name', 'cli-morpher', '--tool', 'claude');
ok(r1.status === 0, `initial register exit 0 (got ${r1.status}; stderr: ${r1.stderr?.slice(0, 200)})`);
const agentId = r1.stdout.trim();
ok(/^[0-9a-z-]+$/i.test(agentId) && agentId.length > 5, `stdout is bare agent_id ("${agentId}")`);
const r2 = cli('--key', 'cli-sess', '--tool', 'codex', '--switch-tool');
ok(r2.status === 0, `switch register exit 0 (got ${r2.status})`);
ok(r2.stdout.trim() === agentId, 'same agent_id on stdout');
ok(r2.stderr.includes('tool: claude → codex'), `stderr announces the switch (got: ${r2.stderr?.trim().split('\n')[0]})`);

console.log('\n=== B9: CLI without flag leaves tool untouched, still exit 0 ===');
const r3 = cli('--key', 'cli-sess', '--tool', 'claude');
ok(r3.status === 0, `exit 0 (got ${r3.status})`);
ok(!r3.stderr.includes('tool: codex → claude'), 'no switch announced');
ok(r3.stdout.trim() === agentId, `stdout stays bare agent_id even when refusal warn fires (got "${r3.stdout.trim().split('\n')[0]}...")`);
ok(r3.stderr.includes('refusing silent tool change'), 'refusal warn lands on stderr, not stdout');
// Verify via a follow-up switch that current tool is still codex:
const r4 = cli('--key', 'cli-sess', '--tool', 'claude', '--switch-tool');
ok(r4.stderr.includes('tool: codex → claude'), `DB still had codex before explicit switch (got: ${r4.stderr?.trim().split('\n')[0]})`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
