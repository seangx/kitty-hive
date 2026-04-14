import {
  getAgentById, getAgentByName, findAgentByRole,
  createTask, getTaskById, updateTaskStatus,
  appendTaskEvent, getTaskEvents,
} from '../db.js';
import { validateTransition, validateWorkflowTransition, shouldAdvanceStep, getRejectTarget } from '../state-machine.js';
import type { TaskEvent, TaskStatus, WorkflowStep } from '../models.js';

// --- hive.task ---

interface TaskInput {
  to?: string;
  title: string;
  input?: object;
  source_room_id?: string;
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
      const agent = getAgentById(input.to) || getAgentByName(input.to);
      if (agent) assignee = { id: agent.id, display_name: agent.display_name };
    }
  }

  const task = createTask(input.title, actorId, assignee?.id, input.source_room_id, input.input);

  // task-start → proposing (assignee should propose workflow)
  validateWorkflowTransition('created' as TaskStatus, 'task-start');
  appendTaskEvent(task.id, 'task-start', actorId, {
    title: input.title, input: input.input, assignee_agent_id: assignee?.id ?? null,
  });

  let status: TaskStatus = assignee ? 'proposing' : 'created';
  updateTaskStatus(task.id, status, assignee ? { assignee_agent_id: assignee.id } : {});

  return { task_id: task.id, title: task.title, status, assignee };
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
  type: 'step-start' | 'task-complete';
  step?: number;
  assignees?: string[];
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

export function handleStepComplete(taskId: string, agentId: string, stepNum: number): WorkflowAction | null {
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

  appendTaskEvent(taskId, 'step-complete', agentId, { step: stepNum });
  updateTaskStatus(taskId, task.status, { workflow_json: JSON.stringify(steps) });

  if (shouldAdvanceStep(step)) {
    const nextStepNum = stepNum + 1;
    if (nextStepNum > steps.length) {
      validateWorkflowTransition(task.status as TaskStatus, 'task-complete');
      updateTaskStatus(taskId, 'completed', { completed_at: new Date().toISOString() });
      appendTaskEvent(taskId, 'task-complete', null, {});
      return { type: 'task-complete' };
    } else {
      const nextStep = steps[nextStepNum - 1];
      updateTaskStatus(taskId, 'in_progress', { current_step: nextStepNum });
      appendTaskEvent(taskId, 'step-start', null, { step: nextStepNum, assignees: nextStep.assignees });
      return { type: 'step-start', step: nextStepNum, assignees: nextStep.assignees };
    }
  }

  return null;
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
