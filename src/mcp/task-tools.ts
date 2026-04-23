import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  handleTaskCreateAsync, handleCheck,
  handleTaskClaimAsync, handleTaskCancelAsync,
  handleWorkflowProposeAsync, handleWorkflowApproveAsync,
  handleStepCompleteAsync, handleStepApproveAsync, handleWorkflowRejectAsync,
} from '../tools/task.js';
import { asParam, authError, resolveAgent } from '../auth.js';
import { notifyAgents, notifyTaskParticipants } from '../sessions.js';
import { buildPushMessage } from '../preview.js';
import * as db from '../db.js';
import type { Task } from '../models.js';

function eventId(taskId: string, type: string): string {
  return `task:${taskId}:${type}:${Date.now()}`;
}

// --- Task list output projection ---
// Whitelist of fields that may appear in `hive_tasks` list responses. Adding a
// field here is a deliberate decision; this guards against accidental leaks of
// heavy fields (workflow_json / task_events / input_json) into list views,
// which would balloon token cost. To inspect a single task in detail use
// hive_check(task_id).
const TASK_LIST_FIELDS = ['id', 'title', 'status', 'step', 'creator', 'assignee', 'created_at'] as const;
type TaskListRow = { [K in typeof TASK_LIST_FIELDS[number]]: string };

function projectTaskListRow(t: Task): TaskListRow {
  // Compute step "N/M" once; M=0 when no workflow.
  const stepCount = t.workflow_json
    ? (() => { try { return (JSON.parse(t.workflow_json) as any[]).length; } catch { return 0; } })()
    : 0;
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    step: `${t.current_step ?? 0}/${stepCount}`,
    creator: db.getAgentById(t.creator_agent_id)?.display_name ?? 'unknown',
    assignee: t.assignee_agent_id ? (db.getAgentById(t.assignee_agent_id)?.display_name ?? 'unknown') : 'unassigned',
    created_at: t.created_at,
  };
}

