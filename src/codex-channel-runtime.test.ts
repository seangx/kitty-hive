import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CodexChannelLifecycleGate,
  CodexTerminalNotificationTracker,
  HIVE_HTTP_MODEL_PROVIDER_ID,
  PostTurnCompactionCoordinator,
  TurnTracker,
  buildAppServerInitializeParams,
  buildCodexAppServerArgs,
  buildThreadResumeParams,
  coldResumeCompactionUncertainty,
  detectResponsesTransportFallback,
  describeWebSocketEvent,
  inspectPersistedRolloutRisk,
  parseThreadTokenUsage,
  promoteColdResumeProvider,
  resolvePersistedThreadTarget,
  shouldPromoteColdResumeToWebsocket,
  supervisorProcessIsMissing,
  type CodexTerminalDecision,
  type RpcTransport,
} from './codex-channel-runtime.js';

test('event turns and thread switches share one lifecycle gate', () => {
  const gate = new CodexChannelLifecycleGate();

  assert.equal(gate.tryStartEvent(), true, 'in-flight sendTurn owns the gate');
  assert.equal(gate.tryStartSwitch(), false, 'switch is rejected while the event continuation is active');
  gate.finishEvent();

  assert.equal(gate.tryStartSwitch(), true, 'switch starts after the event finishes');
  assert.equal(gate.tryStartEvent(), false, 'new events wait for the switch lifecycle');
  gate.finishSwitch();
  assert.equal(gate.tryStartEvent(), true);
  gate.finishEvent();
});

test('explicit persisted thread targets are strict while inherited boot targets may self-heal', () => {
  assert.deepEqual(
    resolvePersistedThreadTarget(' target-thread ', 'inherited-thread'),
    { threadId: 'target-thread', strict: true },
  );
  assert.deepEqual(
    resolvePersistedThreadTarget(undefined, ' inherited-thread '),
    { threadId: 'inherited-thread', strict: false },
  );
});

function ignoredReason(decision: CodexTerminalDecision): string | undefined {
  return decision.kind === 'ignored' ? decision.reason : undefined;
}

test('thread resume overrides stale rollout cwd and model transport without returning turns', () => {
  assert.deepEqual(
    buildThreadResumeParams(
      '019fa11b-79eb-79e3-8628-863405bf27de',
      '/Users/example/.kitty-kitty/sessions/e2f81622',
    ),
    {
      threadId: '019fa11b-79eb-79e3-8628-863405bf27de',
      modelProvider: 'hive-openai',
      cwd: '/Users/example/.kitty-kitty/sessions/e2f81622',
      excludeTurns: true,
    },
  );
  assert.deepEqual(
    buildThreadResumeParams(
      '019fa11b-79eb-79e3-8628-863405bf27de',
      '/Users/example/.kitty-kitty/sessions/e2f81622',
      HIVE_HTTP_MODEL_PROVIDER_ID,
    ),
    {
      threadId: '019fa11b-79eb-79e3-8628-863405bf27de',
      modelProvider: 'hive-openai-http',
      cwd: '/Users/example/.kitty-kitty/sessions/e2f81622',
      excludeTurns: true,
    },
  );
});

test('app-server initialization enables the experimental resume field', () => {
  assert.deepEqual(
    buildAppServerInitializeParams({
      name: 'kitty-hive-codex-channel',
      version: '0.7.0',
    }),
    {
      clientInfo: {
        name: 'kitty-hive-codex-channel',
        version: '0.7.0',
      },
      capabilities: { experimentalApi: true },
    },
  );
});

test('Hive app-server uses incremental Responses WebSockets with bounded HTTPS fallback', () => {
  assert.deepEqual(
    buildCodexAppServerArgs(
      'ws://127.0.0.1:4567',
      'http://127.0.0.1:4123/mcp',
      ['hive_start', 'hive_inbox'],
    ),
    [
      'app-server',
      '--listen',
      'ws://127.0.0.1:4567',
      '-c',
      'model_providers.hive-openai={name="OpenAI",wire_api="responses",requires_openai_auth=true,supports_websockets=true,request_max_retries=3,stream_max_retries=3,supports_standalone_web_search=true}',
      '-c',
      'model_providers.hive-openai-http={name="OpenAI",wire_api="responses",requires_openai_auth=true,supports_websockets=false,request_max_retries=3,stream_max_retries=3,supports_standalone_web_search=true}',
      '-c',
      'model_provider="hive-openai"',
      '-c',
      'model_auto_compact_token_limit=160000',
      '-c',
      'model_auto_compact_token_limit_scope="total"',
      '-c',
      'mcp_servers.hive.url="http://127.0.0.1:4123/mcp"',
      '-c',
      'mcp_servers.hive.tools.hive_start.approval_mode="auto"',
      '-c',
      'mcp_servers.hive.tools.hive_inbox.approval_mode="auto"',
    ],
  );
});

