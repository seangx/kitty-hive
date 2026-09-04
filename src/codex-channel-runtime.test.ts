import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CodexChannelLifecycleGate,
  CodexTerminalNotificationTracker,
  TurnTracker,
  buildAppServerInitializeParams,
  buildCodexAppServerArgs,
  buildThreadResumeParams,
  detectResponsesTransportFallback,
  describeWebSocketEvent,
  parseThreadTokenUsage,
  resolvePersistedThreadTarget,
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
      '--session-source',
      'mcp',
      '-c',
      'model_providers.hive-openai={name="OpenAI",wire_api="responses",requires_openai_auth=true,supports_websockets=true,request_max_retries=3,stream_max_retries=3,supports_standalone_web_search=true}',
      '-c',
      'model_provider="hive-openai"',
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
    },
  );
  assert.ok(args.includes(
    'model_providers.hive-openai={name="OpenAI",wire_api="responses",requires_openai_auth=true,supports_websockets=false,request_max_retries=0,stream_max_retries=0,supports_standalone_web_search=true}',
  ));
});

test('Hive app-server leaves Codex auto-compaction policy at its model defaults', () => {
  const args = buildCodexAppServerArgs(
    'ws://127.0.0.1:4567',
    'http://127.0.0.1:4123/mcp',
    [],
  );
  assert.equal(
    args.some((arg) => arg.startsWith('model_auto_compact_token_limit=')),
    false,
  );
  assert.equal(
    args.some((arg) => arg.startsWith('model_auto_compact_token_limit_scope=')),
    false,
  );
});

test('Hive app-server rejects invalid traffic guard settings', () => {
  assert.throws(
    () => buildCodexAppServerArgs('ws://127.0.0.1:1', 'http://127.0.0.1:4123/mcp', [], {
      streamMaxRetries: -1,
    }),
    /streamMaxRetries must be a non-negative safe integer/,
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

test('boot and in-process resume persist policy without starting model turns', () => {
  const channelSource = readFileSync(
    new URL('../codex-channel.ts', import.meta.url),
    'utf8',
  );

  assert.match(
    channelSource,
    /resumePersistedThread\(persistedThreadId\)/,
  );
  assert.match(
    channelSource,
    /resumePersistedThread\(target\)/,
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

test('Hive delegates compaction to Codex and resumes before announcing ready', () => {
  const channelSource = readFileSync(
    new URL('../codex-channel.ts', import.meta.url),
    'utf8',
  );
  const resumeIndex = channelSource.indexOf('await resumePersistedThread(persistedThreadId)');
  const readyIndex = channelSource.indexOf('await announceReady()');

  assert.ok(resumeIndex >= 0 && resumeIndex < readyIndex);
  assert.doesNotMatch(channelSource, /rpcCall\(\s*['"]thread\/compact\/start['"]/);
  assert.doesNotMatch(channelSource, /PostTurnCompactionCoordinator/);
  assert.doesNotMatch(channelSource, /HIVE_CODEX_AUTO_COMPACT_TOKENS/);
  assert.doesNotMatch(channelSource, /HIVE_CODEX_COLD_RESUME_/);
  assert.doesNotMatch(channelSource, /hive-openai-http/);
  assert.match(channelSource, /compaction=codex-managed/);
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
