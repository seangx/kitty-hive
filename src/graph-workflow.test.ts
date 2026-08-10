import assert from 'node:assert/strict';
import test from 'node:test';
import * as db from './db.js';
import {
  handleGraphGateDecision,
  handleGraphNodeComplete,
  handleGraphWorkflowStart,
  handleCheck,
  handleTaskClaim,
  handleTaskComplete,
  handleTaskCreate,
} from './tools/task.js';
import { getSidecarRun, getSidecarSnapshot } from './sidecar-read-model.js';
import type { GraphWorkflowDefinition } from './models.js';

test('ordinary tasks start immediately while an explicit graph workflow preserves rollback activations', () => {
  db.initDB(':memory:');
  const creator = db.createAgent('Creator', 'codex', 'master', '');
  const coder = db.createAgent('Coder', 'codex', 'coder', '');
  const reviewer = db.createAgent('Reviewer', 'codex', 'reviewer', '');
  const tester = db.createAgent('Tester', 'codex', 'tester', '');

  const ordinary = handleTaskCreate(creator.id, { to: coder.id, title: 'Small fix' });
  assert.equal(ordinary.status, 'in_progress');
  handleTaskComplete(ordinary.task_id, coder.id, 'done');
  assert.equal(db.getTaskById(ordinary.task_id)?.status, 'completed');

  const unassigned = handleTaskCreate(creator.id, { title: 'Claim me' });
  assert.equal(unassigned.status, 'created');
  assert.equal(handleTaskClaim(unassigned.task_id, coder.id).status, 'in_progress');

  const run = handleGraphWorkflowStart(creator.id, {
    template_id: 'review-test-release',
    to: coder.id,
    title: 'Ship graph kernel',
    workspace_dir: '/tmp/graph-kernel',
    branch: 'refactor/graph-workflow-kernel',
  });
  assert.equal(run.status, 'in_progress');
  assert.equal(run.action.node_id, 'implement');

  assert.equal(handleGraphNodeComplete(run.task_id, coder.id, 'passed').node_id, 'review');
  assert.equal(handleGraphNodeComplete(run.task_id, reviewer.id, 'changes_requested', 'fix boundary').node_id, 'implement');
  assert.equal(handleGraphNodeComplete(run.task_id, coder.id, 'passed').node_id, 'review');
  assert.equal(handleGraphNodeComplete(run.task_id, reviewer.id, 'passed').node_id, 'e2e');
  assert.equal(handleGraphNodeComplete(run.task_id, tester.id, 'changes_requested', 'browser regression').node_id, 'implement');
  assert.equal(handleGraphNodeComplete(run.task_id, coder.id, 'passed').node_id, 'review');
  assert.equal(handleGraphNodeComplete(run.task_id, reviewer.id, 'passed').node_id, 'e2e');
  assert.equal(handleGraphNodeComplete(run.task_id, tester.id, 'passed').node_id, 'release-review');
  assert.equal(handleGraphNodeComplete(run.task_id, reviewer.id, 'passed').type, 'task-complete');
  assert.equal(db.getTaskById(run.task_id)?.status, 'completed');

  const detail = getSidecarRun(run.task_id);
  assert.ok(detail);
  assert.equal(detail.summary.template.templateId, 'review-test-release');
  assert.equal(detail.summary.workspaceDir, '/tmp/graph-kernel');
  assert.equal(detail.summary.branch, 'refactor/graph-workflow-kernel');
  assert.deepEqual(
    detail.nodeRuns.filter(nodeRun => nodeRun.nodeId === 'implement').map(nodeRun => nodeRun.activation),
    [1, 2, 3],
  );
  assert.deepEqual(
    detail.takenEdgeIds.filter(edgeId => edgeId === 'review-changes-implement'),
    ['review-changes-implement'],
  );
  assert.deepEqual(
    detail.takenEdgeIds.filter(edgeId => edgeId === 'e2e-changes-implement'),
    ['e2e-changes-implement'],
  );
  assert.equal(handleCheck({ task_id: run.task_id }).input.workspace_dir, '/tmp/graph-kernel');

  const snapshot = getSidecarSnapshot();
  assert.equal(snapshot.agentPool.length, 4);
  assert.ok(snapshot.agentPool.every(agent => agent.launchMode === 'resident'));

  const gatedDefinition: GraphWorkflowDefinition = {
    kind: 'graph',
    version: 1,
    template_id: 'gated-test',
    template_name: 'Gated test',
    entry_node_id: 'approval',
    nodes: [{
      node_id: 'approval',
      title: 'Creator gate',
      assignees: [coder.id],
      action: 'prepare evidence',
      completion: 'all',
      gate: true,
    }],
    edges: [],
  };
  const gatedTask = db.createTask('Gated run', creator.id, { assigneeId: coder.id });
  db.updateTaskStatus(gatedTask.id, 'in_progress', {
    workflow_json: JSON.stringify(gatedDefinition),
    current_step: 1,
  });
  db.appendTaskEvent(gatedTask.id, 'task-start', creator.id);
  db.appendTaskEvent(gatedTask.id, 'workflow-start', creator.id, { template_id: 'gated-test' });
  db.appendTaskEvent(gatedTask.id, 'node-start', null, { node_id: 'approval', activation: 1, assignees: [coder.id] });
  assert.equal(handleGraphNodeComplete(gatedTask.id, coder.id, 'passed').type, 'awaiting_approval');
  assert.equal(handleGraphGateDecision(gatedTask.id, creator.id, 'approved').type, 'task-complete');
  const gatedDetail = getSidecarRun(gatedTask.id);
  assert.equal(gatedDetail?.approvals.at(-1)?.status, 'approved');
  assert.equal(gatedDetail?.nodeRuns.at(-1)?.status, 'succeeded');
});
