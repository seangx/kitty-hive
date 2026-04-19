import {
  getAgentById, findAgentByRole, resolveAddressee,
  createTask, getTaskById, updateTaskStatus, setTaskDelegation,
  appendTaskEvent, getTaskEvents, getPeerByName,
  ensureRemoteAgentByRemoteId,
} from '../db.js';
import { validateTransition, validateWorkflowTransition, shouldAdvanceStep, getRejectTarget } from '../state-machine.js';
import type { Task, TaskEvent, TaskStatus, WorkflowStep } from '../models.js';

// --- hive.task ---

interface TaskInput {
  to?: string;
  title: string;
  input?: object;
  source_team_id?: string;
}

interface TaskOutput {
  task_id: string;
  title: string;
  status: TaskStatus;
  assignee?: { id: string; display_name: string };
}

export function handleTaskCreate(actorId: string, input: TaskInput): TaskOutput {
  let assignee: { id: string; display_name: string } | undefined;

  if (input.to) {
    if (input.to.startsWith('role:')) {
      const agent = findAgentByRole(input.to.slice(5));
      if (agent) assignee = { id: agent.id, display_name: agent.display_name };
    } else {
      const resolved = resolveAddressee(actorId, input.to);
      if ('error' in resolved) throw new Error(resolved.error);
      assignee = { id: resolved.agent!.id, display_name: resolved.agent!.display_name };
    }
  }

  const task = createTask(input.title, actorId, {
    assigneeId: assignee?.id,
    sourceTeamId: input.source_team_id,
    input: input.input,
  });

  // task-start → proposing (assignee should propose workflow)
  validateWorkflowTransition('created' as TaskStatus, 'task-start');
  appendTaskEvent(task.id, 'task-start', actorId, {
    title: input.title, input: input.input, assignee_agent_id: assignee?.id ?? null,
  });

  let status: TaskStatus = assignee ? 'proposing' : 'created';
  updateTaskStatus(task.id, status, assignee ? { assignee_agent_id: assignee.id } : {});

  return { task_id: task.id, title: task.title, status, assignee };
}

// --- Federated task ---

function parseTarget(to: string): { agent: string; node?: string } {
  const at = to.lastIndexOf('@');
  if (at > 0) return { agent: to.slice(0, at), node: to.slice(at + 1) };
  return { agent: to };
}

