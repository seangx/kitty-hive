import type { TaskStatus, TaskEventType, WorkflowStep } from './models.js';

// --- Simple task FSM ---

const TRANSITIONS: Record<string, TaskStatus> = {
  'created:task-start': 'created',
  'created:task-claim': 'in_progress',
  'in_progress:task-update': 'in_progress',
  'in_progress:task-complete': 'completed',
  'in_progress:task-fail': 'failed',
  'created:task-cancel': 'canceled',
  'in_progress:task-cancel': 'canceled',
  // Compatibility for assigned tasks created by Hive versions before 0.8.
  // New simple tasks enter in_progress directly; old rows may still be in
  // proposing and must remain completable/cancelable.
  'proposing:task-complete': 'completed',
  'proposing:task-fail': 'failed',
  'proposing:task-cancel': 'canceled',
};

const TERMINAL: Set<TaskStatus> = new Set(['completed', 'failed', 'canceled']);

export function validateTransition(current: TaskStatus, event: TaskEventType): TaskStatus {
  const next = TRANSITIONS[`${current}:${event}`];
  if (!next) throw new Error(`Invalid task transition: ${current} + ${event}`);
  return next;
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}

// --- Workflow FSM ---

const WORKFLOW_TRANSITIONS: Record<string, TaskStatus> = {
  'created:task-start': 'proposing',
  // Explicit legacy workflow proposals may be attached to an ordinary task.
  // Ordinary tasks no longer enter proposing by default.
  'created:task-propose': 'proposing',
  'in_progress:task-propose': 'proposing',
  'proposing:task-propose': 'proposing',
  'proposing:task-approve': 'approved',
  'proposing:task-reject': 'proposing',
  'approved:step-start': 'in_progress',
  'in_progress:step-complete': 'in_progress',
  'in_progress:step-start': 'in_progress',
  'in_progress:task-reject': 'in_progress',
  'in_progress:task-complete': 'completed',
  'in_progress:task-fail': 'failed',
  'proposing:task-cancel': 'canceled',
  'approved:task-cancel': 'canceled',
  'in_progress:task-cancel': 'canceled',
  // Gate flow
  'awaiting_approval:step-approve': 'in_progress',
  'awaiting_approval:step-start': 'in_progress',
  'awaiting_approval:task-complete': 'completed',
  'awaiting_approval:task-reject': 'in_progress',
  'awaiting_approval:task-cancel': 'canceled',
};

export function validateWorkflowTransition(current: TaskStatus, event: TaskEventType): TaskStatus {
  const next = WORKFLOW_TRANSITIONS[`${current}:${event}`];
  if (!next) throw new Error(`Invalid workflow transition: ${current} + ${event}`);
  return next;
}

// --- Workflow step logic ---

export function shouldAdvanceStep(step: WorkflowStep): boolean {
  if (step.completion === 'any') return step.completed_by.length > 0;
  return step.completed_by.length >= step.assignees.length;
}

export function getRejectTarget(step: WorkflowStep): number {
  if (!step.on_reject || step.on_reject === 'revise') return step.step;
  const match = step.on_reject.match(/^back:(\d+)$/);
  return match ? parseInt(match[1], 10) : step.step;
}