test('Hive app-server transport remains rollback-configurable without reopening retry amplification', () => {
  const args = buildCodexAppServerArgs(
    'ws://127.0.0.1:4567',
    'http://127.0.0.1:4123/mcp',
    [],
    {
      supportsWebsockets: false,
      requestMaxRetries: 0,
      streamMaxRetries: 0,
      autoCompactTokenLimit: 120_000,
    },
  );
  assert.ok(args.includes(
    'model_providers.hive-openai={name="OpenAI",wire_api="responses",requires_openai_auth=true,supports_websockets=false,request_max_retries=0,stream_max_retries=0,supports_standalone_web_search=true}',
  ));
  assert.ok(args.includes(
    'model_providers.hive-openai-http={name="OpenAI",wire_api="responses",requires_openai_auth=true,supports_websockets=false,request_max_retries=0,stream_max_retries=0,supports_standalone_web_search=true}',
  ));
  assert.ok(args.includes('model_auto_compact_token_limit=120000'));
  assert.ok(args.includes('model_auto_compact_token_limit_scope="total"'));
});

test('Hive app-server rejects invalid traffic guard settings', () => {
  assert.throws(
    () => buildCodexAppServerArgs('ws://127.0.0.1:1', 'http://127.0.0.1:4123/mcp', [], {
      streamMaxRetries: -1,
    }),
    /streamMaxRetries must be a non-negative safe integer/,
  );
  assert.throws(
    () => buildCodexAppServerArgs('ws://127.0.0.1:1', 'http://127.0.0.1:4123/mcp', [], {
      autoCompactTokenLimit: 0,
    }),
    /autoCompactTokenLimit must be a positive safe integer/,
  );
});

test('token usage telemetry is thread-scoped and labels estimates', () => {
  assert.deepEqual(
    parseThreadTokenUsage('thread/tokenUsage/updated', {
      threadId: 'thread-current',
      turnId: 'turn-1',
      tokenUsage: {
        last: {
          inputTokens: 200_000,
          cachedInputTokens: 190_000,
          totalTokens: 201_000,
        },
        modelContextWindow: 250_000,
      },
    }, 'thread-current'),
    {
      threadId: 'thread-current',
      turnId: 'turn-1',
      inputTokens: 200_000,
      cachedInputTokens: 190_000,
      totalTokens: 201_000,
      modelContextWindow: 250_000,
      contextUtilization: 0.8,
      approximateTokenTextBytes: 800_000,
    },
  );
  assert.equal(
    parseThreadTokenUsage('thread/tokenUsage/updated', {
      threadId: 'thread-other',
      turnId: 'turn-1',
      tokenUsage: { last: { inputTokens: 1, cachedInputTokens: 1, totalTokens: 1 } },
    }, 'thread-current'),
    null,
  );
});

test('transport fallback warning detection is exact', () => {
  assert.equal(detectResponsesTransportFallback('warning', {
    threadId: 'thread-current',
    message: 'Falling back from WebSockets to HTTPS transport. broken pipe',
  }, 'thread-current'), true);
  assert.equal(detectResponsesTransportFallback('warning', {
    threadId: 'thread-stale',
    message: 'Falling back from WebSockets to HTTPS transport. broken pipe',
  }, 'thread-current'), false);
  assert.equal(detectResponsesTransportFallback('warning', {
    message: 'another warning',
  }, 'thread-current'), false);
  assert.equal(detectResponsesTransportFallback('error', {
    message: 'Falling back from WebSockets to HTTPS transport.',
  }, 'thread-current'), false);
});

test('large completed turns compact before the event queue can continue', async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const transport: RpcTransport = {
    async call(method, params) {
      calls.push({ method, params });
      return {};
    },
  };
  const compactor = new PostTurnCompactionCoordinator(transport, 160_000, 1000);
  compactor.observeNotification('thread/tokenUsage/updated', {
    threadId: 'thread-current',
    turnId: 'turn-large',
    tokenUsage: {
      last: { inputTokens: 175_000, cachedInputTokens: 160_000, totalTokens: 176_000 },
      modelContextWindow: 250_000,
    },
  });

  let settled = false;
  const pending = compactor.compactAfterTurn('thread-current', 'turn-large')
    .then((outcome) => {
      settled = true;
      return outcome;
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{
    method: 'thread/compact/start',
    params: { threadId: 'thread-current' },
  }]);
  assert.equal(settled, false, 'queue must remain blocked until ContextCompaction completes');
  assert.equal(compactor.observeNotification('item/started', {
    threadId: 'thread-current',
    turnId: 'turn-compact',
    item: { type: 'contextCompaction', id: 'compact-1' },
  }), true);
  assert.equal(compactor.isOwnedTurn('turn-compact'), true, 'manual compact must not notify Kitty');
  assert.equal(compactor.observeNotification('item/completed', {
    threadId: 'thread-current',
    turnId: 'turn-compact',
    item: { type: 'contextCompaction', id: 'compact-1' },
  }), true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'queue must also await the compaction turn terminal');
  const compactTerminal = {
    threadId: 'thread-current',
    turn: { id: 'turn-compact', status: 'completed' },
  };
  assert.equal(compactor.observeNotification('turn/completed', compactTerminal), true);
  const terminalTracker = new CodexTerminalNotificationTracker('thread-current');
  assert.equal(
    ignoredReason(terminalTracker.observe(
      'turn/completed',
      compactTerminal,
      compactor.isOwnedTurn('turn-compact'),
    )),
    'daemon-owned',
  );
  assert.deepEqual(await pending, {
    kind: 'compacted',
    threadId: 'thread-current',
    turnId: 'turn-large',
    inputTokens: 175_000,
  });
  compactor.releaseOwnedTurn('turn-compact');
  assert.equal(compactor.isOwnedTurn('turn-compact'), false);
});

