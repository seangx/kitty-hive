import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCodexDaemonEnv,
  daemonProjectDirHasDrifted,
  resolveDaemonProjectDir,
  shouldDetachDaemonProcess,
  signalDaemonProcessTree,
} from './codex-supervisor.js';

test('daemon env restores only the authoritative agent Kitty key', () => {
  const env = buildCodexDaemonEnv(
    {
      PATH: '/opt/homebrew/bin',
      HIVE_AGENT_KEY: 'wrong-inherited-key',
      HIVE_AGENT_ID: 'wrong-inherited-agent',
      HIVE_EVENT_MODE: 'foreground',
    },
    {
      agentId: 'agent-123',
      displayName: 'reviewer',
      externalKey: 'kitty-session-456',
      projectDir: '/Users/example/project',
      eventMode: 'auto',
      threadId: 'thread-789',
      supervisorPort: 4123,
      supervisorPid: 99,
    },
  );

  assert.deepEqual(env, {
    PATH: '/opt/homebrew/bin',
    HIVE_AGENT_ID: 'agent-123',
    HIVE_AGENT_NAME: 'reviewer',
    HIVE_AGENT_KEY: 'kitty-session-456',
    HIVE_URL: 'http://127.0.0.1:4123/mcp',
    HIVE_SUPERVISOR_PID: '99',
    CODEX_APPSERVER_CWD: '/Users/example/project',
    HIVE_EVENT_MODE: 'auto',
    HIVE_AGENT_THREAD_ID: 'thread-789',
  });
});

test('daemon env does not invent a Kitty key for unmanaged agents', () => {
  const env = buildCodexDaemonEnv(
    { HIVE_AGENT_KEY: 'wrong-inherited-key' },
    {
      agentId: 'agent-123',
      displayName: 'reviewer',
      externalKey: '',
      projectDir: '/Users/example/project',
      eventMode: 'foreground',
      threadId: '',
      supervisorPort: 4123,
      supervisorPid: 99,
    },
  );

  assert.equal(env.HIVE_AGENT_KEY, undefined);
  assert.equal(env.HIVE_AGENT_THREAD_ID, undefined);
});

test('detects a project_dir added after the daemon was spawned', () => {
  const serveCwd = '/Users/example';
  const sessionCwd = '/Users/example/.kitty-kitty/sessions/abc123';

  const spawnedWith = resolveDaemonProjectDir('', serveCwd);

  assert.equal(spawnedWith, serveCwd);
  assert.equal(
    daemonProjectDirHasDrifted(spawnedWith, sessionCwd, serveCwd),
    true,
  );
});

test('does not restart when configured and spawned cwd are equivalent', () => {
  const serveCwd = '/Users/example';
  const sessionCwd = '/Users/example/project';

  assert.equal(
    daemonProjectDirHasDrifted(`${sessionCwd}/`, sessionCwd, serveCwd),
    false,
  );
  assert.equal(
    daemonProjectDirHasDrifted(serveCwd, '', serveCwd),
    false,
  );
});

test('supervised daemons use process groups on POSIX', () => {
  assert.equal(shouldDetachDaemonProcess('darwin'), true);
  assert.equal(shouldDetachDaemonProcess('linux'), true);
  assert.equal(shouldDetachDaemonProcess('win32'), false);
});

test('signals the daemon process group and direct wrapper on POSIX', () => {
  const calls: Array<[string, number | NodeJS.Signals]> = [];

  signalDaemonProcessTree(
    123,
    'SIGTERM',
    () => calls.push(['direct', 'SIGTERM']),
    (pid, signal) => calls.push([signal, pid]),
    'darwin',
  );

  assert.deepEqual(calls, [
    ['SIGTERM', -123],
    ['direct', 'SIGTERM'],
  ]);
});

test('signals only the direct wrapper on Windows', () => {
  const calls: string[] = [];

  signalDaemonProcessTree(
    123,
    'SIGTERM',
    () => calls.push('direct'),
    () => calls.push('group'),
    'win32',
  );

  assert.deepEqual(calls, ['direct']);
});
