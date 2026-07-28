import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildThreadResumeParams,
  supervisorProcessIsMissing,
} from './codex-channel-runtime.js';

test('thread resume keeps history while overriding stale project cwd', () => {
  assert.deepEqual(
    buildThreadResumeParams(
      '019fa11b-79eb-79e3-8628-863405bf27de',
      '/Users/example/.kitty-kitty/sessions/e2f81622',
    ),
    {
      threadId: '019fa11b-79eb-79e3-8628-863405bf27de',
      cwd: '/Users/example/.kitty-kitty/sessions/e2f81622',
    },
  );
});

test('boot and in-process resume paths both carry the daemon project cwd', () => {
  const channelSource = readFileSync(
    new URL('../codex-channel.ts', import.meta.url),
    'utf8',
  );
  const cwdAwareResumeCalls = channelSource.match(
    /buildThreadResumeParams\([^,]+,\s*CODEX_APPSERVER_CWD\)/g,
  );

  assert.equal(cwdAwareResumeCalls?.length, 2);
  assert.doesNotMatch(
    channelSource,
    /rpcCall\(\s*['"]thread\/resume['"]\s*,\s*\{\s*threadId:/,
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