test('cold resume waits for persisted usage replay before compacting', async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const compactor = new PostTurnCompactionCoordinator({
    async call(method, params) {
      calls.push({ method, params });
      return {};
    },
  }, 160_000, 1000);

  const pending = compactor.compactColdResume('thread-current', { usageTimeoutMs: 1000 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [], 'compact must wait for the post-resume usage replay');
  compactor.observeNotification('thread/tokenUsage/updated', {
    threadId: 'thread-current',
    turnId: 'turn-large',
    tokenUsage: {
      last: { inputTokens: 175_000, cachedInputTokens: 160_000, totalTokens: 176_000 },
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{
    method: 'thread/compact/start',
    params: { threadId: 'thread-current' },
  }]);
  compactor.observeNotification('turn/started', {
    threadId: 'thread-current',
    turn: { id: 'turn-compact', status: 'inProgress' },
  });
  compactor.observeNotification('item/completed', {
    threadId: 'thread-current',
    turnId: 'turn-compact',
    item: { type: 'contextCompaction', id: 'compact-1' },
  });
  compactor.observeNotification('turn/completed', {
    threadId: 'thread-current',
    turn: { id: 'turn-compact', status: 'completed' },
  });
  const outcome = await pending;
  assert.deepEqual(outcome, {
    kind: 'compacted',
    threadId: 'thread-current',
    turnId: 'turn-large',
    inputTokens: 175_000,
  });
  assert.equal(shouldPromoteColdResumeToWebsocket(outcome), true);
});

test('cold resume stays on guarded HTTPS when usage replay is unavailable', async () => {
  let calls = 0;
  const compactor = new PostTurnCompactionCoordinator({
    async call() {
      calls += 1;
      return {};
    },
  }, 160_000, 1000);

  const outcome = await compactor.compactColdResume('thread-current', { usageTimeoutMs: 5 });
  assert.deepEqual(outcome, {
    kind: 'skipped_no_usage',
    threadId: 'thread-current',
  });
  assert.equal(calls, 0);
  assert.equal(shouldPromoteColdResumeToWebsocket(outcome), false);
});

test('cold resume below threshold may establish a fresh WebSocket baseline', async () => {
  const compactor = new PostTurnCompactionCoordinator({
    async call() {
      throw new Error('must not compact');
    },
  }, 160_000, 1000);
  compactor.observeNotification('thread/tokenUsage/updated', {
    threadId: 'thread-current',
    turnId: 'turn-small',
    tokenUsage: {
      last: { inputTokens: 80_000, cachedInputTokens: 70_000, totalTokens: 81_000 },
    },
  });

  const outcome = await compactor.compactColdResume('thread-current', { usageTimeoutMs: 5 });
  assert.deepEqual(outcome, {
    kind: 'skipped_below_threshold',
    threadId: 'thread-current',
    turnId: 'turn-small',
    inputTokens: 80_000,
  });
  assert.equal(shouldPromoteColdResumeToWebsocket(outcome), true);
});

test('legacy excludeTurns resume recovers token usage from a bounded rollout tail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitty-hive-rollout-'));
  const path = join(dir, 'rollout.jsonl');
  try {
    writeFileSync(path, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'thread-legacy' } }),
      JSON.stringify({
        timestamp: '2026-08-30T01:02:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 175_000,
              cached_input_tokens: 160_000,
              total_tokens: 176_000,
            },
            model_context_window: 250_000,
          },
        },
      }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
      '',
    ].join('\n'));

    const risk = inspectPersistedRolloutRisk(path, 'thread-legacy', {
      maxScanBytes: 64 * 1024,
      oversizedGuardBytes: 1024 * 1024,
    });
    assert.equal(risk.kind, 'usage');
    if (risk.kind !== 'usage') return;
    assert.deepEqual(risk.usage, {
      threadId: 'thread-legacy',
      turnId: 'persisted-rollout:2026-08-30T01:02:03.000Z',
      inputTokens: 175_000,
      cachedInputTokens: 160_000,
      totalTokens: 176_000,
      modelContextWindow: 250_000,
      contextUtilization: 0.7,
      approximateTokenTextBytes: 700_000,
    });
    assert.ok(risk.scannedBytes <= 64 * 1024);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('large legacy rollout without tail usage activates the HTTPS size guard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitty-hive-rollout-'));
  const path = join(dir, 'rollout.jsonl');
  try {
    writeFileSync(path, `${'x'.repeat(128)}\n`);
    const risk = inspectPersistedRolloutRisk(path, 'thread-legacy', {
      maxScanBytes: 32,
      oversizedGuardBytes: 64,
    });
    assert.equal(risk.kind, 'oversized');
    if (risk.kind !== 'oversized') return;
    assert.equal(risk.rolloutBytes, 129);
    assert.equal(risk.scannedBytes, 32);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('paginated live usage wins over a stale legacy rollout fallback', async () => {
  let calls = 0;
  const compactor = new PostTurnCompactionCoordinator({
    async call() {
      calls += 1;
      return {};
    },
  }, 160_000, 1000);
  compactor.observeNotification('thread/tokenUsage/updated', {
    threadId: 'thread-current',
    turnId: 'turn-live-small',
    tokenUsage: {
      last: { inputTokens: 80_000, cachedInputTokens: 70_000, totalTokens: 81_000 },
    },
  });

  const outcome = await compactor.compactColdResume('thread-current', {
    usageTimeoutMs: 5,
    fallbackUsage: {
      threadId: 'thread-current',
      turnId: 'persisted-rollout:stale',
      inputTokens: 200_000,
      cachedInputTokens: 190_000,
      totalTokens: 201_000,
      modelContextWindow: null,
      contextUtilization: null,
      approximateTokenTextBytes: 800_000,
    },
  });
  assert.deepEqual(outcome, {
    kind: 'skipped_below_threshold',
    threadId: 'thread-current',
    turnId: 'turn-live-small',
    inputTokens: 80_000,
  });
  assert.equal(calls, 0);
});

test('in-process cold resume can discard usage from an earlier subscription', async () => {
  let calls = 0;
  const compactor = new PostTurnCompactionCoordinator({
    async call() {
      calls += 1;
      return {};
    },
  }, 160_000, 1000);
  compactor.observeNotification('thread/tokenUsage/updated', {
    threadId: 'thread-returning',
    turnId: 'turn-old-large',
    tokenUsage: {
      last: { inputTokens: 200_000, cachedInputTokens: 190_000, totalTokens: 201_000 },
    },
  });

  compactor.forgetThreadUsage('thread-returning');
  const pending = compactor.compactColdResume('thread-returning', { usageTimeoutMs: 1000 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 0, 'stale usage must not start a compaction');

  compactor.observeNotification('thread/tokenUsage/updated', {
    threadId: 'thread-returning',
    turnId: 'turn-replayed-small',
    tokenUsage: {
      last: { inputTokens: 80_000, cachedInputTokens: 70_000, totalTokens: 81_000 },
    },
  });
  assert.deepEqual(await pending, {
    kind: 'skipped_below_threshold',
    threadId: 'thread-returning',
    turnId: 'turn-replayed-small',
    inputTokens: 80_000,
  });
  assert.equal(calls, 0);
});

test('oversized unknown rollout compacts on HTTPS within the cold-start SLA', async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const compactor = new PostTurnCompactionCoordinator({
    async call(method, params) {
      calls.push({ method, params });
      return {};
    },
  }, 160_000, 1000);
  const pending = compactor.compactColdResume('thread-current', {
    usageTimeoutMs: 5,
    completionTimeoutMs: 1000,
    forceCompactRolloutBytes: 70 * 1024 * 1024,
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, [{
    method: 'thread/compact/start',
    params: { threadId: 'thread-current' },
  }]);
  compactor.observeNotification('turn/started', {
    threadId: 'thread-current',
    turn: { id: 'turn-compact', status: 'inProgress' },
  });
  compactor.observeNotification('item/completed', {
    threadId: 'thread-current',
    turnId: 'turn-compact',
    item: { type: 'contextCompaction', id: 'compact-1' },
  });
  compactor.observeNotification('turn/completed', {
    threadId: 'thread-current',
    turn: { id: 'turn-compact', status: 'completed' },
  });
  assert.deepEqual(await pending, {
    kind: 'compacted',
    threadId: 'thread-current',
    turnId: 'persisted-rollout:size-guard',
    inputTokens: null,
    rolloutBytes: 70 * 1024 * 1024,
  });
});

test('cold compact response lost after accept requires app-server recycle', async () => {
  const compactor = new PostTurnCompactionCoordinator({
    async call() {
      throw new Error('response lost after compact was accepted');
    },
  }, 160_000, 1000);
  compactor.observeNotification('thread/tokenUsage/updated', {
    threadId: 'thread-current',
    turnId: 'turn-large',
    tokenUsage: {
      last: { inputTokens: 175_000, cachedInputTokens: 160_000, totalTokens: 176_000 },
    },
  });

  const outcome = await compactor.compactColdResume('thread-current', {
    usageTimeoutMs: 5,
    completionTimeoutMs: 1000,
  });
  assert.equal(outcome.kind, 'rpc_error');
  const uncertainty = coldResumeCompactionUncertainty(outcome);
  assert.equal(uncertainty?.stage, 'compact_start');
  assert.match(uncertainty?.error.message ?? '', /response lost after compact was accepted/);
});

test('cold compact terminal beyond the startup SLA requires app-server recycle', async () => {
  const compactor = new PostTurnCompactionCoordinator({
    async call() {
      return {};
    },
  }, 160_000, 1000);
  compactor.observeNotification('thread/tokenUsage/updated', {
    threadId: 'thread-current',
    turnId: 'turn-large',
    tokenUsage: {
      last: { inputTokens: 175_000, cachedInputTokens: 160_000, totalTokens: 176_000 },
    },
  });

  const outcome = await compactor.compactColdResume('thread-current', {
    usageTimeoutMs: 5,
    completionTimeoutMs: 5,
  });
  assert.deepEqual(outcome, {
    kind: 'timeout',
    threadId: 'thread-current',
    turnId: 'turn-large',
    inputTokens: 175_000,
    afterMs: 5,
  });
  const uncertainty = coldResumeCompactionUncertainty(outcome);
  assert.equal(uncertainty?.stage, 'compact_timeout');
  assert.match(uncertainty?.error.message ?? '', /within 5ms/);
});

test('canonical cold compact failure is settled and may retain HTTPS', () => {
  assert.equal(coldResumeCompactionUncertainty({
    kind: 'failed',
    threadId: 'thread-current',
    turnId: 'turn-compact',
    inputTokens: 175_000,
    status: 'failed',
  }), null);
});

test('cold-resume provider promotion is successful only after a confirmed resume', async () => {
  const calls: Array<{ method: string; params: any }> = [];
  const outcome = await promoteColdResumeProvider({
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'thread/resume') {
        return { thread: { id: 'thread-current' }, modelProvider: 'hive-openai' };
      }
      return { status: 'unsubscribed' };
    },
  }, 'thread-current', '/workspace', (response: any, expectedProvider) => {
    assert.equal(response.thread.id, 'thread-current');
    assert.equal(response.modelProvider, expectedProvider);
  }, 1000);

  assert.deepEqual(outcome, { kind: 'promoted_websocket' });
  assert.deepEqual(calls.map((call) => call.method), ['thread/unsubscribe', 'thread/resume']);
  assert.equal(calls[1]?.params.modelProvider, 'hive-openai');
});

