#!/usr/bin/env node
// Unit tests for TurnTracker — the testable core of codex-channel.
//
// This file imports the compiled dist/codex-channel-runtime.js and exercises
// every failure mode of sendTurn against a stub transport. The runtime is
// transport-agnostic by design (RpcTransport interface) so we don't need a
// real codex app-server here.
//
// What we prove:
//
//   1. turn/start success → completed notification → outcome.kind=completed
//   2. turn/start success → no notification → outcome.kind=timeout (and NO
//      retry / no second turn/start)
//   3. turn/start RPC error → outcome.kind=rpc_send_error
//   4. error notification (willRetry=false) → outcome.kind=failed
//   5. error notification (willRetry=true) → tracker keeps waiting; later
//      completed → outcome.kind=completed
//   6. turn/interrupt notification → outcome.kind=interrupted
//   7. Concurrent turns are routed by turnId, not FIFO
//   8. Idempotency: same eventId twice → second is skipped_duplicate, no
//      second turn/start ever issued
//   9. Timer is cleaned up on every terminal outcome (no leaked handles)

import { TurnTracker } from './dist/codex-channel-runtime.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.error(`  ✗ ${msg}`); fail++; }
}

/** Build a controllable fake RpcTransport. `nextStartResponse` queues the
 *  result of the next `turn/start`; defaults to {turn:{id:'turn-N'}}.
 *  `startError` overrides with a rejection. Records every call. */
function makeTransport() {
  let counter = 0;
  const calls = [];
  let nextStart = null;  // {result} | {error}
  return {
    /** @type {import('./dist/codex-channel-runtime.js').RpcTransport} */
    transport: {
      async call(method, params /*, timeoutMs */) {
        calls.push({ method, params });
        if (method === 'turn/start') {
          if (nextStart?.error) { const err = nextStart.error; nextStart = null; throw err; }
          if (nextStart?.result) { const r = nextStart.result; nextStart = null; return r; }
          counter += 1;
          return { turn: { id: `turn-${counter}` } };
        }
        throw new Error(`unexpected rpc call: ${method}`);
      },
    },
    calls,
    setNextStart(spec) { nextStart = spec; },
    startCount() { return calls.filter(c => c.method === 'turn/start').length; },
  };
}

async function test1_happyPath() {
  console.log('\n=== Test 1: turn/start + completed → completed ===');
  const t = makeTransport();
  const tracker = new TurnTracker(t.transport, 'thread-1', { turnTimeoutMs: 1000 });
  const p = tracker.sendTurn('hello');
  // give microtask queue a beat so turn/start resolves and waiter registers
  await new Promise(r => setImmediate(r));
  const matched = tracker.handleNotification('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } });
  ok(matched, 'completed notification matched a waiter');
  const outcome = await p;
  ok(outcome.kind === 'completed', `outcome.kind = ${outcome.kind} (expected completed)`);
  ok(outcome.turnId === 'turn-1', `outcome.turnId = ${outcome.turnId}`);
  ok(t.startCount() === 1, `exactly 1 turn/start issued (got ${t.startCount()})`);
}

async function test2_timeoutNoRetry() {
  console.log('\n=== Test 2: timeout → outcome.kind=timeout, NO retry ===');
  const t = makeTransport();
  const tracker = new TurnTracker(t.transport, 'thread-1', { turnTimeoutMs: 50 });
  const start = Date.now();
  const outcome = await tracker.sendTurn('stuck event', { eventId: 'evt:1' });
  const elapsed = Date.now() - start;
  ok(outcome.kind === 'timeout', `outcome.kind = ${outcome.kind}`);
  ok(elapsed >= 50 && elapsed < 500, `elapsed ${elapsed}ms is within timeout window`);
  ok(t.startCount() === 1, `STILL exactly 1 turn/start (no retry — got ${t.startCount()})`);
  // Re-enqueueing the same event MUST be a no-op:
  const second = await tracker.sendTurn('stuck event again', { eventId: 'evt:1' });
  ok(second.kind === 'skipped_duplicate', `second sendTurn for same eventId = ${second.kind}`);
  ok(t.startCount() === 1, `STILL exactly 1 turn/start after redundant attempt (got ${t.startCount()})`);
}

async function test3_rpcSendError() {
  console.log('\n=== Test 3: turn/start rejects → rpc_send_error ===');
  const t = makeTransport();
  t.setNextStart({ error: new Error('ws closed') });
  const tracker = new TurnTracker(t.transport, 'thread-1');
  const outcome = await tracker.sendTurn('hi');
  ok(outcome.kind === 'rpc_send_error', `outcome.kind = ${outcome.kind}`);
  ok(outcome.error.message === 'ws closed', `error message preserved: ${outcome.error.message}`);
}

async function test4_errorNotificationFinal() {
  console.log('\n=== Test 4: error notification willRetry=false → failed ===');
  const t = makeTransport();
  const tracker = new TurnTracker(t.transport, 'thread-1', { turnTimeoutMs: 1000 });
  const p = tracker.sendTurn('boom');
  await new Promise(r => setImmediate(r));
  tracker.handleNotification('error', { threadId: 'thread-1', turnId: 'turn-1', willRetry: false, error: { kind: 'badRequest' } });
  const outcome = await p;
  ok(outcome.kind === 'failed', `outcome.kind = ${outcome.kind}`);
  ok(outcome.willRetry === false, 'willRetry surfaced correctly');
}

async function test5_errorNotificationRetryable() {
  console.log('\n=== Test 5: error notification willRetry=true → tracker keeps waiting ===');
  const t = makeTransport();
  const tracker = new TurnTracker(t.transport, 'thread-1', { turnTimeoutMs: 1000 });
  const p = tracker.sendTurn('flaky');
  await new Promise(r => setImmediate(r));
  // Codex tells us it'll retry internally — we should NOT resolve yet.
  const matched1 = tracker.handleNotification('error', { threadId: 'thread-1', turnId: 'turn-1', willRetry: true, error: 'transient' });
  ok(matched1 === false, 'willRetry=true error returns false (keep waiting)');
  // Now the actual completion arrives:
  const matched2 = tracker.handleNotification('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1' } });
  ok(matched2, 'subsequent completed notification matched the still-pending waiter');
  const outcome = await p;
  ok(outcome.kind === 'completed', `final outcome = ${outcome.kind}`);
}