export async function handleTaskCreateAsync(actorId: string, input: TaskInput): Promise<TaskOutput> {
  if (!input.to) return handleTaskCreate(actorId, input);

  const { agent: targetId, node } = parseTarget(input.to);
  if (!node) return handleTaskCreate(actorId, { ...input, to: targetId });

  // --- Federated task ---
  const peer = getPeerByName(node);
  if (!peer) throw new Error(`Peer "${node}" not found`);

  const actor = getAgentById(actorId);
  if (!actor) throw new Error('Actor not found');

  // Create local placeholder for the remote assignee (will be the assignee on our shadow task).
  // We don't know the remote display_name yet, so use targetId as a temporary label.
  const remoteAssigneePlaceholder = ensureRemoteAgentByRemoteId(targetId, node, targetId);

  // Local shadow task — represents the delegated work, status starts at proposing
  // (our user can later approve/reject; the real workflow lives on the peer).
  const shadow = createTask(input.title, actorId, {
    assigneeId: remoteAssigneePlaceholder.id,
    sourceTeamId: input.source_team_id,
    input: input.input,
    delegatedPeer: node,
  });
  appendTaskEvent(shadow.id, 'task-start', actorId, {
    title: input.title, input: input.input, assignee_agent_id: remoteAssigneePlaceholder.id, federated_to: `${targetId}@${node}`,
  });
  updateTaskStatus(shadow.id, 'proposing', { assignee_agent_id: remoteAssigneePlaceholder.id });

  // Send to peer
  const res = await fetch(peer.url.replace('/mcp', '/federation/task'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${peer.secret}`,
      'X-Hive-Peer': node,
    },
    body: JSON.stringify({
      from_agent_id: actor.id,
      from_display_name: actor.display_name,
      to: targetId,
      title: input.title,
      input: input.input,
      originator_task_id: shadow.id,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`Federation task failed: ${(err as any).error || res.statusText}`);
  }

  const result = await res.json() as { task_id: string; status: string };
  // Record peer's task id on shadow so we can debug / detect duplicates
  setTaskDelegation(shadow.id, node, result.task_id);

  return {
    task_id: shadow.id,
    title: input.title,
    status: 'proposing',
    assignee: { id: remoteAssigneePlaceholder.id, display_name: `${targetId}@${node}` },
  };
}

// --- Federated task event ---

export async function sendFederatedTaskEvent(
  taskId: string, peerNode: string, fromAgentId: string, fromDisplayName: string,
  type: string, extras: Record<string, any> = {},
): Promise<any> {
  const peer = getPeerByName(peerNode);
  if (!peer) throw new Error(`Peer "${peerNode}" not found`);

  const res = await fetch(peer.url.replace('/mcp', '/federation/task/event'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${peer.secret}`,
      'X-Hive-Peer': peerNode,
    },
    body: JSON.stringify({
      from_agent_id: fromAgentId,
      from_display_name: fromDisplayName,
      task_id: taskId, type, ...extras,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`Federation task event failed: ${(err as any).error || res.statusText}`);
  }

  return res.json();
}

// Forward a workflow event to whichever side this task is linked with.
// On replica (originator_peer set): echo back to originator using originator_task_id.
// On originator (delegated_peer set): forward to replica using delegated_task_id.
async function forwardTaskEvent(task: Task, actorId: string, type: string, extras: Record<string, any> = {}): Promise<void> {
  const actor = getAgentById(actorId);
  if (!actor) return;
  // Don't echo events whose actor is itself a remote placeholder (those events arrived via federation).
  if (actor.origin_peer) return;

  if (task.originator_peer && task.originator_task_id) {
    try {
      await sendFederatedTaskEvent(task.originator_task_id, task.originator_peer, actor.id, actor.display_name, type, extras);
    } catch (err) {
      console.warn(`[federation] failed to echo event to originator ${task.originator_peer}: ${(err as any).message ?? err}`);
    }
  }
  if (task.delegated_peer && task.delegated_task_id) {
    try {
      await sendFederatedTaskEvent(task.delegated_task_id, task.delegated_peer, actor.id, actor.display_name, type, extras);
    } catch (err) {
      console.warn(`[federation] failed to forward event to replica ${task.delegated_peer}: ${(err as any).message ?? err}`);
    }
  }
}

// --- Async wrappers (used by MCP tool layer; auto-forward to peer if task is linked) ---

export async function handleWorkflowProposeAsync(taskId: string, agentId: string, workflow: WorkflowStep[]): Promise<void> {
  handleWorkflowPropose(taskId, agentId, workflow);
  const task = getTaskById(taskId);
  if (task) await forwardTaskEvent(task, agentId, 'task-propose', { workflow: JSON.parse(task.workflow_json || '[]') });
}

export async function handleWorkflowApproveAsync(taskId: string, agentId: string): Promise<WorkflowAction> {
  const action = handleWorkflowApprove(taskId, agentId);
  const task = getTaskById(taskId);
  if (task) await forwardTaskEvent(task, agentId, 'task-approve', {});
  return action;
}

export async function handleStepCompleteAsync(taskId: string, agentId: string, stepNum: number, result?: string): Promise<WorkflowAction | null> {
  const action = handleStepComplete(taskId, agentId, stepNum, result);
  const task = getTaskById(taskId);
  if (task) await forwardTaskEvent(task, agentId, 'step-complete', { step: stepNum, result });
  return action;
}

export async function handleStepApproveAsync(taskId: string, agentId: string): Promise<WorkflowAction> {
  const action = handleStepApprove(taskId, agentId);
  const task = getTaskById(taskId);
  if (task) await forwardTaskEvent(task, agentId, 'step-approve', { step: task.current_step });
  return action;
}

export async function handleWorkflowRejectAsync(taskId: string, agentId: string, stepNum: number, reason?: string): Promise<WorkflowAction> {
  const action = handleWorkflowReject(taskId, agentId, stepNum, reason);
  const task = getTaskById(taskId);
  if (task) await forwardTaskEvent(task, agentId, 'task-reject', { step: stepNum, reason });
  return action;
}

export async function handleTaskClaimAsync(taskId: string, agentId: string): Promise<TaskOutput> {
  const out = handleTaskClaim(taskId, agentId);
  const task = getTaskById(taskId);
  if (task) await forwardTaskEvent(task, agentId, 'task-claim', {});
  return out;
}

// --- hive.task.claim ---

export function handleTaskClaim(taskId: string, agentId: string): TaskOutput {
  const task = getTaskById(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.status !== 'created') throw new Error(`Task cannot be claimed (status: ${task.status})`);
  if (task.assignee_agent_id) throw new Error('Task already has an assignee');

  const agent = getAgentById(agentId);
  if (!agent) throw new Error('Agent not found');

  // Claim → proposing (agent should propose workflow next)
  const status: TaskStatus = 'proposing';
  appendTaskEvent(taskId, 'task-claim', agentId, {});
  updateTaskStatus(taskId, status, { assignee_agent_id: agentId });

  return {
    task_id: taskId, title: task.title, status,
    assignee: { id: agent.id, display_name: agent.display_name },
  };
}

// --- hive.check ---

interface CheckOutput {
  task_id: string;
  title: string;
  status: TaskStatus;
  assignee?: { id: string; display_name: string };
  recent_events: TaskEvent[];
  workflow?: { current_step: number; steps: WorkflowStep[] };
}

export function handleCheck(input: { task_id: string }): CheckOutput {
  const task = getTaskById(input.task_id);
  if (!task) throw new Error(`Task not found: ${input.task_id}`);

  const events = getTaskEvents(task.id);
  let assignee: { id: string; display_name: string } | undefined;
  if (task.assignee_agent_id) {
    const agent = getAgentById(task.assignee_agent_id);
    if (agent) assignee = { id: agent.id, display_name: agent.display_name };
  }

  let workflow: { current_step: number; steps: WorkflowStep[] } | undefined;
  if (task.workflow_json) {
    workflow = { current_step: task.current_step, steps: JSON.parse(task.workflow_json) };
  }

  return {
    task_id: task.id, title: task.title, status: task.status as TaskStatus,
    assignee, recent_events: events.slice(-10), workflow,
  };
}

// --- Workflow: propose ---

export function handleWorkflowPropose(taskId: string, agentId: string, workflow: WorkflowStep[]): void {
  const task = getTaskById(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.creator_agent_id !== agentId && task.assignee_agent_id !== agentId) throw new Error('Only the task creator or assignee can propose a workflow');

  validateWorkflowTransition(task.status as TaskStatus, 'task-propose');
  const steps = workflow.map(s => ({ ...s, completed_by: [] }));
  updateTaskStatus(taskId, 'proposing', { workflow_json: JSON.stringify(steps) });
  appendTaskEvent(taskId, 'task-propose', agentId, { workflow: steps });
}

// --- Workflow: approve ---

export interface WorkflowAction {
  type: 'step-start' | 'task-complete' | 'awaiting_approval';
  step?: number;
  assignees?: string[];
  /** When type === 'awaiting_approval', the agent id that must call hive-workflow-step-approve. */
  approver?: string;
}

export function handleWorkflowApprove(taskId: string, agentId: string): WorkflowAction {
  const task = getTaskById(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.creator_agent_id !== agentId) throw new Error('Only the task creator can approve the workflow');
  if (!task.workflow_json) throw new Error('No workflow defined');

  const steps: WorkflowStep[] = JSON.parse(task.workflow_json);
  if (steps.length === 0) throw new Error('Workflow has no steps');

  // proposing → approved
  validateWorkflowTransition(task.status as TaskStatus, 'task-approve');
  updateTaskStatus(taskId, 'approved');
  appendTaskEvent(taskId, 'task-approve', agentId, {});

  // approved → in_progress (step-start)
  validateWorkflowTransition('approved', 'step-start');
  updateTaskStatus(taskId, 'in_progress', { current_step: 1 });
  appendTaskEvent(taskId, 'step-start', null, { step: 1, assignees: steps[0].assignees });

  return { type: 'step-start', step: 1, assignees: steps[0].assignees };
}

// --- Workflow: step complete ---

export function handleStepComplete(taskId: string, agentId: string, stepNum: number, result?: string): WorkflowAction | null {
  const task = getTaskById(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (!task.workflow_json) throw new Error('No workflow defined');
  if (task.current_step !== stepNum) throw new Error(`Step ${stepNum} is not current (current: ${task.current_step})`);

  validateWorkflowTransition(task.status as TaskStatus, 'step-complete');

  const steps: WorkflowStep[] = JSON.parse(task.workflow_json);
  const step = steps.find(s => s.step === stepNum);
  if (!step) throw new Error(`Step ${stepNum} not found`);

  if (!step.completed_by.includes(agentId)) {
    step.completed_by.push(agentId);
  }

  appendTaskEvent(taskId, 'step-complete', agentId, { step: stepNum, result });
  updateTaskStatus(taskId, task.status, { workflow_json: JSON.stringify(steps) });

  if (shouldAdvanceStep(step)) {
    // Gated step: pause for the creator's hive-workflow-step-approve.
    // current_step stays on the gated step so the creator can target it
    // unambiguously; status flips to awaiting_approval.
    if (step.gate) {
      updateTaskStatus(taskId, 'awaiting_approval');
      return { type: 'awaiting_approval', step: stepNum, approver: task.creator_agent_id };
    }
    const nextStepNum = stepNum + 1;
    if (nextStepNum > steps.length) {
      validateWorkflowTransition(task.status as TaskStatus, 'task-complete');
      updateTaskStatus(taskId, 'completed', { completed_at: new Date().toISOString() });
      appendTaskEvent(taskId, 'task-complete', null, {});
      return { type: 'task-complete' };
    } else {
      const nextStep = steps[nextStepNum - 1];
      updateTaskStatus(taskId, 'in_progress', { current_step: nextStepNum });
      appendTaskEvent(taskId, 'step-start', null, {
        step: nextStepNum, assignees: nextStep.assignees,
        previous_step_result: result,
      });
      return { type: 'step-start', step: nextStepNum, assignees: nextStep.assignees };
    }
  }

  return null;
}

// --- Workflow: step approve (gate release) ---

export function handleStepApprove(taskId: string, agentId: string): WorkflowAction {
  const task = getTaskById(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (!task.workflow_json) throw new Error('No workflow defined');
  if (task.creator_agent_id !== agentId) throw new Error('Only the task creator can approve a gated step');
  if (task.status !== 'awaiting_approval') throw new Error(`Task is not awaiting approval (status: ${task.status})`);

  validateWorkflowTransition(task.status as TaskStatus, 'step-approve');

  const steps: WorkflowStep[] = JSON.parse(task.workflow_json);
  const completedStepNum = task.current_step;
  const completedStep = steps.find(s => s.step === completedStepNum);
  if (!completedStep) throw new Error(`Step ${completedStepNum} not found`);

  appendTaskEvent(taskId, 'step-approve', agentId, { step: completedStepNum });

  const nextStepNum = completedStepNum + 1;
  if (nextStepNum > steps.length) {
    // Last step was gated → completion was deferred to here.
    validateWorkflowTransition(task.status as TaskStatus, 'task-complete');
    updateTaskStatus(taskId, 'completed', { completed_at: new Date().toISOString() });
    appendTaskEvent(taskId, 'task-complete', null, {});
    return { type: 'task-complete' };
  }

  const nextStep = steps[nextStepNum - 1];
  updateTaskStatus(taskId, 'in_progress', { current_step: nextStepNum });
  appendTaskEvent(taskId, 'step-start', null, { step: nextStepNum, assignees: nextStep.assignees });
  return { type: 'step-start', step: nextStepNum, assignees: nextStep.assignees };
}

// --- Workflow: reject ---

export function handleWorkflowReject(taskId: string, agentId: string, stepNum: number, reason?: string): WorkflowAction {
  const task = getTaskById(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (!task.workflow_json) throw new Error('No workflow defined');

  validateWorkflowTransition(task.status as TaskStatus, 'task-reject');

  const steps: WorkflowStep[] = JSON.parse(task.workflow_json);
  const step = steps.find(s => s.step === stepNum);
  if (!step) throw new Error(`Step ${stepNum} not found`);

  const targetStep = getRejectTarget(step);

  for (const s of steps) {
    if (s.step >= targetStep) s.completed_by = [];
  }

  updateTaskStatus(taskId, 'in_progress', { current_step: targetStep, workflow_json: JSON.stringify(steps) });
  appendTaskEvent(taskId, 'task-reject', agentId, { step: stepNum, target_step: targetStep, reason });

  const target = steps.find(s => s.step === targetStep);
  appendTaskEvent(taskId, 'step-start', null, { step: targetStep, assignees: target?.assignees || [] });

  return { type: 'step-start', step: targetStep, assignees: target?.assignees || [] };
}