test('response-uncertain WS promotion unsubscribes again before restoring HTTPS', async () => {
  const calls: Array<{ method: string; params: any }> = [];
  let resumeCount = 0;
  const outcome = await promoteColdResumeProvider({
    async call(method, params) {
      calls.push({ method, params });
      if (method !== 'thread/resume') return { status: 'unsubscribed' };
      resumeCount += 1;
      if (resumeCount === 1) throw new Error('response lost after server accepted resume');
      return { thread: { id: 'thread-current' }, modelProvider: 'hive-openai-http' };
    },
  }, 'thread-current', '/workspace', (response: any, expectedProvider) => {
    assert.equal(response.thread.id, 'thread-current');
    assert.equal(response.modelProvider, expectedProvider);
  }, 1000);

  assert.equal(outcome.kind, 'retained_https');
  assert.deepEqual(calls.map((call) => call.method), [
    'thread/unsubscribe',
    'thread/resume',
    'thread/unsubscribe',
    'thread/resume',
  ]);
  assert.equal(calls[1]?.params.modelProvider, 'hive-openai');
  assert.equal(calls[3]?.params.modelProvider, 'hive-openai-http');
});

test('uncertain promotion requests a clean HTTPS restart when repair cannot be proved', async () => {
  let callCount = 0;
  const outcome = await promoteColdResumeProvider({
    async call(method) {
      callCount += 1;
      if (callCount === 1) return { status: 'unsubscribed' };
      if (method === 'thread/resume') throw new Error('promotion response lost');
      throw new Error('repair unsubscribe timed out');
    },
  }, 'thread-current', '/workspace', () => {}, 1000);

  assert.equal(outcome.kind, 'restart_https');
  if (outcome.kind !== 'restart_https') return;
  assert.equal(outcome.stage, 'repair_unsubscribe');
  assert.match(outcome.error.message, /repair unsubscribe timed out/);
});

