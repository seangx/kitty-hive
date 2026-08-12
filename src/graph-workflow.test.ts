import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { createWorkflowTemplate } from './graph-workflow.js';
import type { GraphWorkflowDefinition } from './models.js';

const workflowDir = mkdtempSync(join(tmpdir(), 'kitty-hive-graph-test-'));
test.before(() => { process.env.KITTY_HIVE_WORKFLOWS_DIR = workflowDir; });
test.after(() => {
  delete process.env.KITTY_HIVE_WORKFLOWS_DIR;
  rmSync(workflowDir, { recursive: true, force: true });
});

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

  const review1 = handleGraphNodeComplete(run.task_id, coder.id, 'passed');
  assert.equal(review1.node_id, 'review');
  const reviewAgent1 = review1.assignees![0];
  assert.notEqual(reviewAgent1, reviewer.id);
  assert.equal(db.getAgentById(reviewAgent1)?.parent_agent_id, reviewer.id);
  assert.equal(db.getAgentById(reviewAgent1)?.pool_enabled, 0);
  assert.equal(handleGraphNodeComplete(run.task_id, reviewAgent1, 'changes_requested', 'fix boundary').node_id, 'implement');

  const review2 = handleGraphNodeComplete(run.task_id, coder.id, 'passed');
  const reviewAgent2 = review2.assignees![0];
  assert.notEqual(reviewAgent2, reviewAgent1, 'fresh_per_activation must rotate the reviewer context');
  const e2e1 = handleGraphNodeComplete(run.task_id, reviewAgent2, 'passed');
  assert.equal(e2e1.node_id, 'e2e');
  const testerRunAgent = e2e1.assignees![0];
  assert.notEqual(testerRunAgent, tester.id);
  assert.equal(db.getAgentById(testerRunAgent)?.parent_agent_id, tester.id);
  assert.equal(handleGraphNodeComplete(run.task_id, testerRunAgent, 'changes_requested', 'browser regression').node_id, 'implement');

  const review3 = handleGraphNodeComplete(run.task_id, coder.id, 'passed');
  const reviewAgent3 = review3.assignees![0];
  const e2e2 = handleGraphNodeComplete(run.task_id, reviewAgent3, 'passed');
  assert.equal(e2e2.assignees![0], testerRunAgent, 'fresh_per_run must reuse its context after a workflow loop');
  const release = handleGraphNodeComplete(run.task_id, testerRunAgent, 'passed');
  assert.equal(release.node_id, 'release-review');
  const releaseReviewer = release.assignees![0];
  assert.notEqual(releaseReviewer, reviewAgent3);
  assert.equal(handleGraphNodeComplete(run.task_id, releaseReviewer, 'passed').type, 'task-complete');
  assert.equal(db.getTaskById(run.task_id)?.status, 'completed');
  assert.ok(db.listWorkflowRuntimeAgents(run.task_id).every(agent => agent.runtime_enabled === 0));

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
  assert.ok(snapshot.agentPool.every(agent => agent.enabled));
  assert.deepEqual(snapshot.workflowTemplates.map(template => template.templateId), ['review-test-release']);
  const templatePreview = snapshot.workflowTemplates[0];
  assert.ok(templatePreview);
  assert.equal((templatePreview.graph.nodes[0]?.action?.length ?? 0) > 0, true);

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

test('pool disable only affects role routing while concrete workflow assignment remains available', () => {
  db.initDB(':memory:');
  const creator = db.createAgent('Creator', 'codex', 'master', '');
  const coder = db.createAgent('Coder', 'codex', 'coder', '');
  const reviewer = db.createAgent('Reviewer', 'codex', 'reviewer', '');
  db.createAgent('Tester', 'codex', 'tester', '');

  db.setAgentPoolEnabled(reviewer.id, false);
  assert.equal(db.findAgentByRole('reviewer'), undefined);
  assert.equal(db.getAgentById(reviewer.id)?.runtime_enabled, 1, 'Pool disable must keep the resident runtime alive');

  assert.throws(() => handleGraphWorkflowStart(creator.id, {
    template_id: 'review-test-release',
    to: coder.id,
    title: 'Role routing should reject disabled reviewer',
  }), /No active agent found for role:reviewer/);

  const explicit = handleTaskCreate(creator.id, { to: reviewer.id, title: 'Manual review' });
  assert.equal(explicit.assignee?.id, reviewer.id);

  createWorkflowTemplate({
    template_id: 'explicit-disabled-reviewer',
    template_name: 'Explicit disabled reviewer',
    description: 'Concrete assignment bypasses Pool routing',
    version: 1,
    definition: {
      kind: 'graph',
      version: 1,
      template_id: 'explicit-disabled-reviewer',
      template_name: 'Explicit disabled reviewer',
      entry_node_id: 'review',
      nodes: [{
        node_id: 'review',
        title: 'Review',
        assignees: [reviewer.id],
        action: 'Review independently',
        completion: 'all',
        context: { mode: 'fresh_per_activation' },
      }],
      edges: [],
    },
  });
  const concreteRun = handleGraphWorkflowStart(creator.id, {
    template_id: 'explicit-disabled-reviewer',
    to: coder.id,
    title: 'Explicit disabled reviewer still works',
  });
  assert.equal(concreteRun.action.context_bindings?.[0].base_agent_id, reviewer.id);
  assert.notEqual(concreteRun.action.assignees?.[0], reviewer.id);

  const snapshot = getSidecarSnapshot();
  assert.equal(snapshot.agentPool.find(agent => agent.agentId === reviewer.id)?.enabled, false);
});
