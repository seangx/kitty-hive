import * as db from './db.js';
import { graphNodeAt, listWorkflowTemplates, parseGraphWorkflow } from './graph-workflow.js';
import type {
  Agent,
  GraphWorkflowDefinition,
  GraphWorkflowNode,
  Task,
  TaskEvent,
  TaskStatus as HiveTaskStatus,
  WorkflowStep,
} from './models.js';

export type RunStatus = 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'canceled';
export type NodeRunStatus = 'blocked' | 'ready' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'canceled';
export type SidecarTaskStatus = 'created' | 'claimed' | 'in_progress' | 'completed' | 'failed' | 'canceled';

export interface WorkflowTemplateRef {
  templateId: string;
  templateName: string;
  version: number;
}

export interface TemplateNode {
  nodeId: string;
  label: string;
  assigneeHint?: string;
  assigneeAgentIds?: string[];
  action?: string;
  completion?: 'all' | 'any';
  gate?: boolean;
  layout?: { x: number; y: number };
}

export interface TemplateEdge {
  edgeId: string;
  from: string;
  to: string;
  outcome?: string;
}

export interface TemplateGraph {
  nodes: TemplateNode[];
  edges: TemplateEdge[];
  entryNodeId: string;
}

export interface NodeRun {
  nodeRunId: string;
  nodeId: string;
  activation: number;
  status: NodeRunStatus;
  taskId?: string;
  assigneeName?: string;
  assigneeAgentId?: string;
  revision?: number;
  startedAt?: string;
  finishedAt?: string;
}

export interface Approval {
  approvalId: string;
  nodeRunId: string;
  status: 'pending' | 'approved' | 'rejected';
  creatorName: string;
  reason?: string;
  decidedAt?: string;
}

export interface RunSummary {
  runId: string;
  template: WorkflowTemplateRef;
  status: RunStatus;
  currentNodeLabels: string[];
  assigneeNames: string[];
  assigneeAgentIds: string[];
  awaitingCreator: boolean;
  updatedAt: string;
  workspaceDir?: string;
  branch?: string;
}

export interface RunDetail {
  summary: RunSummary;
  graph: TemplateGraph;
  nodeRuns: NodeRun[];
  approvals: Approval[];
  takenEdgeIds: string[];
}

export interface TaskAttempt {
  attempt: number;
  status: SidecarTaskStatus;
  outcome?: string;
  feedback?: string;
  evidence?: string[];
  startedAt?: string;
  finishedAt?: string;
}

export interface TaskSummary {
  taskId: string;
  title: string;
  status: SidecarTaskStatus;
  assigneeName?: string;
  assigneeAgentId?: string;
  runId?: string;
  nodeRunId?: string;
  updatedAt: string;
  workspaceDir?: string;
  branch?: string;
}

export interface TaskDetail extends TaskSummary {
  attempts: TaskAttempt[];
}

export type WorkflowEventType =
  | 'task_created'
  | 'task_claimed'
  | 'task_completed'
  | 'node_activated'
  | 'node_finished'
  | 'approval_requested'
  | 'approval_decided'
  | 'edge_taken'
  | 'run_finished';

export interface WorkflowEvent {
  eventId: string;
  runId: string;
  cursor: number;
  type: WorkflowEventType;
  nodeRunId?: string;
  taskId?: string;
  summary?: string;
  evidence?: string[];
  ts: string;
}

export interface AgentTaskBadge {
  agentId: string;
  taskId: string;
  runId?: string;
  title: string;
  status: 'queued' | 'active' | 'waiting_approval' | 'failed';
  label: string;
  updatedAt: string;
}

export interface AgentPoolEntry {
  agentId: string;
  displayName: string;
  tool: string;
  roles: string[];
  expertise?: string;
  status: Agent['status'];
  projectDir?: string;
  launchMode: 'resident';
}

export interface WorkflowTemplatePreview {
  templateId: string;
  templateName: string;
  description: string;
  version: number;
  graph: TemplateGraph;
}

