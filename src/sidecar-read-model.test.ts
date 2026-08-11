import assert from 'node:assert/strict';
import test from 'node:test';
import type { Agent, Task, TaskEvent, WorkflowStep } from './models.js';
import { projectStandaloneTask, projectWorkflowRun } from './sidecar-read-model.js';
import { publishSidecarWake, sidecarSubscriberCount, subscribeSidecarWakes } from './sidecar-events.js';

const agents: Agent[] = [
  makeAgent('creator', 'Creator'),
  makeAgent('coder', 'Coder'),
  makeAgent('reviewer', 'Reviewer'),
];

function makeAgent(id: string, displayName: string): Agent {
  return {
    id,
    display_name: displayName,
    token: `token-${id}`,
    tool: 'codex',
    roles: '',
    expertise: '',
    status: 'active',
    created_at: '2026-08-10T00:00:00.000Z',
    last_seen: '2026-08-10T00:00:00.000Z',
    origin_peer: '',
    remote_id: '',
    external_key: id,
    project_dir: '/tmp/project',
    thread_id: '',
    event_mode: 'foreground',
  };
}

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 'task-1',
    title: 'Ship Sidecar',
    creator_agent_id: 'creator',
    assignee_agent_id: 'coder',
    status: 'proposing',
    workflow_json: null,
    current_step: 0,
    source_team_id: null,
    input_json: '{}',
    created_at: '2026-08-10T00:00:00.000Z',
    completed_at: null,
    originator_peer: '',
    originator_task_id: '',
    delegated_peer: '',
    delegated_task_id: '',
    ...overrides,
  };
}

function event(seq: number, type: TaskEvent['type'], payload: object, actor: string | null = null): TaskEvent {
  return {
    id: seq,
    task_id: 'task-1',
    seq,
    type,
    actor_agent_id: actor,
    payload_json: JSON.stringify(payload),
    ts: `2026-08-10T00:00:${String(seq).padStart(2, '0')}.000Z`,
  };
}

const resolveAgent = (id: string) => agents.find(agent => agent.id === id);

test('projects a standalone assigned task without exposing legacy proposing status', () => {
  const task = makeTask({ status: 'proposing' });
  const detail = projectStandaloneTask(task, [event(1, 'task-start', {}, 'creator')], resolveAgent);

  assert.ok(detail);
  assert.equal(detail.status, 'claimed');
  assert.equal(detail.assigneeAgentId, 'coder');
  assert.equal(detail.assigneeName, 'Coder');
  assert.equal(detail.attempts.length, 1);
});

test('projects rollback activations and a creator gate from authoritative task events', () => {
  const steps: WorkflowStep[] = [
    { step: 1, title: 'Code', assignees: ['coder'], action: 'implement', completion: 'all', completed_by: ['coder'] },
    { step: 2, title: 'Review', assignees: ['reviewer'], action: 'review', completion: 'all', on_reject: 'back:1', gate: true, completed_by: ['reviewer'] },
  ];
  const task = makeTask({
    status: 'awaiting_approval',
    workflow_json: JSON.stringify(steps),
    current_step: 2,
  });
  const events: TaskEvent[] = [
    event(1, 'task-start', {}, 'creator'),
    event(2, 'task-propose', { workflow: steps }, 'coder'),
    event(3, 'task-approve', {}, 'creator'),
    event(4, 'step-start', { step: 1 }),
    event(5, 'step-complete', { step: 1 }, 'coder'),
    event(6, 'step-start', { step: 2 }),
    event(7, 'step-complete', { step: 2 }, 'reviewer'),
    event(8, 'task-reject', { step: 2, target_step: 1, reason: 'fix tests' }, 'reviewer'),
    event(9, 'step-start', { step: 1 }),
    event(10, 'step-complete', { step: 1 }, 'coder'),
    event(11, 'step-start', { step: 2 }),
    event(12, 'step-complete', { step: 2 }, 'reviewer'),
  ];

  const detail = projectWorkflowRun(task, events, resolveAgent);
  assert.ok(detail);
  assert.equal(detail.summary.status, 'waiting_approval');
  assert.equal(detail.summary.awaitingCreator, true);
  assert.deepEqual(detail.summary.assigneeAgentIds, ['reviewer']);
  assert.deepEqual(
    detail.nodeRuns.map(run => [run.nodeId, run.activation, run.status]),
    [
      ['step:1', 1, 'succeeded'],
      ['step:2', 1, 'failed'],
      ['step:1', 2, 'succeeded'],
      ['step:2', 2, 'waiting_approval'],
    ],
  );
  assert.deepEqual(detail.takenEdgeIds, [
    'edge:1:2:passed',
    'edge:2:1:changes_requested',
    'edge:1:2:passed',
  ]);
  assert.equal(detail.approvals.at(-1)?.status, 'pending');
});

test('sidecar wake subscriptions are removed deterministically', () => {
  const received: string[] = [];
  const unsubscribe = subscribeSidecarWakes(wake => received.push(wake.taskId));
  assert.equal(sidecarSubscriberCount(), 1);

  publishSidecarWake({ taskId: 'task-1', cursor: 1 });
  unsubscribe();
  publishSidecarWake({ taskId: 'task-2', cursor: 1 });

  assert.deepEqual(received, ['task-1']);
  assert.equal(sidecarSubscriberCount(), 0);
});
