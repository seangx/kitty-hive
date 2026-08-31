import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CODEX_DAEMON_START_CONCURRENCY,
  StartupConcurrencyQueue,
  buildCodexDaemonEnv,
  classifyDaemonThreadSwitchResponse,
  daemonReachedRequestedThread,
  daemonProjectDirHasDrifted,
  resolveDaemonProjectDir,
  shouldDetachDaemonProcess,
  signalCodexAppserverProcessTree,
  signalDaemonProcessTree,
} from './codex-supervisor.js';

test('busy in-process thread switches are authoritative and never a respawn fallback', () => {
  assert.deepEqual(
    classifyDaemonThreadSwitchResponse(409, {
      ok: false,
      busy: true,
      error: 'event turn in flight',
    }),
    { kind: 'busy', error: 'event turn in flight' },
  );
});

test('failed strict rebuild remains an explicit fail-closed rejection', () => {
  assert.deepEqual(
    classifyDaemonThreadSwitchResponse(500, {
      ok: false,
      error: 'explicit thread resume rejected',
      fail_closed: true,
    }),
    {
      kind: 'rejected',
      error: 'explicit thread resume rejected',
      failClosed: true,
    },
  );
});

test('lost control responses reconcile a switch already committed by ready announcement', () => {
  assert.equal(
    daemonReachedRequestedThread('target-thread', 'old-thread', 'target-thread'),
    true,
  );
  assert.equal(
    daemonReachedRequestedThread('', 'old-thread', 'new-thread'),
    true,
  );
  assert.equal(
    daemonReachedRequestedThread('target-thread', 'old-thread', 'old-thread'),
    false,
  );
});

test('admin writes a requested target only after live control is unavailable', () => {
  const source = readFileSync(new URL('../src/admin-http.ts', import.meta.url), 'utf8');
  const switchIndex = source.indexOf('await switchDaemonThread(agent_id, targetThreadId)');
  const unavailableIndex = source.indexOf("if (switched.kind !== 'unavailable')", switchIndex);
  const commitIndex = source.indexOf('db.setAgentThreadId(agent_id, targetThreadId)', unavailableIndex);
  const respawnIndex = source.indexOf('await requestDaemonRespawn(agent_id, 30_000)', commitIndex);

  assert.ok(switchIndex >= 0);
  assert.ok(unavailableIndex > switchIndex);
  assert.ok(commitIndex > unavailableIndex, 'live-control requests must not pre-write the DB target');
  assert.ok(respawnIndex > commitIndex, 'unavailable fallback must commit before daemon env injection');
});

test('boot queue starts only the configured number until slots settle', () => {
  const started: number[] = [];
  const releases = new Map<number, () => void>();
  const queue = new StartupConcurrencyQueue<number>(
    CODEX_DAEMON_START_CONCURRENCY,
    (item, release) => {
      started.push(item);
      releases.set(item, release);
    },
  );

  for (let item = 1; item <= CODEX_DAEMON_START_CONCURRENCY + 2; item += 1) {
    queue.enqueue(item);
  }

  assert.deepEqual(started, [1, 2, 3]);
  assert.deepEqual(queue.snapshot(), { active: 3, pending: 2 });

  releases.get(2)!();
  assert.deepEqual(started, [1, 2, 3, 4]);
  assert.deepEqual(queue.snapshot(), { active: 3, pending: 1 });

  // Completion notices and process-exit cleanup may race; release is
  // intentionally idempotent and must not consume another slot.
  releases.get(2)!();
  assert.deepEqual(started, [1, 2, 3, 4]);
  assert.deepEqual(queue.snapshot(), { active: 3, pending: 1 });
});

test('supervisor releases boot queue capacity when daemon becomes ready', () => {
  const source = readFileSync(new URL('../src/codex-supervisor.ts', import.meta.url), 'utf8');
  const readyFunction = source.slice(
    source.indexOf('export function markDaemonReady('),
    source.indexOf('/** Called by /admin/notify-agent-created'),
  );

  assert.match(readyFunction, /releaseDaemonStartupSlot\(info\)/);
  assert.doesNotMatch(source, /markDaemonBootstrapComplete|codex-daemon-bootstrap-complete/);
});

test('boot queue rejects invalid concurrency limits', () => {
  assert.throws(
    () => new StartupConcurrencyQueue(0, () => undefined),
    /positive integer/,
  );
});

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

test('reaps a reported codex app-server process group on POSIX', () => {
  const calls: Array<[number, NodeJS.Signals]> = [];

  signalCodexAppserverProcessTree(
    456,
    'SIGTERM',
    (pid, signal) => calls.push([pid, signal]),
    'darwin',
  );

  assert.deepEqual(calls, [
    [-456, 'SIGTERM'],
    [456, 'SIGTERM'],
  ]);
});

test('ignores missing or invalid reported app-server pids', () => {
  const calls: number[] = [];
  const kill = (pid: number) => calls.push(pid);

  signalCodexAppserverProcessTree(null, 'SIGTERM', kill, 'darwin');
  signalCodexAppserverProcessTree(0, 'SIGTERM', kill, 'darwin');
  signalCodexAppserverProcessTree(-1, 'SIGTERM', kill, 'darwin');

  assert.deepEqual(calls, []);
});
