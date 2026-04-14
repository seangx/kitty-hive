import {
  getAgentById, getAgentByName, findAgentByRole,
  createRoom, appendEvent, getTaskEvents, getRoomById, getEvents,
} from '../db.js';
import { ulid } from '../utils.js';
import { deriveTaskState, deriveWorkflowStatus, shouldAdvanceStep, getRejectTarget } from '../state-machine.js';
import type { RoomEvent, TaskState, WorkflowStep, WorkflowTaskStatus } from '../models.js';

// --- hive.task ---

interface TaskInput {
  to?: string;
  title: string;
  input?: object;
}

interface TaskOutput {
  room_id: string;
  task_id: string;
  state: TaskState | WorkflowTaskStatus;
  assignee?: { id: string; display_name: string };
}

export function handleTask(actorId: string, input: TaskInput): TaskOutput {
  let assignee: { id: string; display_name: string } | undefined;

  if (input.to) {
    if (input.to.startsWith('role:')) {
      const role = input.to.slice(5);
      const agent = findAgentByRole(role);
      if (agent) assignee = { id: agent.id, display_name: agent.display_name };
    } else {
      const agent = getAgentById(input.to) || getAgentByName(input.to);
      if (agent) assignee = { id: agent.id, display_name: agent.display_name };
    }
  }

  const taskId = ulid();
  const room = createRoom('task', actorId, input.title, undefined, {
    task_id: taskId,
    title: input.title,
    input: input.input,
  });

  appendEvent(room.id, 'join', actorId);

  appendEvent(room.id, 'task-start', actorId, {
    task_id: taskId,
    title: input.title,
    input: input.input,
    assignee_agent_id: assignee?.id ?? null,
  });

  // If assignee exists, set to proposing (waiting for workflow proposal)
  // If no assignee, stays at submitted (simple mode)
  let state: TaskState | WorkflowTaskStatus = 'submitted';

  if (assignee) {
    appendEvent(room.id, 'join', assignee.id);
    // Default: simple mode (auto-claim). Workflow mode activates when agent sends task-propose.
    appendEvent(room.id, 'task-claim', assignee.id, { task_id: taskId });
    state = 'working';
  }

  return { room_id: room.id, task_id: taskId, state, assignee };
}

// --- hive.check ---

interface CheckInput {
  task_id: string;
}

interface CheckOutput {
  task_id: string;
  state: TaskState | WorkflowTaskStatus;
  room_id: string;
  recent_events: RoomEvent[];
  assignee?: { id: string; display_name: string };
  workflow?: {
    current_step: number;
    steps: WorkflowStep[];
  };
}

export function handleCheck(input: CheckInput): CheckOutput {
  const events = getTaskEvents(input.task_id);
  if (events.length === 0) {
    throw new Error(`Task not found: ${input.task_id}`);
  }

  const roomId = events[0].room_id;

  // Check if this is a workflow task
  const proposeEvent = events.find(e => e.type === 'task-propose');
  if (proposeEvent) {
    return checkWorkflowTask(input.task_id, events, roomId);
  }

  // Simple task
  const state = deriveTaskState(events);
  let assignee: { id: string; display_name: string } | undefined;
  const claimEvent = events.find(e => e.type === 'task-claim');
  if (claimEvent?.actor_agent_id) {
    const agent = getAgentById(claimEvent.actor_agent_id);
    if (agent) assignee = { id: agent.id, display_name: agent.display_name };
  }

  return {
    task_id: input.task_id,
    state,
    room_id: roomId,
    recent_events: events.slice(-10),
    assignee,
  };
}

function checkWorkflowTask(taskId: string, events: RoomEvent[], roomId: string): CheckOutput {
  const status = deriveWorkflowStatus(events);
  const workflow = getWorkflowState(taskId, events);

  let assignee: { id: string; display_name: string } | undefined;
  if (workflow && workflow.current_step > 0 && workflow.current_step <= workflow.steps.length) {
    const currentStep = workflow.steps[workflow.current_step - 1];
    // Show first assignee of current step
    if (currentStep.assignees.length > 0) {
      const name = currentStep.assignees[0];
      const agent = name.startsWith('role:')
        ? findAgentByRole(name.slice(5))
        : (getAgentById(name) || getAgentByName(name));
      if (agent) assignee = { id: agent.id, display_name: agent.display_name };
    }
  }

  return {
    task_id: taskId,
    state: status,
    room_id: roomId,
    recent_events: events.slice(-10),
    assignee,
    workflow: workflow ? {
      current_step: workflow.current_step,
      steps: workflow.steps,
    } : undefined,
  };
}

// --- Workflow helpers ---

