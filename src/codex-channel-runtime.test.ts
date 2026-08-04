import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CodexTerminalNotificationTracker,
  TurnTracker,
  buildAppServerInitializeParams,
  buildThreadResumeParams,
  describeWebSocketEvent,
  supervisorProcessIsMissing,
  type CodexTerminalDecision,
  type RpcTransport,
} from './codex-channel-runtime.js';

function ignoredReason(decision: CodexTerminalDecision): string | undefined {
  return decision.kind === 'ignored' ? decision.reason : undefined;
}

test('thread resume keeps server-side history without returning serialized turns', () => {
  assert.deepEqual(
    buildThreadResumeParams(
      '019fa11b-79eb-79e3-8628-863405bf27de',
      '/Users/example/.kitty-kitty/sessions/e2f81622',
    ),
    {
      threadId: '019fa11b-79eb-79e3-8628-863405bf27de',
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

test('boot and in-process resume paths both use the metadata-only builder', () => {
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
