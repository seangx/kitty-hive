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

import {
  CodexTerminalNotificationTracker,
  HistoryItemInjector,
  TurnTracker,
  buildEventTimingLines,
  checkDmDeliveryBeforeInject,
  checkEventDeliveryBeforeInject,
  decideEventDelivery,
} from './dist/codex-channel-runtime.js';

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

async function test11_dmDeliveryPreflight() {
  console.log('\n=== Test 11: DM delivery preflight suppresses consumed events and fails open ===');
  const alreadyRead = await checkDmDeliveryBeforeInject(
    'http://hive.test/admin/codex-dm-delivery-status',
    'agent-1',
    42,
    async () => new Response(JSON.stringify({ deliver: false, reason: 'already_read', message_id: 42, cursor: 42 }), { status: 200 }),
  );
  ok(alreadyRead.deliver === false && alreadyRead.reason === 'already_read', 'already-read decision suppresses injection');

  const unread = await checkDmDeliveryBeforeInject(
    'http://hive.test/admin/codex-dm-delivery-status',
    'agent-1',
    43,
    async () => new Response(JSON.stringify({ deliver: true, reason: 'unread', message_id: 43, cursor: 42 }), { status: 200 }),
  );
  ok(unread.deliver === true && unread.reason === 'unread', 'unread decision permits injection');

  const httpFailure = await checkDmDeliveryBeforeInject(
    'http://hive.test/admin/codex-dm-delivery-status',
    'agent-1',
    44,
    async () => new Response('down', { status: 503 }),
  );
  ok(httpFailure.deliver === true && httpFailure.reason === 'preflight_error', 'HTTP failure fails open');

  const networkFailure = await checkDmDeliveryBeforeInject(
    'http://hive.test/admin/codex-dm-delivery-status',
    'agent-1',
    45,
    async () => { throw new Error('connection reset'); },
  );
  ok(networkFailure.deliver === true && networkFailure.reason === 'preflight_error', 'network failure fails open');

  let requestBody;
  const supersededTask = await checkEventDeliveryBeforeInject(
    'http://hive.test/admin/push-delivery-status',
    'agent-1',
    { event_id: 'task:task-1:task-assigned:1', task_id: 'task-1' },
    async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ deliver: false, reason: 'superseded', seq: 1, latest_seq: 2 }), { status: 200 });
    },
  );
  ok(requestBody.event_id === 'task:task-1:task-assigned:1' && requestBody.task_id === 'task-1', 'generic preflight sends stable task identity');
  ok(!supersededTask.deliver && supersededTask.reason === 'superseded', 'superseded task decision suppresses injection');
}

async function test12_foregroundHistoryInjectionStartsNoTurn() {
  console.log('\n=== Test 12: foreground history injection persists context without turn/start ===');
  const calls = [];
  const transport = {
    async call(method, params) {
      calls.push({ method, params });
      if (method !== 'thread/inject_items') throw new Error(`unexpected method: ${method}`);
      return {};
    },
  };
  const injector = new HistoryItemInjector(transport, 'thread-fg');
  const outcome = await injector.injectDeveloperText('pending hive event', { eventId: 'dm:2194' });
  ok(outcome.kind === 'injected', `outcome.kind = ${outcome.kind}`);
  ok(calls.length === 1 && calls[0].method === 'thread/inject_items', 'exactly one thread/inject_items RPC issued');
  ok(calls.every(c => c.method !== 'turn/start'), 'zero turn/start RPCs issued');
  const params = calls[0].params;
  ok(params.threadId === 'thread-fg', 'injection targets the foreground thread');
  ok(params.items?.[0]?.role === 'developer', 'pending notice is a developer history item');
  ok(params.items?.[0]?.content?.[0]?.text === 'pending hive event', 'pending notice text is preserved');
}

async function test13_foregroundHistoryDedupAndSwitch() {
  console.log('\n=== Test 13: foreground history dedups events and follows thread switches ===');
  const calls = [];
  const transport = { async call(method, params) { calls.push({ method, params }); return {}; } };
  const injector = new HistoryItemInjector(transport, 'thread-old');
  const first = await injector.injectDeveloperText('first', { eventId: 'evid:1' });
  const duplicate = await injector.injectDeveloperText('duplicate', { eventId: 'evid:1' });
  injector.setThreadId('thread-new');
  const second = await injector.injectDeveloperText('second', { eventId: 'evid:2' });
  ok(first.kind === 'injected', 'first event injected');
  ok(duplicate.kind === 'skipped_duplicate', 'duplicate event skipped');
  ok(second.kind === 'injected', 'new event injected after thread switch');
  ok(calls.length === 2, `only two RPCs for three attempts (got ${calls.length})`);
  ok(calls[0].params.threadId === 'thread-old' && calls[1].params.threadId === 'thread-new', 'injector retargets the switched thread');
}

async function test14_foregroundOwnershipDecision() {
  console.log('\n=== Test 14: foreground ownership decision never selects a background turn ===');
  ok(decideEventDelivery('foreground', 'appserver') === 'foreground_history', 'foreground + appserver uses history injection');
  ok(decideEventDelivery('foreground', 'exec') === 'foreground_unavailable', 'foreground + exec leaves event unread');
  ok(decideEventDelivery('foreground', null) === 'foreground_unavailable', 'foreground + no backend leaves event unread');
  ok(decideEventDelivery('auto', 'appserver') === 'background_turn', 'auto mode preserves autonomous model turns');
  ok(decideEventDelivery('auto', 'exec') === 'background_turn', 'auto exec path remains autonomous');
}

