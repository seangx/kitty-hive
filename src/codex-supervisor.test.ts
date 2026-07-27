import assert from 'node:assert/strict';
import test from 'node:test';
import {
  daemonProjectDirHasDrifted,
  resolveDaemonProjectDir,
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
