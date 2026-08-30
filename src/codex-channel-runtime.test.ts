import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CodexTerminalNotificationTracker,
  PostTurnCompactionCoordinator,
  TurnTracker,
  buildAppServerInitializeParams,
  buildCodexAppServerArgs,
  buildThreadResumeParams,
  detectResponsesTransportFallback,
  describeWebSocketEvent,
  parseThreadTokenUsage,
  supervisorProcessIsMissing,
  type CodexTerminalDecision,
  type RpcTransport,
} from './codex-channel-runtime.js';

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
      'model_providers.hive-openai={name="OpenAI",wire_api="responses",requires_openai_auth=true,supports_websockets=true,request_max_retries=1,stream_max_retries=1,supports_standalone_web_search=true}',
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
  const cwdAwareResumeCalls = channelSource.match(
    /buildThreadResumeParams\([^,]+,\s*CODEX_APPSERVER_CWD\)/g,
  );

  assert.equal(cwdAwareResumeCalls?.length, 2);
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
