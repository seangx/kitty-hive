import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAgentByExternalKey, initDB } from './db.js';
import { handleStart } from './tools/start.js';

function withDB(run: () => void): void {
  const database = initDB(':memory:');
  try { run(); } finally { database.close(); }
}

test('a new key does not take over a same-named agent owned by another key', () => withDB(() => {
  const first = handleStart({ key: 'A', name: 'monkeys', tool: 'claude' });
  const second = handleStart({ key: 'B', name: 'monkeys', tool: 'claude' });
  assert.notEqual(second.agent_id, first.agent_id);
  assert.equal(getAgentByExternalKey('A')?.id, first.agent_id);
  assert.equal(getAgentByExternalKey('B')?.id, second.agent_id);
}));

test('a key may still adopt a same-named agent that has no key', () => withDB(() => {
  const unkeyed = handleStart({ name: 'monkeys', tool: 'claude' });
  const keyed = handleStart({ key: 'A', name: 'monkeys', tool: 'claude' });
  assert.equal(keyed.agent_id, unkeyed.agent_id);
  assert.equal(getAgentByExternalKey('A')?.id, unkeyed.agent_id);
}));

test('name-only callers keep reusing the latest same-named agent', () => withDB(() => {
  const keyed = handleStart({ key: 'A', name: 'monkeys', tool: 'claude' });
  assert.equal(handleStart({ name: 'monkeys', tool: 'claude' }).agent_id, keyed.agent_id);
  assert.equal(getAgentByExternalKey('A')?.id, keyed.agent_id);
}));

test('an explicit id can still reassign a key', () => withDB(() => {
  const agent = handleStart({ key: 'A', name: 'monkeys', tool: 'claude' });
  assert.equal(handleStart({ id: agent.agent_id, key: 'B' }).agent_id, agent.agent_id);
  assert.equal(getAgentByExternalKey('B')?.id, agent.agent_id);
}));