export interface SidecarSnapshot {
  version: 1;
  generatedAt: string;
  runs: RunSummary[];
  tasks: TaskSummary[];
  agentBadges: AgentTaskBadge[];
  agentPool: AgentPoolEntry[];
  workflowTemplates: WorkflowTemplatePreview[];
  workflowTemplatesError?: string;
}

type AgentResolver = (id: string) => Agent | undefined;

function parseObject(json: string): Record<string, any> {
  try {
    const value = JSON.parse(json);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function parseSteps(task: Task): WorkflowStep[] {
  if (!task.workflow_json) return [];
  try {
    const value = JSON.parse(task.workflow_json);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function taskUpdatedAt(task: Task, events: TaskEvent[]): string {
  return events.at(-1)?.ts ?? task.completed_at ?? task.created_at;
}

function taskWorkspace(task: Task): { workspaceDir?: string; branch?: string } {
  const input = parseObject(task.input_json);
  return {
    workspaceDir: typeof input.workspace_dir === 'string' && input.workspace_dir ? input.workspace_dir : undefined,
    branch: typeof input.branch === 'string' && input.branch ? input.branch : undefined,
  };
}

function mapTaskStatus(status: HiveTaskStatus): SidecarTaskStatus {
  switch (status) {
    case 'created': return 'created';
    case 'proposing': return 'claimed';
    case 'approved':
    case 'in_progress':
    case 'awaiting_approval': return 'in_progress';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'canceled': return 'canceled';
  }
}

function mapRunStatus(status: HiveTaskStatus): RunStatus {
  switch (status) {
    case 'proposing':
    case 'awaiting_approval': return 'waiting_approval';
    case 'completed': return 'succeeded';
    case 'failed': return 'failed';
    case 'canceled': return 'canceled';
    default: return 'running';
  }
}

function stepNodeId(step: number): string {
  return `step:${step}`;
}

function forwardEdgeId(from: number, to: number): string {
  return `edge:${from}:${to}:passed`;
}

function rejectEdgeId(from: number, to: number): string {
  return `edge:${from}:${to}:changes_requested`;
}

function resolveStepAssignees(step: WorkflowStep | undefined, resolveAgent: AgentResolver): { ids: string[]; names: string[] } {
  if (!step) return { ids: [], names: [] };
  const ids: string[] = [];
  const names: string[] = [];
  for (const value of step.assignees) {
    const agent = resolveAgent(value);
    if (agent) {
      ids.push(agent.id);
      names.push(agent.display_name);
    } else {
      names.push(value);
    }
  }
  return { ids, names };
}

function buildGraph(steps: WorkflowStep[], resolveAgent: AgentResolver): TemplateGraph {
  const nodes = steps.map((step, index): TemplateNode => {
    const assignees = resolveStepAssignees(step, resolveAgent);
    return {
      nodeId: stepNodeId(step.step),
      label: step.title,
      assigneeHint: assignees.names.join(', ') || undefined,
      assigneeAgentIds: assignees.ids.length ? assignees.ids : undefined,
      // A compact zig-zag keeps forward edges moving left-to-right while true
      // rollback edges remain visually distinguishable as back edges.
      layout: { x: 28 + index * 122, y: 28 + (index % 2) * 76 },
    };
  });
  const edges: TemplateEdge[] = [];
  for (let index = 0; index < steps.length - 1; index += 1) {
    const from = steps[index].step;
    const to = steps[index + 1].step;
    edges.push({ edgeId: forwardEdgeId(from, to), from: stepNodeId(from), to: stepNodeId(to), outcome: 'passed' });
  }
  for (const step of steps) {
    const target = step.on_reject?.startsWith('back:')
      ? Number(step.on_reject.slice(5))
      : step.step;
    if (!Number.isInteger(target) || !steps.some(candidate => candidate.step === target)) continue;
    edges.push({
      edgeId: rejectEdgeId(step.step, target),
      from: stepNodeId(step.step),
      to: stepNodeId(target),
      outcome: 'changes_requested',
    });
  }
  return { nodes, edges, entryNodeId: nodes[0]?.nodeId ?? 'step:1' };
}

interface InternalNodeRun extends NodeRun {
  completedBy: Set<string>;
}

function latestRunForStep(runs: InternalNodeRun[], step: number): InternalNodeRun | undefined {
  return [...runs].reverse().find(run => run.nodeId === stepNodeId(step));
}

function graphNodeRunId(taskId: string, nodeId: string, activation: number): string {
  return `${taskId}:${nodeId}:${activation}`;
}

function resolveGraphAssignees(node: GraphWorkflowNode | undefined, resolveAgent: AgentResolver): { ids: string[]; names: string[] } {
  if (!node) return { ids: [], names: [] };
  return {
    ids: node.assignees,
    names: node.assignees.map(id => resolveAgent(id)?.display_name ?? id),
  };
}

function graphDefinitionPreview(definition: GraphWorkflowDefinition, resolveAgent?: AgentResolver): TemplateGraph {
  return {
    nodes: definition.nodes.map((node, index) => {
      const assignees = resolveAgent
        ? resolveGraphAssignees(node, resolveAgent)
        : { ids: [] as string[], names: node.assignees };
      return {
        nodeId: node.node_id,
        label: node.title,
        assigneeHint: assignees.names.join(', ') || undefined,
        assigneeAgentIds: assignees.ids.length ? assignees.ids : undefined,
        action: node.action,
        completion: node.completion,
        gate: Boolean(node.gate),
        layout: { x: 28 + index * 122, y: 28 + (index % 2) * 76 },
      };
    }),
    edges: definition.edges.map(edge => ({
      edgeId: edge.edge_id,
      from: edge.from,
      to: edge.to,
      outcome: edge.when,
    })),
    entryNodeId: definition.entry_node_id,
  };
}

function projectGraphRunSummary(
  task: Task,
  definition: GraphWorkflowDefinition,
  updatedAt: string,
  resolveAgent: AgentResolver,
): RunSummary {
  const current = graphNodeAt(definition, task.current_step);
  const assignees = resolveGraphAssignees(current, resolveAgent);
  return {
    runId: task.id,
    template: {
      templateId: definition.template_id,
      templateName: definition.template_name,
      version: definition.version,
    },
    status: mapRunStatus(task.status),
    currentNodeLabels: [current.title],
    assigneeNames: assignees.names,
    assigneeAgentIds: assignees.ids,
    awaitingCreator: task.status === 'awaiting_approval',
    updatedAt,
    ...taskWorkspace(task),
  };
}

function projectGraphWorkflowRun(
  task: Task,
  definition: GraphWorkflowDefinition,
  events: TaskEvent[],
  resolveAgent: AgentResolver,
): RunDetail {
  const nodeRuns: InternalNodeRun[] = [];
  const activations = new Map<string, number>();
  const takenEdgeIds: string[] = [];
  const approvals: Approval[] = [];

  const latestRun = (nodeId: string) => [...nodeRuns].reverse().find(run => run.nodeId === nodeId);

  for (const event of events) {
    const payload = parseObject(event.payload_json);
    if (event.type === 'node-start') {
      const nodeId = String(payload.node_id || '');
      const node = definition.nodes.find(candidate => candidate.node_id === nodeId);
      if (!node) continue;
      const activation = Number(payload.activation) || (activations.get(nodeId) ?? 0) + 1;
      activations.set(nodeId, Math.max(activation, activations.get(nodeId) ?? 0));
      const assignees = resolveGraphAssignees(node, resolveAgent);
      nodeRuns.push({
        nodeRunId: graphNodeRunId(task.id, nodeId, activation),
        nodeId,
        activation,
        status: 'running',
        taskId: task.id,
        assigneeName: assignees.names.join(', ') || undefined,
        assigneeAgentId: assignees.ids.length === 1 ? assignees.ids[0] : undefined,
        startedAt: event.ts,
        completedBy: new Set(),
      });
      continue;
    }

    if (event.type === 'node-complete') {
      const nodeId = String(payload.node_id || '');
      const run = latestRun(nodeId);
      const node = definition.nodes.find(candidate => candidate.node_id === nodeId);
      if (!run || !node) continue;
      if (event.actor_agent_id) run.completedBy.add(event.actor_agent_id);
      const outcome = String(payload.outcome || 'passed');
      if (outcome !== 'passed') {
        run.status = 'failed';
        run.finishedAt = event.ts;
      } else {
        const complete = node.completion === 'any' || run.completedBy.size >= node.assignees.length;
        if (complete) {
          run.status = node.gate ? 'waiting_approval' : 'succeeded';
          run.finishedAt = event.ts;
        }
      }
      continue;
    }

    if (event.type === 'edge-taken') {
      if (typeof payload.edge_id === 'string') takenEdgeIds.push(payload.edge_id);
      continue;
    }

    if (event.type === 'approval-request') {
      const nodeId = String(payload.node_id || '');
      const run = latestRun(nodeId);
      approvals.push({
        approvalId: `${task.id}:approval:${event.seq}`,
        nodeRunId: run?.nodeRunId ?? `${task.id}:${nodeId}:unknown`,
        status: 'pending',
        creatorName: resolveAgent(task.creator_agent_id)?.display_name ?? task.creator_agent_id,
        reason: `${definition.nodes.find(node => node.node_id === nodeId)?.title ?? nodeId}等待 Creator 批准`,
      });
      continue;
    }

    if (event.type === 'approval-decision') {
      const nodeId = String(payload.node_id || '');
      const run = latestRun(nodeId);
      if (run) {
        run.status = payload.decision === 'approved' ? 'succeeded' : 'failed';
        run.finishedAt = event.ts;
      }
      const pending = [...approvals].reverse().find(approval => approval.nodeRunId === run?.nodeRunId && approval.status === 'pending');
      if (pending) {
        pending.status = payload.decision === 'approved' ? 'approved' : 'rejected';
        pending.reason = typeof payload.reason === 'string' ? payload.reason : pending.reason;
        pending.decidedAt = event.ts;
      } else {
        approvals.push({
          approvalId: `${task.id}:decision:${event.seq}`,
          nodeRunId: run?.nodeRunId ?? `${task.id}:${nodeId}:unknown`,
          status: payload.decision === 'approved' ? 'approved' : 'rejected',
          creatorName: event.actor_agent_id ? resolveAgent(event.actor_agent_id)?.display_name ?? event.actor_agent_id : 'creator',
          reason: typeof payload.reason === 'string' ? payload.reason : undefined,
          decidedAt: event.ts,
        });
      }
    }
  }

  const current = graphNodeAt(definition, task.current_step);
  const currentRun = latestRun(current.node_id);
  if (currentRun) {
    if (task.status === 'awaiting_approval') currentRun.status = 'waiting_approval';
    else if (task.status === 'failed') currentRun.status = 'failed';
    else if (task.status === 'canceled') currentRun.status = 'canceled';
    else if (task.status === 'in_progress') currentRun.status = 'running';
  }

  return {
    summary: projectGraphRunSummary(task, definition, taskUpdatedAt(task, events), resolveAgent),
    graph: graphDefinitionPreview(definition, resolveAgent),
    nodeRuns: nodeRuns.map(({ completedBy: _completedBy, ...run }) => run),
    approvals,
    takenEdgeIds,
  };
}

function activationNodeRunId(taskId: string, step: number, activation: number): string {
  return `${taskId}:${step}:${activation}`;
}

function projectRunSummary(
  task: Task,
  steps: WorkflowStep[],
  updatedAt: string,
  resolveAgent: AgentResolver,
): RunSummary {
  const currentStep = steps.find(step => step.step === task.current_step);
  const assignees = task.status === 'proposing'
    ? (task.assignee_agent_id
      ? { ids: [task.assignee_agent_id], names: [resolveAgent(task.assignee_agent_id)?.display_name ?? task.assignee_agent_id] }
      : { ids: [], names: [] })
    : resolveStepAssignees(currentStep, resolveAgent);
  return {
    runId: task.id,
    template: { templateId: `task:${task.id}`, templateName: task.title, version: 1 },
    status: mapRunStatus(task.status),
    currentNodeLabels: task.status === 'proposing'
      ? ['等待批准工作流']
      : currentStep ? [currentStep.title] : [],
    assigneeNames: assignees.names,
    assigneeAgentIds: assignees.ids,
    awaitingCreator: task.status === 'proposing' || task.status === 'awaiting_approval',
    updatedAt,
    ...taskWorkspace(task),
  };
}

export function projectWorkflowRun(
  task: Task,
  events: TaskEvent[],
  resolveAgent: AgentResolver,
): RunDetail | null {
  const graph = parseGraphWorkflow(task.workflow_json);
  if (graph) return projectGraphWorkflowRun(task, graph, events, resolveAgent);
  const steps = parseSteps(task);
  if (!task.workflow_json || steps.length === 0) return null;

  const runs: InternalNodeRun[] = [];
  const activations = new Map<number, number>();
  const takenEdgeIds: string[] = [];
  const approvals: Approval[] = [];
  let lastStartedStep: number | undefined;

  for (const event of events) {
    const payload = parseObject(event.payload_json);
    if (event.type === 'step-start') {
      const step = Number(payload.step);
      if (!Number.isInteger(step)) continue;
      const activation = (activations.get(step) ?? 0) + 1;
      activations.set(step, activation);
      const spec = steps.find(candidate => candidate.step === step);
      const assignees = resolveStepAssignees(spec, resolveAgent);
      runs.push({
        nodeRunId: activationNodeRunId(task.id, step, activation),
        nodeId: stepNodeId(step),
        activation,
        status: 'running',
        taskId: task.id,
        assigneeName: assignees.names.join(', ') || undefined,
        assigneeAgentId: assignees.ids.length === 1 ? assignees.ids[0] : undefined,
        startedAt: event.ts,
        completedBy: new Set(),
      });
      if (lastStartedStep !== undefined && step === lastStartedStep + 1) {
        takenEdgeIds.push(forwardEdgeId(lastStartedStep, step));
      }
      lastStartedStep = step;
      continue;
    }

    if (event.type === 'step-complete') {
      const step = Number(payload.step);
      const run = latestRunForStep(runs, step);
      const spec = steps.find(candidate => candidate.step === step);
      if (!run || !spec) continue;
      if (event.actor_agent_id) run.completedBy.add(event.actor_agent_id);
      const done = spec.completion === 'any'
        ? run.completedBy.size > 0
        : run.completedBy.size >= Math.max(spec.assignees.length, 1);
      if (done) {
        run.status = spec.gate ? 'waiting_approval' : 'succeeded';
        run.finishedAt = event.ts;
      }
      continue;
    }

    if (event.type === 'task-reject') {
      const from = Number(payload.step);
      const to = Number(payload.target_step ?? from);
      const run = latestRunForStep(runs, from);
      if (run) {
        run.status = 'failed';
        run.finishedAt = event.ts;
      }
      if (Number.isInteger(from) && Number.isInteger(to)) takenEdgeIds.push(rejectEdgeId(from, to));
      approvals.push({
        approvalId: `${task.id}:reject:${event.seq}`,
        nodeRunId: run?.nodeRunId ?? `${task.id}:${from}:unknown`,
        status: 'rejected',
        creatorName: event.actor_agent_id ? resolveAgent(event.actor_agent_id)?.display_name ?? event.actor_agent_id : 'creator',
        reason: typeof payload.reason === 'string' ? payload.reason : undefined,
        decidedAt: event.ts,
      });
      continue;
    }

    if (event.type === 'step-approve') {
      const step = Number(payload.step);
      const run = latestRunForStep(runs, step);
      if (run) run.status = 'succeeded';
      approvals.push({
        approvalId: `${task.id}:approve:${event.seq}`,
        nodeRunId: run?.nodeRunId ?? `${task.id}:${step}:unknown`,
        status: 'approved',
        creatorName: event.actor_agent_id ? resolveAgent(event.actor_agent_id)?.display_name ?? event.actor_agent_id : 'creator',
        decidedAt: event.ts,
      });
    }
  }

  const currentStep = steps.find(step => step.step === task.current_step);
  const currentRun = currentStep ? latestRunForStep(runs, currentStep.step) : undefined;
  if (currentRun) {
    if (task.status === 'awaiting_approval') currentRun.status = 'waiting_approval';
    else if (task.status === 'failed') currentRun.status = 'failed';
    else if (task.status === 'canceled') currentRun.status = 'canceled';
    else if (task.status === 'in_progress' || task.status === 'approved') currentRun.status = 'running';
  }

  const creator = resolveAgent(task.creator_agent_id);
  if (task.status === 'proposing') {
    approvals.push({
      approvalId: `${task.id}:proposal`,
      nodeRunId: `${task.id}:proposal`,
      status: 'pending',
      creatorName: creator?.display_name ?? task.creator_agent_id,
      reason: '等待 Creator 批准工作流',
    });
  } else if (task.status === 'awaiting_approval' && currentRun) {
    approvals.push({
      approvalId: `${task.id}:gate:${currentRun.nodeRunId}`,
      nodeRunId: currentRun.nodeRunId,
      status: 'pending',
      creatorName: creator?.display_name ?? task.creator_agent_id,
      reason: `${currentStep?.title ?? '当前步骤'}等待 Creator 批准`,
    });
  }

  return {
    summary: projectRunSummary(task, steps, taskUpdatedAt(task, events), resolveAgent),
    graph: buildGraph(steps, resolveAgent),
    nodeRuns: runs.map(({ completedBy: _completedBy, ...run }) => run),
    approvals,
    takenEdgeIds,
  };
}

export function projectStandaloneTask(task: Task, events: TaskEvent[], resolveAgent: AgentResolver): TaskDetail | null {
  if (task.workflow_json) return null;
  const summary = projectTaskSummary(task, taskUpdatedAt(task, events), resolveAgent);
  const last = events.at(-1);
  const payload = last ? parseObject(last.payload_json) : {};
  return {
    ...summary,
    attempts: [{
      attempt: 1,
      status: summary.status,
      outcome: task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' : undefined,
      feedback: typeof payload.result === 'string'
        ? payload.result
        : typeof payload.reason === 'string' ? payload.reason : undefined,
      startedAt: task.created_at,
      finishedAt: task.completed_at ?? undefined,
    }],
  };
}

function projectTaskSummary(task: Task, updatedAt: string, resolveAgent: AgentResolver): TaskSummary {
  const assignee = task.assignee_agent_id ? resolveAgent(task.assignee_agent_id) : undefined;
  return {
    taskId: task.id,
    title: task.title,
    status: mapTaskStatus(task.status),
    assigneeName: assignee?.display_name,
    assigneeAgentId: assignee?.id,
    updatedAt,
    ...taskWorkspace(task),
  };
}

function eventNodeRunId(taskId: string, step: number, events: TaskEvent[], throughSeq: number): string | undefined {
  let activation = 0;
  for (const event of events) {
    if (event.seq > throughSeq || event.type !== 'step-start') continue;
    const payload = parseObject(event.payload_json);
    if (Number(payload.step) === step) activation += 1;
  }
  return activation ? activationNodeRunId(taskId, step, activation) : undefined;
}

function graphEventNodeRunId(taskId: string, nodeId: string, events: TaskEvent[], throughSeq: number): string | undefined {
  let activation = 0;
  for (const event of events) {
    if (event.seq > throughSeq || event.type !== 'node-start') continue;
    const payload = parseObject(event.payload_json);
    if (payload.node_id === nodeId) activation = Number(payload.activation) || activation + 1;
  }
  return activation ? graphNodeRunId(taskId, nodeId, activation) : undefined;
}

function mapWorkflowEvent(task: Task, event: TaskEvent, allEvents: TaskEvent[]): WorkflowEvent | null {
  const payload = parseObject(event.payload_json);
  const step = Number(payload.step);
  const base = { eventId: `${task.id}:${event.seq}`, runId: task.id, cursor: event.seq, taskId: task.id, ts: event.ts };
  switch (event.type) {
    case 'task-start': return { ...base, type: 'task_created', summary: `创建任务：${task.title}` };
    case 'task-claim': return { ...base, type: 'task_claimed', summary: '任务已领取' };
    case 'workflow-start': return { ...base, type: 'task_created', summary: `启动工作流模板：${payload.template_name ?? payload.template_id ?? ''}` };
    case 'node-start': {
      const nodeId = String(payload.node_id || '');
      const activation = Number(payload.activation) || 1;
      return { ...base, type: 'node_activated', nodeRunId: graphNodeRunId(task.id, nodeId, activation), summary: `开始节点 ${nodeId}` };
    }
    case 'node-complete': {
      const nodeId = String(payload.node_id || '');
      const activation = Number(payload.activation) || 1;
      return {
        ...base,
        type: 'node_finished',
        nodeRunId: graphNodeRunId(task.id, nodeId, activation),
        summary: typeof payload.result === 'string' ? payload.result : `${nodeId}: ${payload.outcome ?? 'passed'}`,
      };
    }
    case 'edge-taken': {
      const from = String(payload.from || '');
      return {
        ...base,
        type: 'edge_taken',
        nodeRunId: graphEventNodeRunId(task.id, from, allEvents, event.seq),
        summary: `${from} → ${payload.to ?? ''} (${payload.outcome ?? ''})`,
      };
    }
    case 'approval-request': {
      const nodeId = String(payload.node_id || '');
      const activation = Number(payload.activation) || 1;
      return { ...base, type: 'approval_requested', nodeRunId: graphNodeRunId(task.id, nodeId, activation), summary: `节点 ${nodeId} 等待 Creator 批准` };
    }
    case 'approval-decision': {
      const nodeId = String(payload.node_id || '');
      return {
        ...base,
        type: 'approval_decided',
        nodeRunId: graphEventNodeRunId(task.id, nodeId, allEvents, event.seq),
        summary: `Creator: ${payload.decision ?? 'approved'}${payload.reason ? `：${payload.reason}` : ''}`,
      };
    }
    case 'task-propose': return { ...base, type: 'approval_requested', summary: '工作流已提案，等待 Creator 批准' };
    case 'task-approve': return { ...base, type: 'approval_decided', summary: 'Creator 已批准工作流' };
    case 'step-start': return { ...base, type: 'node_activated', nodeRunId: eventNodeRunId(task.id, step, allEvents, event.seq), summary: `开始步骤 ${step}` };
    case 'step-complete': return { ...base, type: 'node_finished', nodeRunId: eventNodeRunId(task.id, step, allEvents, event.seq), summary: typeof payload.result === 'string' ? payload.result : `完成步骤 ${step}` };
    case 'step-approve': return { ...base, type: 'approval_decided', nodeRunId: eventNodeRunId(task.id, step, allEvents, event.seq), summary: `Creator 已批准步骤 ${step}` };
    case 'task-reject': {
      const target = Number(payload.target_step ?? step);
      return { ...base, type: 'edge_taken', nodeRunId: eventNodeRunId(task.id, step, allEvents, event.seq), summary: `步骤 ${step} 被打回到步骤 ${target}${payload.reason ? `：${payload.reason}` : ''}` };
    }
    case 'task-complete': return { ...base, type: 'run_finished', summary: '工作流已完成' };
    case 'task-fail': return { ...base, type: 'run_finished', summary: `工作流失败${payload.reason ? `：${payload.reason}` : ''}` };
    case 'task-cancel': return { ...base, type: 'run_finished', summary: `工作流已取消${payload.reason ? `：${payload.reason}` : ''}` };
    default: return null;
  }
}

export function getSidecarSnapshot(limit = 200): SidecarSnapshot {
  const tasks = db.listTaskOverviews(limit);
  const resolveAgent: AgentResolver = id => db.getAgentById(id);
  const runs: RunSummary[] = [];
  const standalone: TaskSummary[] = [];
  const agentBadges: AgentTaskBadge[] = [];

  for (const task of tasks) {
    const updatedAt = task.latest_event_ts ?? task.completed_at ?? task.created_at;
    if (task.workflow_json) {
      const graph = parseGraphWorkflow(task.workflow_json);
      const steps = graph ? [] : parseSteps(task);
      if (!graph && steps.length === 0) continue;
      const summary = graph
        ? projectGraphRunSummary(task, graph, updatedAt, resolveAgent)
        : projectRunSummary(task, steps, updatedAt, resolveAgent);
      runs.push(summary);
      if (!['completed', 'failed', 'canceled'].includes(task.status)) {
        const badgeTargets = task.status === 'proposing' || task.status === 'awaiting_approval'
          ? [task.creator_agent_id]
          : summary.assigneeAgentIds;
        for (const agentId of [...new Set(badgeTargets)]) {
          agentBadges.push({
            agentId,
            taskId: task.id,
            runId: task.id,
            title: task.title,
            status: summary.awaitingCreator ? 'waiting_approval' : 'active',
            label: summary.currentNodeLabels[0] ?? 'Workflow',
            updatedAt,
          });
        }
      }
      continue;
    }

    const summary = projectTaskSummary(task, updatedAt, resolveAgent);
    standalone.push(summary);
    if (!['completed', 'failed', 'canceled'].includes(task.status)) {
      const agentId = task.assignee_agent_id ?? task.creator_agent_id;
      agentBadges.push({
        agentId,
        taskId: task.id,
        title: task.title,
        status: task.status === 'created' ? 'queued' : 'active',
        label: task.status === 'created' ? '待领取' : 'Task',
        updatedAt,
      });
    }
  }

  const agentPool: AgentPoolEntry[] = db.listAllAgents(false)
    .filter(agent => !agent.origin_peer)
    .map(agent => ({
      agentId: agent.id,
      displayName: agent.display_name,
      tool: agent.tool,
      roles: agent.roles.split(',').map(role => role.trim()).filter(Boolean),
      expertise: agent.expertise || undefined,
      status: agent.status,
      projectDir: agent.project_dir || undefined,
      launchMode: 'resident',
    }));

  let workflowTemplates: WorkflowTemplatePreview[] = [];
  let workflowTemplatesError: string | undefined;
  try {
    workflowTemplates = listWorkflowTemplates().map(template => ({
      templateId: template.template_id,
      templateName: template.template_name,
      description: template.description,
      version: template.version,
      graph: graphDefinitionPreview(template.definition),
    }));
  } catch (error) {
    workflowTemplatesError = error instanceof Error ? error.message : String(error);
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    runs,
    tasks: standalone,
    agentBadges,
    agentPool,
    workflowTemplates,
    ...(workflowTemplatesError ? { workflowTemplatesError } : {}),
  };
}

export function getSidecarRun(taskId: string): RunDetail | null {
  const task = db.getTaskById(taskId);
  if (!task) return null;
  return projectWorkflowRun(task, db.getTaskEvents(taskId, 0, 1000), id => db.getAgentById(id));
}

export function getSidecarRunEvents(taskId: string, since = 0): { events: WorkflowEvent[]; nextCursor: number } | null {
  const task = db.getTaskById(taskId);
  if (!task || !task.workflow_json) return null;
  const allEvents = db.getTaskEvents(taskId, 0, 1000);
  const events = allEvents
    .filter(event => event.seq > since)
    .map(event => mapWorkflowEvent(task, event, allEvents))
    .filter((event): event is WorkflowEvent => event !== null);
  return { events, nextCursor: allEvents.at(-1)?.seq ?? since };
}

export function getSidecarTask(taskId: string): TaskDetail | null {
  const task = db.getTaskById(taskId);
  if (!task) return null;
  return projectStandaloneTask(task, db.getTaskEvents(taskId, 0, 1000), id => db.getAgentById(id));
}
