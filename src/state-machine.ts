import type { TaskState, EventType } from './models.js';

const TRANSITIONS: Record<string, TaskState> = {
  // "fromState:eventType" → toState
  ':task-start': 'submitted',
  'submitted:task-claim': 'working',
  'working:task-update': 'working',
  'working:task-ask': 'input-required',
  'input-required:task-answer': 'working',
  'working:task-complete': 'completed',
  'working:task-fail': 'failed',
  // cancel from any non-terminal
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
  return type.startsWith('task-');
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
