import type { TaskStatus, TaskEventType, WorkflowStep } from './models.js';

// --- Simple task FSM ---

const TRANSITIONS: Record<string, TaskStatus> = {
  'created:task-claim': 'in_progress',
  'in_progress:task-update': 'in_progress',
  'in_progress:task-complete': 'completed',
  'in_progress:task-fail': 'failed',
  'created:task-cancel': 'canceled',
  'in_progress:task-cancel': 'canceled',
};

const TERMINAL: Set<TaskStatus> = new Set(['completed', 'failed', 'canceled']);

export function nextStatus(current: TaskStatus, event: TaskEventType): TaskStatus | null {
  return TRANSITIONS[`${current}:${event}`] ?? null;
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}

// --- Workflow FSM ---

const WORKFLOW_TRANSITIONS: Record<string, TaskStatus> = {
  'created:task-start': 'proposing',
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
};

export function nextWorkflowStatus(current: TaskStatus, event: TaskEventType): TaskStatus | null {
  return WORKFLOW_TRANSITIONS[`${current}:${event}`] ?? null;
}

// --- Workflow step logic ---

export function shouldAdvanceStep(step: WorkflowStep, completedAgentId: string): boolean {
  if (step.completed_by.includes(completedAgentId)) return false;
  const newCompleted = [...step.completed_by, completedAgentId];
  if (step.completion === 'any') return true;
  return newCompleted.length >= step.assignees.length;
}

export function getRejectTarget(step: WorkflowStep): number {
  if (!step.on_reject || step.on_reject === 'revise') return step.step;
  const match = step.on_reject.match(/^back:(\d+)$/);
  return match ? parseInt(match[1], 10) : step.step;
}
