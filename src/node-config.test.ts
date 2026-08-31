import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  getNodeConfig,
  resolveServeCodexCommand,
  setNodeConfig,
} from './node-config.js';

test('serve uses the persisted Codex command when no environment override exists', () => {
  assert.equal(
    resolveServeCodexCommand(undefined, { codexCommand: 'codex-debug' }),
    'codex-debug',
  );
});

test('CODEX_CMD remains the highest-priority serve override', () => {
  assert.equal(
    resolveServeCodexCommand(' /opt/bin/codex-one-off ', { codexCommand: 'codex-debug' }),
    '/opt/bin/codex-one-off',
  );
});

test('node config updates preserve existing values', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kitty-hive-node-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  setNodeConfig({ name: 'marvin' }, path);
  setNodeConfig({ codexCommand: 'codex-debug' }, path);

  assert.deepEqual(getNodeConfig(path), {
    name: 'marvin',
    codexCommand: 'codex-debug',
  });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).codexCommand, 'codex-debug');
});
