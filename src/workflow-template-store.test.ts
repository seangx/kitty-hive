import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorkflowTemplate,
  deleteWorkflowTemplate,
  getWorkflowTemplate,
  listWorkflowTemplates,
  updateWorkflowTemplate,
} from './graph-workflow.js';

const workflowDir = mkdtempSync(join(tmpdir(), 'kitty-hive-workflow-store-'));
test.before(() => { process.env.KITTY_HIVE_WORKFLOWS_DIR = workflowDir; });
test.after(() => {
  delete process.env.KITTY_HIVE_WORKFLOWS_DIR;
  rmSync(workflowDir, { recursive: true, force: true });
});

function template(description = 'first') {
  return {
    template_id: 'custom-review',
    template_name: 'Custom review',
    description,
    version: 1 as const,
    definition: {
      kind: 'graph' as const,
      version: 1 as const,
      template_id: 'custom-review',
      template_name: 'Custom review',
      entry_node_id: 'code',
      nodes: [{
        node_id: 'code',
        title: 'Code',
        assignees: ['$assignee'],
        action: 'Implement the task',
        completion: 'all' as const,
      }],
      edges: [],
    },
  };
}

test('seeds packaged JSON once and supports hot CRUD without resurrecting deleted defaults', () => {
  assert.deepEqual(listWorkflowTemplates().map(item => item.template_id), ['review-test-release']);

  createWorkflowTemplate(template());
  assert.equal(getWorkflowTemplate('custom-review')?.description, 'first');
  assert.deepEqual(listWorkflowTemplates().map(item => item.template_id), ['custom-review', 'review-test-release']);

  updateWorkflowTemplate('custom-review', template('updated'));
  assert.equal(getWorkflowTemplate('custom-review')?.description, 'updated');

  deleteWorkflowTemplate('review-test-release');
  assert.deepEqual(listWorkflowTemplates().map(item => item.template_id), ['custom-review']);
});

test('rejects invalid ids, mismatched updates, and duplicate creates', () => {
  assert.throws(() => createWorkflowTemplate(template()), /already exists/);
  assert.throws(() => getWorkflowTemplate('../escape'), /Invalid workflow template id/);
  assert.throws(() => updateWorkflowTemplate('other-id', template()), /cannot change/);
});
