#!/usr/bin/env node

import Database from 'better-sqlite3';

const db = new Database(':memory:');
try {
  const row = db.prepare('SELECT 1 AS ok, sqlite_version() AS sqlite_version').get();
  if (row?.ok !== 1 || typeof row.sqlite_version !== 'string') {
    throw new Error(`unexpected SQLite result: ${JSON.stringify(row)}`);
  }
  console.log(`better-sqlite3 native smoke passed (Node ${process.version}, ABI ${process.versions.modules}, SQLite ${row.sqlite_version})`);
} finally {
  db.close();
}
