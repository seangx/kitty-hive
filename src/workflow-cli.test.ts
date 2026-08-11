import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./index.js', import.meta.url));

test('workflow CLI performs JSON CRUD against the configured template directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitty-hive-workflow-cli-'));
  const input = join(dir, 'cli-template-input.json');
  const template = {
    template_id: 'cli-template',
    template_name: 'CLI template',
    description: 'created from CLI',
    version: 1,
    definition: {
      kind: 'graph',
      version: 1,
      template_id: 'cli-template',
      template_name: 'CLI template',
      entry_node_id: 'work',
      nodes: [{ node_id: 'work', title: 'Work', assignees: ['$assignee'], action: 'Do work', completion: 'all' }],
      edges: [],
    },
  };
  writeFileSync(input, JSON.stringify(template));
  const env = { ...process.env, KITTY_HIVE_WORKFLOWS_DIR: join(dir, 'store') };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, 'workflow', ...args], { env, encoding: 'utf8' });

  try {
    assert.equal(run('create', input).status, 0);
    const get = run('get', 'cli-template');
    assert.equal(get.status, 0);
    assert.equal(JSON.parse(get.stdout).description, 'created from CLI');

    template.description = 'updated from CLI';
    writeFileSync(input, JSON.stringify(template));
    assert.equal(run('update', 'cli-template', input).status, 0);
    const list = run('list', '--json');
    assert.equal(list.status, 0);
    assert.equal(JSON.parse(list.stdout).find((item: { template_id: string }) => item.template_id === 'cli-template').description, 'updated from CLI');

    assert.equal(run('delete', 'cli-template').status, 1);
    assert.match(run('delete', 'cli-template').stderr, /--yes/);
    assert.equal(run('delete', 'cli-template', '--yes').status, 0);
    assert.equal(run('get', 'cli-template').status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
