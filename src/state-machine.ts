import type { TaskState, EventType, WorkflowTaskStatus, WorkflowStep, TaskWorkflow } from './models.js';

// --- Simple task FSM (backward compat) ---

const TRANSITIONS: Record<string, TaskState> = {
  ':task-start': 'submitted',
  'submitted:task-claim': 'working',
  'working:task-update': 'working',
  'working:task-ask': 'input-required',
  'input-required:task-answer': 'working',
  'working:task-complete': 'completed',
  'working:task-fail': 'failed',
  'submitted:task-cancel': 'canceled',
  'working:task-cancel': 'canceled',
  'input-required:task-cancel': 'canceled',
};

const TERMINAL: Set<TaskState> = new Set(['completed', 'failed', 'canceled']);

export function nextState(current: TaskState | null, event: EventType): TaskState | null {
  const key = `${current ?? ''}:${event}`;
  return TRANSITIONS[key] ?? null;
}

export function isTerminal(state: TaskState): boolean {
  return TERMINAL.has(state);
}

export function isTaskEvent(type: EventType): boolean {
  return type.startsWith('task-') || type.startsWith('step-');
}

export function deriveTaskState(events: Array<{ type: EventType }>): TaskState {
  let state: TaskState = 'submitted';
  for (const e of events) {
    if (!isTaskEvent(e.type)) continue;
    const next = nextState(state, e.type);
    if (next) state = next;
  }
  return state;
}

// --- Workflow FSM ---

const WORKFLOW_TRANSITIONS: Record<string, WorkflowTaskStatus> = {
  ':task-start': 'proposing',
  'proposing:task-propose': 'proposing',    // can re-propose
  'proposing:task-approve': 'approved',
  'proposing:task-reject': 'proposing',     // reject proposal → re-propose
  'approved:step-start': 'in_progress',
  'in_progress:step-complete': 'in_progress',
  'in_progress:step-start': 'in_progress',  // next step
  'in_progress:task-reject': 'in_progress', // reject step → back
  'in_progress:task-complete': 'completed',
  'in_progress:task-fail': 'failed',
  'proposing:task-cancel': 'canceled',
  'approved:task-cancel': 'canceled',
  'in_progress:task-cancel': 'canceled',
};

const WORKFLOW_TERMINAL: Set<WorkflowTaskStatus> = new Set(['completed', 'failed', 'canceled']);

export function nextWorkflowStatus(current: WorkflowTaskStatus | null, event: EventType): WorkflowTaskStatus | null {
  const key = `${current ?? ''}:${event}`;
  return WORKFLOW_TRANSITIONS[key] ?? null;
}

export function isWorkflowTerminal(status: WorkflowTaskStatus): boolean {
  return WORKFLOW_TERMINAL.has(status);
}

export function deriveWorkflowStatus(events: Array<{ type: EventType }>): WorkflowTaskStatus {
  let status: WorkflowTaskStatus = 'proposing';
  for (const e of events) {
    if (!isTaskEvent(e.type)) continue;
    const next = nextWorkflowStatus(status, e.type);
    if (next) status = next;
  }
  return status;
}

// --- Workflow step logic ---

export function shouldAdvanceStep(step: WorkflowStep, completedAgentId: string): boolean {
  if (step.completed_by.includes(completedAgentId)) return false; // already completed
  const newCompleted = [...step.completed_by, completedAgentId];
  if (step.completion === 'any') return true;
  // "all": check if all resolved assignees have completed
  // Note: assignees might be "role:xxx" which resolve to multiple agents at runtime
  // The caller should pass resolved assignee IDs
  return newCompleted.length >= step.assignees.length;
}

export function getRejectTarget(step: WorkflowStep): number {
  if (!step.on_reject || step.on_reject === 'revise') return step.step;
  const match = step.on_reject.match(/^back:(\d+)$/);
  return match ? parseInt(match[1], 10) : step.step;
}