export function registerTaskTools(mcp: McpServer) {
  mcp.tool(
    'hive_task',
    'Create a task and (optionally) delegate. Omit `to` to create an unassigned task that anyone can claim. ' +
    'Pass `source_team_id` to bind the task to a team — team members can then see it via hive_tasks(team=X), and `role:xxx` routing prefers team members. The binding is set once at create and cannot be changed later.',
    {
      as: asParam,
      to: z.string().optional().describe('Target. Accepts: agent id (always works) · team-nickname (only resolved within teams you both belong to) · display_name (only if globally unambiguous) · "role:xxx" (picks an active agent with that role; team members preferred when source_team_id is set) · "id@<peer-name>" for federation.'),
      title: z.string().describe('Task title'),
      input: z.record(z.string(), z.unknown()).optional().describe('Structured task input'),
      source_team_id: z.string().optional().describe('Team id this task belongs to. Once set, immutable — to change team, create a new task. Enables team-scoped visibility (hive_tasks(team=X)) and team-scoped role:xxx routing.'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = await handleTaskCreateAsync(agent.id, {
        to: params.to,
        title: params.title,
        input: params.input as object,
        source_team_id: params.source_team_id,
      });
      if (result.assignee) {
        await notifyAgents([result.assignee.id], agent.id, buildPushMessage({
          type: 'task-assigned',
          from: agent.display_name,
          from_agent_id: agent.id,
          event_id: eventId(result.task_id, 'task-assigned'),
          task_id: result.task_id,
        }));
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive_task_claim',
    'Claim an unassigned task (status "created", no assignee).',
    { as: asParam, task_id: z.string().describe('Task id') },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = await handleTaskClaimAsync(params.task_id, agent.id);
      await notifyTaskParticipants(params.task_id, agent.id, buildPushMessage({
        type: 'task-claimed',
        from: agent.display_name,
        from_agent_id: agent.id,
        event_id: eventId(params.task_id, 'task-claimed'),
        task_id: params.task_id,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive_task_cancel',
    'Cancel a task. Creator-only. Works in any non-terminal state (created, proposing, approved, in_progress, awaiting_approval). Notifies the assignee so they stop work.',
    {
      as: asParam,
      task_id: z.string().describe('Task id'),
      reason: z.string().optional().describe('Optional cancellation reason (will be visible in task events).'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = await handleTaskCancelAsync(params.task_id, agent.id, params.reason);
      await notifyTaskParticipants(params.task_id, agent.id, buildPushMessage({
        type: 'task-cancel',
        from: agent.display_name,
        from_agent_id: agent.id,
        event_id: eventId(params.task_id, 'task-cancel'),
        task_id: params.task_id,
        reason: params.reason,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive_tasks',
    'List tasks. Without `team`: tasks you created or are assigned to. With `team`: all tasks bound to that team via source_team_id (you must be a current team member; non-members get a 403). Use this before creating a task to avoid duplicating in-flight work in the team.',
    {
      as: asParam,
      status: z.string().optional().describe('Filter by status. Valid values: created, proposing, approved, in_progress, awaiting_approval, completed, failed, canceled.'),
      team: z.string().optional().describe('Team id or name. When set, returns ALL tasks in that team (regardless of creator/assignee). Caller must be a current member of the team.'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();

      let tasks: Task[];
      if (params.team) {
        // Resolve team: id first, then name.
        const team = db.getTeamById(params.team) || db.getTeamByName(params.team);
        if (!team) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: `team not found: ${params.team}` }) }] };
        }
        if (!db.isTeamMember(team.id, agent.id)) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: `not a member of team "${team.name}"` }) }] };
        }
        tasks = db.getTeamTasks(team.id, params.status);
      } else {
        tasks = db.getAgentTasks(agent.id, params.status);
      }

      const board = tasks.map(projectTaskListRow);
      return { content: [{ type: 'text', text: JSON.stringify(board, null, 2) }] };
    },
  );

  mcp.tool(
    'hive_check',
    'Check the current state of a task by id.',
    { task_id: z.string().describe('Task id') },
    async (params) => {
      const result = handleCheck(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive_workflow_propose',
    'Propose a workflow for a task. Creator must approve before steps start. ' +
    'For multi-phase workflows where the user (creator) will want to review the output between phases, ' +
    'set `gate: true` on each phase — the task then pauses in status `awaiting_approval` after each gated step ' +
    'until the creator calls hive-workflow-step-approve. Default (no gate) auto-advances to the next step.',
    {
      as: asParam,
      task_id: z.string().describe('Task id'),
      workflow: z.array(z.object({
        step: z.number(),
        title: z.string(),
        assignees: z.array(z.string()).describe('Agent ids or "role:xxx"'),
        action: z.string().max(400, 'step.action must be ≤400 chars — point to upstream spec (openspec change ref / issue id / doc URL / DM message_id) instead of inlining acceptance criteria. Acceptance details belong in the spec system, not in task workflow.'),
        completion: z.enum(['all', 'any']).default('all'),
        on_reject: z.string().optional().describe('What happens if THIS step is rejected. "revise" → re-do the same step (default). "back:N" → roll all the way back to step N (e.g. "back:1").'),
        gate: z.boolean().optional().describe('When true, after this step\'s assignees all finish the task pauses in `awaiting_approval` until the creator calls hive-workflow-step-approve. Use this for phases the creator will review before letting the next step start.'),
      })).describe('Workflow steps'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      await handleWorkflowProposeAsync(params.task_id, agent.id, params.workflow as any);
      await notifyTaskParticipants(params.task_id, agent.id, buildPushMessage({
        type: 'task-propose',
        from: agent.display_name,
        from_agent_id: agent.id,
        event_id: eventId(params.task_id, 'task-propose'),
        task_id: params.task_id,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ task_id: params.task_id, status: 'proposing', steps: params.workflow.length }) }] };
    },
  );

  mcp.tool(
    'hive_workflow_approve',
    'Approve a proposed workflow (creator only). Starts step 1.',
    { as: asParam, task_id: z.string().describe('Task id') },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const action = await handleWorkflowApproveAsync(params.task_id, agent.id);
      await notifyTaskParticipants(params.task_id, agent.id, buildPushMessage({
        type: 'step-start',
        from: agent.display_name,
        from_agent_id: agent.id,
        event_id: eventId(params.task_id, 'step-start'),
        task_id: params.task_id,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ task_id: params.task_id, status: 'approved', action }) }] };
    },
  );

  mcp.tool(
    'hive_workflow_step_complete',
    'Mark your part of the current step as complete. If the step has `gate: true` and you were the last assignee, the task enters `awaiting_approval` instead of auto-advancing — the creator must call hive-workflow-step-approve to release the gate.',
    {
      as: asParam,
      task_id: z.string().describe('Task id'),
      step: z.number().describe('Step number'),
      result: z.string().optional().describe('Result description'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const action = await handleStepCompleteAsync(params.task_id, agent.id, params.step, params.result);
      const pushType = action?.type || 'step-complete';
      await notifyTaskParticipants(params.task_id, agent.id, buildPushMessage({
        type: pushType,
        from: agent.display_name,
        from_agent_id: agent.id,
        event_id: eventId(params.task_id, pushType),
        task_id: params.task_id,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ task_id: params.task_id, action: action || 'waiting' }) }] };
    },
  );

  mcp.tool(
    'hive_workflow_step_approve',
    'Release a gated step\'s `awaiting_approval` pause. Creator-only. ' +
    'Call this after reviewing the output of a step that was proposed with `gate: true`. ' +
    'Advances to the next step (or completes the task if it was the last step).',
    {
      as: asParam,
      task_id: z.string().describe('Task id'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const action = await handleStepApproveAsync(params.task_id, agent.id);
      await notifyTaskParticipants(params.task_id, agent.id, buildPushMessage({
        type: action.type,
        from: agent.display_name,
        from_agent_id: agent.id,
        event_id: eventId(params.task_id, action.type),
        task_id: params.task_id,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ task_id: params.task_id, action }) }] };
    },
  );

  mcp.tool(
    'hive_workflow_reject',
    'Reject the current step. Sends task back to a previous step.',
    {
      as: asParam,
      task_id: z.string().describe('Task id'),
      step: z.number().describe('Step being rejected'),
      reason: z.string().optional().describe('Rejection reason'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const action = await handleWorkflowRejectAsync(params.task_id, agent.id, params.step, params.reason);
      await notifyTaskParticipants(params.task_id, agent.id, buildPushMessage({
        type: 'task-reject',
        from: agent.display_name,
        from_agent_id: agent.id,
        event_id: eventId(params.task_id, 'task-reject'),
        task_id: params.task_id,
        reason: params.reason,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ task_id: params.task_id, action }) }] };
    },
  );
}
