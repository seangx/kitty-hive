import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findAgentByRole, getAgentById, getDB, initDB, markAgentRuntimeStarted } from './db.js';
import { handleStart } from './tools/start.js';

test('starting a stopped runtime makes the agent routable by role again', () => {
  const database = initDB(':memory:');
  try {
    const { agent_id: id } = handleStart({ key: 'A', name: 'runner', tool: 'codex', roles: 'worker' });
    // Same write an explicit runtime stop performs.
    getDB().prepare("UPDATE agents SET runtime_enabled = 0, status = 'offline' WHERE id = ?").run(id);
    assert.equal(findAgentByRole('worker'), undefined);

    markAgentRuntimeStarted(id);

    const agent = getAgentById(id);
    assert.equal(agent?.runtime_enabled, 1);
    assert.equal(agent?.status, 'active');
    assert.equal(findAgentByRole('worker')?.id, id);
  } finally {
    database.close();
  }
});
