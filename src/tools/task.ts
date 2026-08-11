import {
  getAgentById, findAgentByRole, resolveAddressee,
  createTask, getTaskById, updateTaskStatus, setTaskDelegation,
  appendTaskEvent, getTaskEvents, getPeerByName,
  ensureRemoteAgentByRemoteId,
} from '../db.js';
import { validateTransition, validateWorkflowTransition, shouldAdvanceStep, getRejectTarget } from '../state-machine.js';
import {
  getWorkflowTemplate,
  graphEdge,
  graphNodeAt,
  graphNodeIndex,
  parseGraphWorkflow,
  validateGraphWorkflow,
  listWorkflowTemplates as loadWorkflowTemplates,
} from '../graph-workflow.js';
import type {
  GraphWorkflowDefinition,
  GraphWorkflowNode,
  GraphWorkflowOutcome,
  GraphWorkflowTemplate,
  Task,
  TaskEvent,
  TaskStatus,
  WorkflowStep,
} from '../models.js';

// --- hive_task ---

interface TaskInput {
  to?: string;
  title: string;
  input?: object;
  source_team_id?: string;
  workspace_dir?: string;
  branch?: string;
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
      // When source_team_id is set, prefer team members for role lookup so
      // routing is deterministic per project context.
      const agent = findAgentByRole(input.to.slice(5), { teamId: input.source_team_id });
      if (agent) assignee = { id: agent.id, display_name: agent.display_name };
    } else {
      const resolved = resolveAddressee(actorId, input.to);
      if ('error' in resolved) throw new Error(resolved.error);
      assignee = { id: resolved.agent!.id, display_name: resolved.agent!.display_name };
    }
  }

  const taskInput = {
    ...(input.input ?? {}),
    ...(input.workspace_dir ? { workspace_dir: input.workspace_dir } : {}),
    ...(input.branch ? { branch: input.branch } : {}),
  };
  const task = createTask(input.title, actorId, {
    assigneeId: assignee?.id,
    sourceTeamId: input.source_team_id,
    input: taskInput,
  });

  appendTaskEvent(task.id, 'task-start', actorId, {
    title: input.title, input: taskInput, assignee_agent_id: assignee?.id ?? null,
  });

  // The lightweight lane is the default: assigned tasks can start immediately.
  // A workflow is attached only through an explicit workflow tool call.
  const status: TaskStatus = assignee ? 'in_progress' : 'created';
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

export async function handleTaskCancelAsync(taskId: string, agentId: string, reason?: string): Promise<{ task_id: string; status: 'canceled' }> {
  handleTaskCancel(taskId, agentId, reason);
  const task = getTaskById(taskId);
  if (task) await forwardTaskEvent(task, agentId, 'task-cancel', { reason });
  return { task_id: taskId, status: 'canceled' };
}

// --- hive_task_claim ---

export function handleTaskClaim(taskId: string, agentId: string): TaskOutput {
  const task = getTaskById(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.status !== 'created') throw new Error(`Task cannot be claimed (status: ${task.status})`);
  if (task.assignee_agent_id) throw new Error('Task already has an assignee');

  const agent = getAgentById(agentId);
  if (!agent) throw new Error('Agent not found');

  // Claiming an ordinary task starts it immediately. Workflow construction is
  // explicit and never a mandatory intermediate state.
  const status: TaskStatus = validateTransition(task.status as TaskStatus, 'task-claim');
  appendTaskEvent(taskId, 'task-claim', agentId, {});
  updateTaskStatus(taskId, status, { assignee_agent_id: agentId });

  return {
    task_id: taskId, title: task.title, status,
    assignee: { id: agent.id, display_name: agent.display_name },
  };
}

// --- hive_check ---

interface CheckOutput {
  task_id: string;
  title: string;
  status: TaskStatus;
  input: Record<string, unknown>;
  assignee?: { id: string; display_name: string };
  recent_events: TaskEvent[];
  workflow?:
    | { kind: 'linear'; current_step: number; steps: WorkflowStep[] }
    | { kind: 'graph'; current_node_id: string; definition: GraphWorkflowDefinition };
}

function parseTaskInput(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
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

  let workflow: CheckOutput['workflow'];
  if (task.workflow_json) {
    const graph = parseGraphWorkflow(task.workflow_json);
    workflow = graph
      ? { kind: 'graph', current_node_id: graphNodeAt(graph, task.current_step).node_id, definition: graph }
      : { kind: 'linear', current_step: task.current_step, steps: JSON.parse(task.workflow_json) };
  }

  return {
    task_id: task.id, title: task.title, status: task.status as TaskStatus,
    input: parseTaskInput(task.input_json),
    assignee, recent_events: events.slice(-10), workflow,
  };
}