test('promotion rejects an unrecognized unsubscribe response as uncertain state', async () => {
  const outcome = await promoteColdResumeProvider({
    async call() {
      return { status: 'future-status' };
    },
  }, 'thread-current', '/workspace', () => {}, 1000);

  assert.equal(outcome.kind, 'restart_https');
  if (outcome.kind !== 'restart_https') return;
  assert.equal(outcome.stage, 'initial_unsubscribe');
  assert.match(outcome.error.message, /unrecognized status/);
});

test('post-turn compaction ignores stale or below-threshold usage', async () => {
  let calls = 0;
  const compactor = new PostTurnCompactionCoordinator({
    async call() {
      calls += 1;
      return {};
    },
  }, 160_000, 1000);
  compactor.observeNotification('thread/tokenUsage/updated', {
    threadId: 'thread-current',
    turnId: 'turn-old',
    tokenUsage: {
      last: { inputTokens: 200_000, cachedInputTokens: 190_000, totalTokens: 201_000 },
    },
  });
  assert.deepEqual(
    await compactor.compactAfterTurn('thread-current', 'turn-new'),
    { kind: 'skipped_no_usage', threadId: 'thread-current', turnId: 'turn-new' },
  );
  compactor.observeNotification('thread/tokenUsage/updated', {
    threadId: 'thread-current',
    turnId: 'turn-small',
    tokenUsage: {
      last: { inputTokens: 80_000, cachedInputTokens: 70_000, totalTokens: 81_000 },
    },
  });
  assert.deepEqual(
    await compactor.compactAfterTurn('thread-current', 'turn-small'),
    {
      kind: 'skipped_below_threshold',
      threadId: 'thread-current',
      turnId: 'turn-small',
      inputTokens: 80_000,
    },
  );
  assert.equal(calls, 0);
});

