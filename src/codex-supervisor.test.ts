import assert from 'node:assert/strict';
import test from 'node:test';
import {
  daemonProjectDirHasDrifted,
  resolveDaemonProjectDir,
  shouldDetachDaemonProcess,
  signalDaemonProcessTree,
} from './codex-supervisor.js';

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