// --- Workflow: propose ---

export function handleWorkflowPropose(taskId: string, agentId: string, workflow: WorkflowStep[]): void {
  const task = getTaskById(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.creator_agent_id !== agentId && task.assignee_agent_id !== agentId) throw new Error('Only the task creator or assignee can propose a workflow');
  if (parseGraphWorkflow(task.workflow_json)) throw new Error('Graph workflows cannot be replaced by a legacy proposal');

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
  if (parseGraphWorkflow(task.workflow_json)) throw new Error('Graph workflows start explicitly and do not use legacy workflow approval');

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
  if (parseGraphWorkflow(task.workflow_json)) throw new Error('Graph workflow — use hive_workflow_node_complete');
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
  if (parseGraphWorkflow(task.workflow_json)) throw new Error('Graph workflow — use hive_workflow_gate_decide');
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
  if (parseGraphWorkflow(task.workflow_json)) throw new Error('Graph workflow — report changes_requested with hive_workflow_node_complete');

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

// --- Graph workflow kernel ---

export function listWorkflowTemplates(): readonly GraphWorkflowTemplate[] {
  return loadWorkflowTemplates();
}

export interface GraphWorkflowStartInput {
  template_id: string;
  to: string;
  title: string;
  input?: object;
  source_team_id?: string;
  workspace_dir?: string;
  branch?: string;
}

export interface GraphWorkflowAction {
  type: 'node-start' | 'awaiting_approval' | 'task-complete' | 'task-fail' | 'waiting';
  node_id?: string;
  activation?: number;
  assignees?: string[];
  edge_id?: string;
  outcome?: GraphWorkflowOutcome;
  approver?: string;
}

function resolveWorkflowAssignee(
  actorId: string,
  reference: string,
  primaryAssigneeId: string,
  sourceTeamId?: string,
): string {
  if (reference === '$assignee') return primaryAssigneeId;
  if (reference.startsWith('role:')) {
    const agent = findAgentByRole(reference.slice(5), { teamId: sourceTeamId });
    if (!agent) throw new Error(`No active agent found for ${reference}`);
    return agent.id;
  }
  const resolved = resolveAddressee(actorId, reference);
  if ('error' in resolved) throw new Error(resolved.error);
  return resolved.agent!.id;
}

function instantiateGraphTemplate(
  actorId: string,
  template: GraphWorkflowTemplate,
  primaryAssigneeId: string,
  sourceTeamId?: string,
): GraphWorkflowDefinition {
  const definition = structuredClone(template.definition);
  definition.nodes = definition.nodes.map(node => ({
    ...node,
    assignees: [...new Set(node.assignees.map(reference =>
      resolveWorkflowAssignee(actorId, reference, primaryAssigneeId, sourceTeamId)))],
  }));
  validateGraphWorkflow(definition);
  return definition;
}

function resolvePrimaryAssignee(actorId: string, to: string, sourceTeamId?: string): string {
  if (to.startsWith('role:')) {
    const agent = findAgentByRole(to.slice(5), { teamId: sourceTeamId });
    if (!agent) throw new Error(`No active agent found for ${to}`);
    return agent.id;
  }
  const resolved = resolveAddressee(actorId, to);
  if ('error' in resolved) throw new Error(resolved.error);
  return resolved.agent!.id;
}

export function handleGraphWorkflowStart(actorId: string, input: GraphWorkflowStartInput): TaskOutput & { action: GraphWorkflowAction } {
  const actor = getAgentById(actorId);
  if (!actor) throw new Error('Actor not found');
  const template = getWorkflowTemplate(input.template_id);
  if (!template) throw new Error(`Workflow template not found: ${input.template_id}`);

  const primaryAssigneeId = resolvePrimaryAssignee(actorId, input.to, input.source_team_id);
  const definition = instantiateGraphTemplate(actorId, template, primaryAssigneeId, input.source_team_id);
  const entryIndex = graphNodeIndex(definition, definition.entry_node_id);
  const entry = graphNodeAt(definition, entryIndex);
  const taskInput = {
    ...(input.input ?? {}),
    workflow_template_id: template.template_id,
    ...(input.workspace_dir ? { workspace_dir: input.workspace_dir } : {}),
    ...(input.branch ? { branch: input.branch } : {}),
  };
  const task = createTask(input.title, actorId, {
    assigneeId: entry.assignees[0],
    sourceTeamId: input.source_team_id,
    input: taskInput,
  });
  updateTaskStatus(task.id, 'in_progress', {
    workflow_json: JSON.stringify(definition),
    current_step: entryIndex,
    assignee_agent_id: entry.assignees[0],
  });
  appendTaskEvent(task.id, 'task-start', actorId, {
    title: input.title,
    input: taskInput,
    assignee_agent_id: entry.assignees[0],
  });
  appendTaskEvent(task.id, 'workflow-start', actorId, {
    template_id: template.template_id,
    template_name: template.template_name,
    version: template.version,
  });
  appendTaskEvent(task.id, 'node-start', null, {
    node_id: entry.node_id,
    activation: 1,
    assignees: entry.assignees,
  });

  const assignee = getAgentById(entry.assignees[0]);
  return {
    task_id: task.id,
    title: task.title,
    status: 'in_progress',
    assignee: assignee ? { id: assignee.id, display_name: assignee.display_name } : undefined,
    action: {
      type: 'node-start',
      node_id: entry.node_id,
      activation: 1,
      assignees: entry.assignees,
    },
  };
}

function eventPayload(event: TaskEvent): Record<string, any> {
  try {
    const parsed = JSON.parse(event.payload_json);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function graphActivation(events: TaskEvent[], nodeId: string): number {
  let activation = 0;
  for (const event of events) {
    if (event.type !== 'node-start') continue;
    const payload = eventPayload(event);
    if (payload.node_id === nodeId) activation = Math.max(activation, Number(payload.activation) || activation + 1);
  }
  return activation;
}

function completedAgentsForActivation(events: TaskEvent[], nodeId: string, activation: number): Set<string> {
  const completed = new Set<string>();
  for (const event of events) {
    if (event.type !== 'node-complete' || !event.actor_agent_id) continue;
    const payload = eventPayload(event);
    if (payload.node_id === nodeId && Number(payload.activation) === activation) completed.add(event.actor_agent_id);
  }
  return completed;
}

function startGraphNode(
  task: Task,
  definition: GraphWorkflowDefinition,
  nodeId: string,
  edgeId: string,
  outcome: GraphWorkflowOutcome,
): GraphWorkflowAction {
  const targetIndex = graphNodeIndex(definition, nodeId);
  const target = graphNodeAt(definition, targetIndex);
  const priorEvents = getTaskEvents(task.id, 0, 10_000);
  const activation = graphActivation(priorEvents, nodeId) + 1;
  appendTaskEvent(task.id, 'edge-taken', null, {
    edge_id: edgeId,
    from: graphNodeAt(definition, task.current_step).node_id,
    to: nodeId,
    outcome,
  });
  updateTaskStatus(task.id, 'in_progress', {
    current_step: targetIndex,
    assignee_agent_id: target.assignees[0],
  });
  appendTaskEvent(task.id, 'node-start', null, {
    node_id: target.node_id,
    activation,
    assignees: target.assignees,
  });
  return {
    type: 'node-start',
    node_id: target.node_id,
    activation,
    assignees: target.assignees,
    edge_id: edgeId,
    outcome,
  };
}

function finishOrAdvanceGraph(
  task: Task,
  definition: GraphWorkflowDefinition,
  outcome: GraphWorkflowOutcome,
  result?: string,
): GraphWorkflowAction {
  const current = graphNodeAt(definition, task.current_step);
  const edge = graphEdge(definition, current.node_id, outcome);
  if (edge) return startGraphNode(task, definition, edge.to, edge.edge_id, outcome);

  const completedAt = new Date().toISOString();
  if (outcome === 'passed') {
    updateTaskStatus(task.id, 'completed', { completed_at: completedAt });
    appendTaskEvent(task.id, 'task-complete', null, { result, final_node_id: current.node_id });
    return { type: 'task-complete', node_id: current.node_id, outcome };
  }
  updateTaskStatus(task.id, 'failed', { completed_at: completedAt });
  appendTaskEvent(task.id, 'task-fail', null, {
    reason: result || `No ${outcome} edge from ${current.node_id}`,
    final_node_id: current.node_id,
    outcome,
  });
  return { type: 'task-fail', node_id: current.node_id, outcome };
}

export function handleGraphNodeComplete(
  taskId: string,
  agentId: string,
  outcome: GraphWorkflowOutcome,
  result?: string,
): GraphWorkflowAction {
  const task = getTaskById(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const definition = parseGraphWorkflow(task.workflow_json);
  if (!definition) throw new Error('Task does not use a graph workflow');
  if (task.status !== 'in_progress') throw new Error(`Graph workflow is not running (status: ${task.status})`);

  const node = graphNodeAt(definition, task.current_step);
  if (!node.assignees.includes(agentId)) throw new Error(`Agent is not assigned to current node: ${node.node_id}`);
  const events = getTaskEvents(taskId, 0, 10_000);
  const activation = graphActivation(events, node.node_id);
  if (activation < 1) throw new Error(`Current node has no activation: ${node.node_id}`);
  const completed = completedAgentsForActivation(events, node.node_id, activation);
  if (completed.has(agentId)) throw new Error(`Agent already completed ${node.node_id} activation ${activation}`);

  appendTaskEvent(taskId, 'node-complete', agentId, {
    node_id: node.node_id,
    activation,
    outcome,
    result,
  });
  completed.add(agentId);

  // A negative review/test result takes its conditional edge immediately.
  // Positive completion still honors all/any fan-in semantics.
  if (outcome === 'passed') {
    const ready = node.completion === 'any' || completed.size >= node.assignees.length;
    if (!ready) return { type: 'waiting', node_id: node.node_id, activation, assignees: node.assignees, outcome };
    if (node.gate) {
      updateTaskStatus(taskId, 'awaiting_approval');
      appendTaskEvent(taskId, 'approval-request', null, {
        node_id: node.node_id,
        activation,
        approver: task.creator_agent_id,
      });
      return {
        type: 'awaiting_approval',
        node_id: node.node_id,
        activation,
        outcome,
        approver: task.creator_agent_id,
      };
    }
  }
  return finishOrAdvanceGraph(task, definition, outcome, result);
}

export function handleGraphGateDecision(
  taskId: string,
  agentId: string,
  decision: 'approved' | 'changes_requested' | 'failed',
  reason?: string,
): GraphWorkflowAction {
  const task = getTaskById(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const definition = parseGraphWorkflow(task.workflow_json);
  if (!definition) throw new Error('Task does not use a graph workflow');
  if (task.creator_agent_id !== agentId) throw new Error('Only the task creator can decide a graph gate');
  if (task.status !== 'awaiting_approval') throw new Error(`Task is not awaiting approval (status: ${task.status})`);
  const node = graphNodeAt(definition, task.current_step);
  if (!node.gate) throw new Error(`Current node is not gated: ${node.node_id}`);

  appendTaskEvent(taskId, 'approval-decision', agentId, {
    node_id: node.node_id,
    decision,
    reason,
  });
  const outcome: GraphWorkflowOutcome = decision === 'approved' ? 'passed' : decision;
  return finishOrAdvanceGraph(task, definition, outcome, reason);
}

// --- Task: cancel ---

const TERMINAL_STATUSES = new Set<TaskStatus>(['completed', 'failed', 'canceled']);

export function handleTaskCancel(taskId: string, agentId: string, reason?: string): void {
  const task = getTaskById(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.creator_agent_id !== agentId) {
    throw new Error('Only the task creator can cancel a task');
  }
  if (TERMINAL_STATUSES.has(task.status as TaskStatus)) {
    throw new Error(`Task already in terminal state: ${task.status}`);
  }

  // Use the workflow FSM if a workflow exists, otherwise the simple task FSM.
  if (task.workflow_json) {
    validateWorkflowTransition(task.status as TaskStatus, 'task-cancel');
  } else {
    validateTransition(task.status as TaskStatus, 'task-cancel');
  }

  updateTaskStatus(taskId, 'canceled', { completed_at: new Date().toISOString() });
  appendTaskEvent(taskId, 'task-cancel', agentId, { reason });
}

// --- Task: complete (simple, no-workflow path) ---

/** Complete a task that has NO workflow. This is the lightweight lane: an
 *  assigned/claimed task enters in_progress and the assignee just does the
 *  work and calls this. Tasks WITH a workflow must go through
 *  hive_workflow_step_complete so gates/steps stay authoritative. */
export function handleTaskComplete(taskId: string, agentId: string, result?: string): void {
  const task = getTaskById(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.assignee_agent_id !== agentId) {
    throw new Error('Only the task assignee can complete a task');
  }
  if (task.workflow_json) {
    throw new Error('This task has a workflow — use hive_workflow_step_complete for the current step instead');
  }
  if (TERMINAL_STATUSES.has(task.status as TaskStatus)) {
    throw new Error(`Task already in terminal state: ${task.status}`);
  }

  validateTransition(task.status as TaskStatus, 'task-complete');

  updateTaskStatus(taskId, 'completed', { completed_at: new Date().toISOString() });
  appendTaskEvent(taskId, 'task-complete', agentId, { result });
}

export async function handleTaskCompleteAsync(taskId: string, agentId: string, result?: string): Promise<{ task_id: string; status: 'completed' }> {
  handleTaskComplete(taskId, agentId, result);
  const task = getTaskById(taskId);
  if (task) await forwardTaskEvent(task, agentId, 'task-complete', { result });
  return { task_id: taskId, status: 'completed' };
}
