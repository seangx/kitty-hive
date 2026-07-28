import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildKittyCodexTurnCompletedPayload,
  notifyKittyCodexTurnCompleted,
} from './kitty-wakeup.js';

test('Codex terminal wakeup payload is typed and content-free', () => {
  const payload = buildKittyCodexTurnCompletedPayload({
    status: 'completed',
    threadId: 'thread-123',
    turnId: 'turn-456',
  });

  assert.deepEqual(payload, {
    tool: 'codex',
    hook_event_name: 'TurnCompleted',
    notification_type: 'codex_turn_completed',
    status: 'completed',
    thread_id: 'thread-123',
    turn_id: 'turn-456',
  });
  assert.equal('message' in payload, false);
});

test('Codex terminal wakeup reports a missing Kitty session key', async () => {
  const result = await notifyKittyCodexTurnCompleted('', {
    status: 'completed',
    threadId: 'thread-123',
    turnId: 'turn-456',
  });

  assert.deepEqual(result, {
    kind: 'unavailable',
    reason: 'missing external key',
  });
});