async function test15_replayAndDelayMarkers() {
  console.log('\n=== Test 15: replay and delayed delivery are model-visible ===');
  const now = Date.parse('2026-07-20T07:02:00.000Z');
  const delayed = buildEventTimingLines({
    received_at: '2026-07-20T07:01:55.000Z',
    replayed: true,
    queued_at: '2026-07-20T07:00:00.000Z',
  }, now);
  ok(delayed.some(line => line.startsWith('replayed: true')), 'restart replay is labeled explicitly');
  ok(delayed.some(line => line.includes('queued_delivery: true') && line.includes('delay_ms=120000')), 'old queued_at produces an explicit queue-delay marker');
  const fresh = buildEventTimingLines({ received_at: '2026-07-20T07:01:55.000Z' }, now);
  ok(fresh.every(line => !line.includes('queued_delivery')), 'fresh delivery is not mislabeled as queued');
}

async function test16_externalTerminalNotificationContract() {
  console.log('\n=== Test 16: external terminal notifications are current-thread, typed, and deduplicated ===');
  const tracker = new CodexTerminalNotificationTracker('thread-current');

  const completed = tracker.observe('turn/completed', {
    threadId: 'thread-current',
    turn: { id: 'turn-human-1', status: 'completed' },
  }, false);
  ok(completed.kind === 'notify' && completed.notice.status === 'completed', 'foreground completion becomes a completed notice');

  const duplicate = tracker.observe('turn/completed', {
    threadId: 'thread-current',
    turn: { id: 'turn-human-1', status: 'completed' },
  }, false);
  ok(duplicate.kind === 'ignored' && duplicate.reason === 'duplicate', 'duplicate terminal notification is ignored');

  const wrongThread = tracker.observe('turn/completed', {
    threadId: 'thread-old',
    turn: { id: 'turn-human-old', status: 'completed' },
  }, false);
  ok(wrongThread.kind === 'ignored' && wrongThread.reason === 'wrong-thread', 'terminal event from a stale thread is ignored');

  const interrupted = tracker.observe('turn/completed', {
    threadId: 'thread-current',
    turn: { id: 'turn-human-2', status: 'interrupted' },
  }, false);
  ok(interrupted.kind === 'notify' && interrupted.notice.status === 'interrupted', 'interrupted status is preserved');

  const failed = tracker.observe('error', {
    threadId: 'thread-current',
    turnId: 'turn-human-3',
    willRetry: false,
    error: { kind: 'badRequest' },
  }, false);
  ok(failed.kind === 'notify' && failed.notice.status === 'failed', 'final error becomes a failed notice');

  const retrying = tracker.observe('error', {
    threadId: 'thread-current',
    turnId: 'turn-human-4',
    willRetry: true,
    error: 'transient',
  }, false);
  ok(retrying.kind === 'ignored' && retrying.reason === 'not-terminal', 'retryable error does not end Working');
}

async function test17_daemonOwnershipSurvivesTimeout() {
  console.log('\n=== Test 17: daemon ownership survives waiter timeout and blocks false UI notification ===');
  let now = 1000;
  const t = makeTransport();
  const turns = new TurnTracker(t.transport, 'thread-current', {
    turnTimeoutMs: 10,
    ownedTurnTtlMs: 1000,
    now: () => now,
  });
  const outcome = await turns.sendTurn('daemon turn');
  ok(outcome.kind === 'timeout', 'daemon turn waiter timed out');
  ok(turns.isOwnedTurn('turn-1'), 'timed-out turn remains daemon-owned');

  const terminals = new CodexTerminalNotificationTracker('thread-current');
  const ignored = terminals.observe('turn/completed', {
    threadId: 'thread-current',
    turn: { id: 'turn-1', status: 'completed' },
  }, turns.isOwnedTurn('turn-1'));
  ok(ignored.kind === 'ignored' && ignored.reason === 'daemon-owned', 'late daemon completion is not shown by Kitty');
  turns.releaseOwnedTurn('turn-1');
  ok(!turns.isOwnedTurn('turn-1'), 'ownership is released after terminal classification');

  const duplicate = terminals.observe('turn/completed', {
    threadId: 'thread-current',
    turn: { id: 'turn-1', status: 'completed' },
  }, false);
  ok(duplicate.kind === 'ignored' && duplicate.reason === 'duplicate', 'duplicate stays hidden after ownership release');

  now += 1001;
  ok(!turns.isOwnedTurn('turn-1'), 'released ownership remains absent after TTL');
}

async function test18_daemonOwnershipIsBoundedAndExpires() {
  console.log('\n=== Test 18: daemon ownership retention is bounded and expires ===');
  let now = 2000;
  const t = makeTransport();
  const tracker = new TurnTracker(t.transport, 'thread-current', {
    turnTimeoutMs: 1,
    ownedTurnTtlMs: 100,
    ownedTurnMaxEntries: 2,
    now: () => now,
  });
  await tracker.sendTurn('one');
  now += 1;
  await tracker.sendTurn('two');
  now += 1;
  await tracker.sendTurn('three');
  const bounded = tracker.snapshot().ownedTurns;
  ok(bounded.length === 2, `ownership set is capped at 2 (got ${bounded.length})`);
  ok(!bounded.includes('turn-1') && bounded.includes('turn-2') && bounded.includes('turn-3'), 'oldest ownership entry is evicted first');
  now += 101;
  ok(tracker.snapshot().ownedTurns.length === 0, 'retained ownership entries expire by TTL');
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
  await test11_dmDeliveryPreflight();
  await test12_foregroundHistoryInjectionStartsNoTurn();
  await test13_foregroundHistoryDedupAndSwitch();
  await test14_foregroundOwnershipDecision();
  await test15_replayAndDelayMarkers();
  await test16_externalTerminalNotificationContract();
  await test17_daemonOwnershipSurvivesTimeout();
  await test18_daemonOwnershipIsBoundedAndExpires();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(err => { console.error('FATAL:', err); process.exit(1); });
