#!/usr/bin/env node

import { randomInt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import Database from 'better-sqlite3';

const DB = `/tmp/hive-test-cli-key-identity-${process.pid}.db`;
const DEAD_PORT = 16000 + randomInt(0, 500);
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

function register(key, displayName) {
  const result = spawnSync(process.execPath, [
    'dist/index.js', 'agent', 'register',
    '--db', DB, '--port', String(DEAD_PORT),
    '--key', key,
    '--tool', 'claude',
    '--display-name', displayName,
    '--project-dir', '/tmp/same-project',
  ], { encoding: 'utf8', timeout: 15_000 });
  ok(result.status === 0, `register ${key} exits 0 (stderr=${result.stderr.trim()})`);
  return result.stdout.trim();
}

console.log('\n=== Distinct keys with the same title/cwd ===');
const a1 = register('kitty-session-a', 'same-project');
const b1 = register('kitty-session-b', 'same-project');
ok(a1 !== b1, 'different keys receive different agent ids');

console.log('\n=== Same key is idempotent ===');
const a2 = register('kitty-session-a', 'same-project');
ok(a2 === a1, 'same key reuses the same agent id');

console.log('\n=== Trusted CLI title update ===');
const a3 = register('kitty-session-a', 'Kitty custom title');
ok(a3 === a1, 'renaming keeps the same agent id');

const db = new Database(DB, { readonly: true });
const rows = db.prepare(`
  SELECT id, external_key, display_name, project_dir
  FROM agents
  WHERE external_key IN ('kitty-session-a', 'kitty-session-b')
  ORDER BY external_key
`).all();
db.close();
ok(rows.length === 2, 'database contains one row per key');
ok(rows[0]?.id === a1 && rows[0]?.display_name === 'Kitty custom title', 'key A title updates in place');
ok(rows[1]?.id === b1 && rows[1]?.display_name === 'same-project', 'key B remains independent');
ok(rows.every(row => row.project_dir === '/tmp/same-project'), 'same cwd is metadata, not identity');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
