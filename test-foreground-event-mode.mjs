#!/usr/bin/env node

import { randomInt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import Database from 'better-sqlite3';

const DB = `/tmp/hive-test-foreground-mode-${process.pid}.db`;
const DEAD_PORT = 17000 + randomInt(0, 500);
let pass = 0;
let fail = 0;

function ok(condition, message) {
  if (condition) { console.log(`  ✓ ${message}`); pass++; }
  else { console.error(`  ✗ ${message}`); fail++; }
}

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    const path = DB + suffix;
    if (existsSync(path)) try { unlinkSync(path); } catch { /* ignore */ }
  }
}
process.on('exit', cleanup);

function runCli(...argv) {
  return spawnSync(process.execPath, ['dist/index.js', ...argv, '--db', DB, '--port', String(DEAD_PORT)], {
    encoding: 'utf8', timeout: 15_000,
  });
}

console.log('\n=== Register a foreground-owned Codex agent ===');
const registered = runCli(
  'agent', 'register',
  '--key', 'kitty-foreground-test',
  '--display-name', 'foreground-test',
  '--tool', 'codex',
  '--event-mode', 'foreground',
);
ok(registered.status === 0, `register exits 0 (stderr=${registered.stderr.trim()})`);
const agentId = registered.stdout.trim();
ok(agentId.length > 0, 'register returns an agent id');

let db = new Database(DB, { readonly: true });
let row = db.prepare('SELECT event_mode FROM agents WHERE id = ?').get(agentId);
db.close();
ok(row?.event_mode === 'foreground', 'foreground mode persists in agents.event_mode');

console.log('\n=== Operator can switch the same agent back to auto ===');
const switched = runCli('agent', 'event-mode', agentId, 'auto');
ok(switched.status === 0, `event-mode exits 0 (stderr=${switched.stderr.trim()})`);
db = new Database(DB, { readonly: true });
row = db.prepare('SELECT event_mode FROM agents WHERE id = ?').get(agentId);
db.close();
ok(row?.event_mode === 'auto', 'event-mode command writes and re-reads auto');

console.log('\n=== Invalid modes fail closed ===');
const invalid = runCli('agent', 'event-mode', agentId, 'sometimes');
ok(invalid.status !== 0, 'invalid mode exits non-zero');
db = new Database(DB, { readonly: true });
row = db.prepare('SELECT event_mode FROM agents WHERE id = ?').get(agentId);
db.close();
ok(row?.event_mode === 'auto', 'invalid mode leaves the saved value unchanged');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