async function test6_interrupted() {
  console.log('\n=== Test 6: turn/interrupt → interrupted ===');
  const t = makeTransport();
  const tracker = new TurnTracker(t.transport, 'thread-1', { turnTimeoutMs: 1000 });
  const p = tracker.sendTurn('long');
  await new Promise(r => setImmediate(r));
  tracker.handleNotification('turn/interrupt', { threadId: 'thread-1', turn: { id: 'turn-1' } });
  const outcome = await p;
  ok(outcome.kind === 'interrupted', `outcome.kind = ${outcome.kind}`);
}

async function test7_concurrentRoutedByTurnId() {
  console.log('\n=== Test 7: concurrent turns routed by turnId (no FIFO mismatch) ===');
  const t = makeTransport();
  const tracker = new TurnTracker(t.transport, 'thread-1', { turnTimeoutMs: 1000 });
  // Start two turns; transport assigns turn-1 and turn-2 in order.
  const p1 = tracker.sendTurn('first');
  await new Promise(r => setImmediate(r));
  const p2 = tracker.sendTurn('second');
  await new Promise(r => setImmediate(r));
  // Deliver completions OUT OF ORDER — the OLD FIFO impl would resolve p1
  // first when turn-2 completes, mis-routing the result.
  tracker.handleNotification('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-2' } });
  tracker.handleNotification('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1' } });
  const [o1, o2] = await Promise.all([p1, p2]);
  ok(o1.kind === 'completed' && o1.turnId === 'turn-1', `p1 routed to turn-1 (got ${o1.turnId})`);
  ok(o2.kind === 'completed' && o2.turnId === 'turn-2', `p2 routed to turn-2 (got ${o2.turnId})`);
}

async function test8_idempotencyAcrossTimeout() {
  console.log('\n=== Test 8: idempotency — eventId reuse skipped even after timeout ===');
  // covered partially in test 2, but check explicit ordering: send → timeout
  // → send same eventId → skipped, NO second turn/start.
  const t = makeTransport();
  const tracker = new TurnTracker(t.transport, 'thread-1', { turnTimeoutMs: 20 });
  const r1 = await tracker.sendTurn('first', { eventId: 'dm:42' });
  ok(r1.kind === 'timeout', `first sendTurn timed out (got ${r1.kind})`);
  const r2 = await tracker.sendTurn('first again', { eventId: 'dm:42' });
  ok(r2.kind === 'skipped_duplicate', `second sendTurn skipped (got ${r2.kind})`);
  ok(t.startCount() === 1, `still only 1 turn/start across both attempts (got ${t.startCount()})`);
}

async function test9_lateCompletionAfterTimeoutIgnored() {
  console.log('\n=== Test 9: late completion after timeout is silently ignored ===');
  const t = makeTransport();
  const tracker = new TurnTracker(t.transport, 'thread-1', { turnTimeoutMs: 20 });
  const outcome = await tracker.sendTurn('late', { eventId: 'evt:late' });
  ok(outcome.kind === 'timeout', 'first attempt timed out');
  // Codex eventually completes the turn — late notification should NOT
  // resolve anything (waiter already cleaned up) and MUST NOT throw.
  const matched = tracker.handleNotification('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1' } });
  ok(matched === false, 'late completion returns false (no waiter)');
  // No timers leaking — snapshot should be empty:
  const snap = tracker.snapshot();
  ok(snap.activeTurns.length === 0, `no active turns after timeout (got ${snap.activeTurns.length})`);
}

async function test10_handleNotificationUnknownType() {
  console.log('\n=== Test 10: unknown notification methods are no-op ===');
  const t = makeTransport();
  const tracker = new TurnTracker(t.transport, 'thread-1');
  const matched = tracker.handleNotification('item/added', { whatever: true });
  ok(matched === false, 'unknown method returns false');
}

async function run() {
  await test1_happyPath();
  await test2_timeoutNoRetry();
  await test3_rpcSendError();
  await test4_errorNotificationFinal();
  await test5_errorNotificationRetryable();
  await test6_interrupted();
  await test7_concurrentRoutedByTurnId();
  await test8_idempotencyAcrossTimeout();
  await test9_lateCompletionAfterTimeoutIgnored();
  await test10_handleNotificationUnknownType();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(err => { console.error('FATAL:', err); process.exit(1); });