test('pre-compact hook failure terminates without an item or queue timeout', async () => {
  const compactor = new PostTurnCompactionCoordinator({
    async call() {
      return {};
    },
  }, 160_000, 1000);
  compactor.observeNotification('thread/tokenUsage/updated', {
    threadId: 'thread-current',
    turnId: 'turn-large',
    tokenUsage: {
      last: { inputTokens: 175_000, cachedInputTokens: 160_000, totalTokens: 176_000 },
    },
  });

  let settled = false;
  const pending = compactor.compactAfterTurn('thread-current', 'turn-large')
    .then((outcome) => {
      settled = true;
      return outcome;
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(compactor.observeNotification('turn/started', {
    threadId: 'thread-current',
    turn: { id: 'turn-compact', status: 'inProgress' },
  }), true);
  assert.equal(compactor.isOwnedTurn('turn-compact'), true);
  assert.equal(compactor.observeNotification('turn/completed', {
    threadId: 'thread-current',
    turn: { id: 'turn-compact', status: 'interrupted' },
  }), true);
  assert.deepEqual(await pending, {
    kind: 'failed',
    threadId: 'thread-current',
    turnId: 'turn-large',
    inputTokens: 175_000,
    status: 'interrupted',
  });
  assert.equal(settled, true, 'failed pre-compact hook must not wait for ContextCompaction item');
  assert.equal(compactor.isOwnedTurn('turn-compact'), true, 'ownership survives until terminal classification');
  compactor.releaseOwnedTurn('turn-compact');
});

test('final compaction error terminates without waiting for an item', async () => {
  const compactor = new PostTurnCompactionCoordinator({
    async call() {
      return {};
    },
  }, 160_000, 1000);
  compactor.observeNotification('thread/tokenUsage/updated', {
    threadId: 'thread-current',
    turnId: 'turn-large',
    tokenUsage: {
      last: { inputTokens: 175_000, cachedInputTokens: 160_000, totalTokens: 176_000 },
    },
  });
  const pending = compactor.compactAfterTurn('thread-current', 'turn-large');
  await new Promise<void>((resolve) => setImmediate(resolve));
  compactor.observeNotification('turn/started', {
    threadId: 'thread-current',
    turn: { id: 'turn-compact', status: 'inProgress' },
  });
  assert.equal(compactor.observeNotification('error', {
    threadId: 'thread-current',
    turnId: 'turn-compact',
    willRetry: false,
    error: { message: 'pre-compact hook failed' },
  }), true);
  assert.deepEqual(await pending, {
    kind: 'failed',
    threadId: 'thread-current',
    turnId: 'turn-large',
    inputTokens: 175_000,
    status: 'failed',
  });
  assert.equal(compactor.isOwnedTurn('turn-compact'), true);
  compactor.releaseOwnedTurn('turn-compact');
});

test('boot and in-process resume persist policy without starting model turns', () => {
  const channelSource = readFileSync(
    new URL('../codex-channel.ts', import.meta.url),
    'utf8',
  );

  assert.match(
    channelSource,
    /resumePersistedThreadGuarded\(persistedThreadId,\s*appserverModelWebsockets\)/,
  );
  assert.match(
    channelSource,
    /resumePersistedThreadGuarded\(target,\s*appserverModelWebsockets\)/,
  );
  assert.match(channelSource, /rpcCall\(\s*['"]initialize['"]\s*,\s*buildAppServerInitializeParams\(/);
  assert.doesNotMatch(
    channelSource,
    /rpcCall\(\s*['"]thread\/resume['"]\s*,\s*\{\s*threadId:/,
  );
  assert.doesNotMatch(channelSource, /thread\?\.turns\?\.length/);
  assert.match(channelSource, /onAppserverFailure\('process', `codex app-server exited/);
  assert.match(channelSource, /onAppserverFailure\('transport', `WebSocket error/);
  assert.equal(
    channelSource.match(/injectHistory\(briefText/g)?.length,
    2,
    'boot and in-process switch must both inject the session brief as history',
  );
  assert.doesNotMatch(channelSource, /sendTurn\(briefText/);
  assert.doesNotMatch(channelSource, /announceBootstrapComplete|codex-daemon-bootstrap-complete/);
  assert.doesNotMatch(channelSource, /appserver died:/);
});

test('cold resume compacts on HTTPS before ready and only then promotes to WebSockets', () => {
  const channelSource = readFileSync(
    new URL('../codex-channel.ts', import.meta.url),
    'utf8',
  );
  const coordinatorIndex = channelSource.indexOf('postTurnCompactor = new PostTurnCompactionCoordinator');
  const guardedResumeIndex = channelSource.indexOf('await resumePersistedThreadGuarded(persistedThreadId, appserverModelWebsockets)');
  const readyIndex = channelSource.indexOf('await announceReady()');
  const forgetUsageIndex = channelSource.indexOf('postTurnCompactor?.forgetThreadUsage(persistedThreadId)');
  const bootstrapResumeIndex = channelSource.indexOf("rpcCall(\n      'thread/resume',", forgetUsageIndex);
  const uncertaintyIndex = channelSource.indexOf('const compactionUncertainty = coldResumeCompactionUncertainty(compact)');
  const uncertaintyThrowIndex = channelSource.indexOf('throw new ColdResumeAppserverRecycleError(', uncertaintyIndex);
  const recycleLogIndex = channelSource.indexOf('cold-resume state could not be repaired in-place');
  const recycleCleanupIndex = channelSource.indexOf('cleanupAppserver();', recycleLogIndex);
  const forcedHttpsIndex = channelSource.indexOf(
    'await setupAppserver({ ...startupTarget, forceHttps: true })',
    recycleCleanupIndex,
  );
  const switchRecycleIndex = channelSource.indexOf('in-process switch requires app-server recycle');
  const switchCleanupIndex = channelSource.indexOf('cleanupAppserver();', switchRecycleIndex);
  const switchForcedHttpsIndex = channelSource.indexOf(
    'await setupAppserver({ forceHttps: true, persistedThreadId: target })',
    switchCleanupIndex,
  );
  const strictResumeIndex = channelSource.indexOf('if (persistedTarget.strict) throw err;');
  const freshThreadFallbackIndex = channelSource.indexOf("rpcCall('thread/start'", strictResumeIndex);
  const eventProcessorIndex = channelSource.indexOf('async function processNextEvent()');
  const eventGateIndex = channelSource.indexOf('lifecycleGate.tryStartEvent()', eventProcessorIndex);
  const sendTurnIndex = channelSource.indexOf('await sendTurn(text, { eventId })', eventGateIndex);
  const eventReleaseIndex = channelSource.indexOf('lifecycleGate.finishEvent()', sendTurnIndex);
  const rebuildFailureIndex = channelSource.indexOf('forced-HTTPS app-server rebuild failed');
  const keepGateClosedIndex = channelSource.indexOf('releaseSwitchGate = false', rebuildFailureIndex);
  const independentExitIndex = channelSource.indexOf(
    "setImmediate(() => onAppserverFailure('transport', message))",
    keepGateClosedIndex,
  );
  const changedStateIndex = channelSource.indexOf('if (threadStateChanged)', independentExitIndex);
  const commitExitIndex = channelSource.indexOf(
    "setImmediate(() => onAppserverFailure('transport', `thread switch commit failed: ${message}`))",
    changedStateIndex,
  );

  assert.ok(coordinatorIndex >= 0 && coordinatorIndex < guardedResumeIndex);
  assert.ok(guardedResumeIndex < readyIndex);
  assert.ok(forgetUsageIndex >= 0 && forgetUsageIndex < bootstrapResumeIndex);
  assert.ok(uncertaintyIndex >= 0 && uncertaintyIndex < uncertaintyThrowIndex);
  assert.ok(uncertaintyThrowIndex < readyIndex, 'uncertain compact must abort before ready');
  assert.ok(recycleLogIndex >= 0 && recycleLogIndex < recycleCleanupIndex);
  assert.ok(recycleCleanupIndex < forcedHttpsIndex, 'old generation must die before HTTPS rebuild');
  assert.ok(switchRecycleIndex >= 0 && switchRecycleIndex < switchCleanupIndex);
  assert.ok(
    switchCleanupIndex < switchForcedHttpsIndex,
    'in-process switch must destroy the uncertain generation before its HTTPS rebuild',
  );
  assert.ok(
    strictResumeIndex >= 0 && strictResumeIndex < freshThreadFallbackIndex,
    'an explicit forced-HTTPS target must reject before thread/start fallback',
  );
  assert.ok(eventGateIndex < sendTurnIndex && sendTurnIndex < eventReleaseIndex);
  assert.ok(
    rebuildFailureIndex >= 0
      && rebuildFailureIndex < keepGateClosedIndex
      && keepGateClosedIndex < independentExitIndex,
    'failed rebuild must schedule fail-closed exit independently of the HTTP response',
  );
  assert.ok(
    changedStateIndex > independentExitIndex && commitExitIndex > changedStateIndex,
    'a changed thread whose durable ready commit fails must exit independently of the control response',
  );
  assert.match(channelSource, /bootstrapProvider = allowWebsocketPromotion\s*\? HIVE_HTTP_MODEL_PROVIDER_ID/);
  assert.match(channelSource, /inspectPersistedRolloutRisk\(threadRolloutPath, persistedThreadId/);
  assert.match(channelSource, /promoteColdResumeProvider\(/);
  assert.match(channelSource, /setupAppserver\(\{ \.\.\.startupTarget, forceHttps: true \}\)/);
  assert.match(
    channelSource,
    /if \(!lifecycleGate\.tryStartSwitch\(\)\)/,
    'thread switches must acquire the shared lifecycle gate',
  );
  assert.match(
    channelSource,
    /if \(!lifecycleGate\.tryStartEvent\(\)\) return;/,
    'event continuations must acquire the same lifecycle gate',
  );
  assert.match(channelSource, /result\.busy \? 409 : 500/);
  assert.match(channelSource, /generation !== appserverGeneration/);
  assert.doesNotMatch(channelSource, /thread\/read/);
});

test('explicit respawn targets remain strict while inherited restart targets may self-heal', () => {
  const channelSource = readFileSync(
    new URL('../codex-channel.ts', import.meta.url),
    'utf8',
  );
  const strictEnvIndex = channelSource.indexOf("process.env.HIVE_AGENT_STRICT_THREAD_ID || ''");
  const startupTargetIndex = channelSource.indexOf('const startupTarget = HIVE_AGENT_STRICT_THREAD_ID');
  const strictSetupIndex = channelSource.indexOf('await setupAppserver(startupTarget)', startupTargetIndex);
  const strictHttpsIndex = channelSource.indexOf(
    'await setupAppserver({ ...startupTarget, forceHttps: true })',
    strictSetupIndex,
  );
  const requiredIndex = channelSource.indexOf(
    "CODEX_CHANNEL_MODE === 'appserver' || HIVE_EVENT_MODE === 'foreground' || HIVE_AGENT_STRICT_THREAD_ID",
    strictHttpsIndex,
  );

  assert.ok(strictEnvIndex >= 0);
  assert.ok(startupTargetIndex > strictEnvIndex);
  assert.ok(strictSetupIndex > startupTargetIndex);
  assert.ok(strictHttpsIndex > strictSetupIndex);
  assert.ok(
    requiredIndex > strictHttpsIndex,
    'strict resume rejection must be fatal instead of falling back to exec/thread-start',
  );
});

test('WebSocket diagnostics expose nested Undici errors and close details', () => {
  assert.equal(
    describeWebSocketEvent({
      type: 'error',
      error: Object.assign(new Error('Payload size exceeds maximum allowed size'), {
        code: 'WS_ERR_PAYLOAD_TOO_LARGE',
      }),
    }),
    'type=error code=WS_ERR_PAYLOAD_TOO_LARGE message=Payload size exceeds maximum allowed size',
  );
  assert.equal(
    describeWebSocketEvent({ type: 'close', code: 1009, reason: 'Message Too Big' }),
    'type=close code=1009 reason=Message Too Big',
  );
});

test('supervisor watchdog exits only for a confirmed missing process', () => {
  assert.equal(supervisorProcessIsMissing(undefined), false);
  assert.equal(supervisorProcessIsMissing('not-a-pid'), false);
  assert.equal(supervisorProcessIsMissing('42', () => {}), false);
  assert.equal(
    supervisorProcessIsMissing('42', () => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    }),
    false,
  );
  assert.equal(
    supervisorProcessIsMissing('42', () => {
      throw Object.assign(new Error('missing'), { code: 'ESRCH' });
    }),
    true,
  );
});

test('foreground terminal notifications are current-thread, typed, and deduplicated', () => {
  const tracker = new CodexTerminalNotificationTracker('thread-current');

  assert.deepEqual(
    tracker.observe('turn/completed', {
      threadId: 'thread-current',
      turn: { id: 'turn-human', status: 'completed' },
    }, false),
    {
      kind: 'notify',
      notice: {
        threadId: 'thread-current',
        turnId: 'turn-human',
        status: 'completed',
      },
    },
  );
  assert.equal(
    ignoredReason(tracker.observe('turn/completed', {
      threadId: 'thread-current',
      turn: { id: 'turn-human', status: 'completed' },
    }, false)),
    'duplicate',
  );
  assert.equal(
    ignoredReason(tracker.observe('turn/completed', {
      threadId: 'thread-stale',
      turn: { id: 'turn-stale', status: 'completed' },
    }, false)),
    'wrong-thread',
  );
  assert.equal(
    ignoredReason(tracker.observe('error', {
      threadId: 'thread-current',
      turnId: 'turn-retrying',
      willRetry: true,
      error: 'transient',
    }, false)),
    'not-terminal',
  );
});

test('daemon turn ownership survives waiter timeout and blocks UI notification', async () => {
  let now = 1000;
  const transport: RpcTransport = {
    async call() {
      return { turn: { id: 'turn-daemon' } };
    },
  };
  const turns = new TurnTracker(transport, 'thread-current', {
    turnTimeoutMs: 5,
    ownedTurnTtlMs: 1000,
    now: () => now,
  });

  const outcome = await turns.sendTurn('daemon turn');
  assert.equal(outcome.kind, 'timeout');
  assert.equal(turns.isOwnedTurn('turn-daemon'), true);

  const terminals = new CodexTerminalNotificationTracker('thread-current');
  assert.equal(
    ignoredReason(terminals.observe('turn/completed', {
      threadId: 'thread-current',
      turn: { id: 'turn-daemon', status: 'completed' },
    }, turns.isOwnedTurn('turn-daemon'))),
    'daemon-owned',
  );
  turns.releaseOwnedTurn('turn-daemon');
  assert.equal(turns.isOwnedTurn('turn-daemon'), false);
  assert.equal(
    ignoredReason(terminals.observe('turn/completed', {
      threadId: 'thread-current',
      turn: { id: 'turn-daemon', status: 'completed' },
    }, false)),
    'duplicate',
  );

  now += 1001;
  assert.deepEqual(turns.snapshot().ownedTurns, []);
});