export function getWorkflowState(taskId: string, events: RoomEvent[]): { current_step: number; steps: WorkflowStep[] } | null {
  // Find latest task-propose event to get workflow definition
  let workflow: WorkflowStep[] | null = null;
  let currentStep = 0;

  for (const e of events) {
    try {
      const p = JSON.parse(e.payload_json);
      if (p.task_id !== taskId) continue;

      if (e.type === 'task-propose' && p.workflow) {
        workflow = p.workflow.map((s: any) => ({
          ...s,
          completed_by: s.completed_by || [],
        }));
      }
      if (e.type === 'step-start' && p.step) {
        currentStep = p.step;
        // Reset completed_by for this step
        if (workflow) {
          const step = workflow.find(s => s.step === p.step);
          if (step) step.completed_by = [];
        }
      }
      if (e.type === 'step-complete' && p.step && p.agent_id && workflow) {
        const step = workflow.find(s => s.step === p.step);
        if (step && !step.completed_by.includes(p.agent_id)) {
          step.completed_by.push(p.agent_id);
        }
      }
      if (e.type === 'task-reject' && p.step && workflow) {
        const step = workflow.find(s => s.step === p.step);
        if (step) {
          const target = getRejectTarget(step);
          // Clear completed_by from target step onwards
          for (const s of workflow) {
            if (s.step >= target) s.completed_by = [];
          }
          currentStep = target;
        }
      }
    } catch { /* ignore parse errors */ }
  }

  if (!workflow) return null;
  return { current_step: currentStep, steps: workflow };
}

// --- Workflow event handlers ---

export interface WorkflowAction {
  type: 'step-start' | 'task-complete';
  step?: number;
  assignees?: string[];
}

export function handleStepComplete(
  taskId: string,
  roomId: string,
  agentId: string,
  stepNum: number,
): WorkflowAction | null {
  const events = getTaskEvents(taskId);
  const state = getWorkflowState(taskId, events);
  if (!state) return null;

  const step = state.steps.find(s => s.step === stepNum);
  if (!step) throw new Error(`Step ${stepNum} not found`);
  if (step.step !== state.current_step) throw new Error(`Step ${stepNum} is not the current step (current: ${state.current_step})`);

  // Record completion
  appendEvent(roomId, 'step-complete', agentId, {
    task_id: taskId,
    step: stepNum,
    agent_id: agentId,
  });

  // Check if step should advance
  if (step.completion === 'any' || shouldAdvanceStep(step, agentId)) {
    const nextStepNum = stepNum + 1;
    if (nextStepNum > state.steps.length) {
      // All steps done
      appendEvent(roomId, 'task-complete', null, { task_id: taskId });
      return { type: 'task-complete' };
    } else {
      const nextStep = state.steps[nextStepNum - 1];
      appendEvent(roomId, 'step-start', null, {
        task_id: taskId,
        step: nextStepNum,
        assignees: nextStep.assignees,
      });
      return { type: 'step-start', step: nextStepNum, assignees: nextStep.assignees };
    }
  }

  return null; // Waiting for more completions
}

export function handleWorkflowReject(
  taskId: string,
  roomId: string,
  agentId: string,
  stepNum: number,
  reason?: string,
): WorkflowAction {
  const events = getTaskEvents(taskId);
  const state = getWorkflowState(taskId, events);
  if (!state) throw new Error('No workflow found');

  const step = state.steps.find(s => s.step === stepNum);
  if (!step) throw new Error(`Step ${stepNum} not found`);

  const targetStep = getRejectTarget(step);

  appendEvent(roomId, 'task-reject', agentId, {
    task_id: taskId,
    step: stepNum,
    target_step: targetStep,
    reason,
  });

  const target = state.steps.find(s => s.step === targetStep);
  appendEvent(roomId, 'step-start', null, {
    task_id: taskId,
    step: targetStep,
    assignees: target?.assignees || [],
  });

  return { type: 'step-start', step: targetStep, assignees: target?.assignees || [] };
}

export function handleWorkflowPropose(
  taskId: string,
  roomId: string,
  agentId: string,
  workflow: WorkflowStep[],
): void {
  appendEvent(roomId, 'task-propose', agentId, {
    task_id: taskId,
    workflow: workflow.map(s => ({
      ...s,
      completed_by: [],
    })),
  });
}

export function handleWorkflowApprove(
  taskId: string,
  roomId: string,
  agentId: string,
): WorkflowAction {
  appendEvent(roomId, 'task-approve', agentId, { task_id: taskId });

  // Auto start step 1
  const events = getTaskEvents(taskId);
  const state = getWorkflowState(taskId, events);
  if (!state || state.steps.length === 0) throw new Error('No workflow steps defined');

  const firstStep = state.steps[0];
  appendEvent(roomId, 'step-start', null, {
    task_id: taskId,
    step: 1,
    assignees: firstStep.assignees,
  });

  return { type: 'step-start', step: 1, assignees: firstStep.assignees };
}
