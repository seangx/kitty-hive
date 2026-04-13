import {
  getAgentById, getAgentByName, findAgentByRole,
  createRoom, appendEvent, getTaskEvents, getRoomById,
} from '../db.js';
import { ulid } from '../utils.js';
import { deriveTaskState } from '../state-machine.js';
import type { RoomEvent, TaskState } from '../models.js';

interface TaskInput {
  to?: string;
  title: string;
  input?: object;
}

interface TaskOutput {
  room_id: string;
  task_id: string;
  state: TaskState;
  assignee?: { id: string; display_name: string };
}

export function handleTask(actorId: string, input: TaskInput): TaskOutput {
  let assignee: { id: string; display_name: string } | undefined;

  // Resolve assignee
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

  // Join creator
  appendEvent(room.id, 'join', actorId);

  // Task-start event
  appendEvent(room.id, 'task-start', actorId, {
    task_id: taskId,
    title: input.title,
    input: input.input,
    assignee_agent_id: assignee?.id ?? null,
  });

  let state: TaskState = 'submitted';

  // Auto-claim if assignee is known
  if (assignee) {
    appendEvent(room.id, 'join', assignee.id);
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
  state: TaskState;
  room_id: string;
  recent_events: RoomEvent[];
  assignee?: { id: string; display_name: string };
}

export function handleCheck(input: CheckInput): CheckOutput {
  const events = getTaskEvents(input.task_id);
  if (events.length === 0) {
    throw new Error(`Task not found: ${input.task_id}`);
  }

  const state = deriveTaskState(events);
  const roomId = events[0].room_id;

  // Find assignee from task-claim event
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
