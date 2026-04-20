import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  handleTaskCreateAsync, handleCheck,
  handleTaskClaimAsync,
  handleWorkflowProposeAsync, handleWorkflowApproveAsync,
  handleStepCompleteAsync, handleStepApproveAsync, handleWorkflowRejectAsync,
} from '../tools/task.js';
import { asParam, authError, resolveAgent } from '../auth.js';
import { notifyAgents, notifyTaskParticipants } from '../sessions.js';
import * as db from '../db.js';

export function registerTaskTools(mcp: McpServer) {
  mcp.tool(
    'hive_task',
    'Create a task and (optionally) delegate. Omit `to` to create an unassigned task that anyone can claim.',
    {
      as: asParam,
      to: z.string().optional().describe('Target. Accepts: agent id (always works) · team-nickname (only resolved within teams you both belong to) · display_name (only if globally unambiguous) · "role:xxx" (picks an active agent with that role) · "id@<peer-name>" for federation.'),
      title: z.string().describe('Task title'),
      input: z.record(z.string(), z.unknown()).optional().describe('Structured task input'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = await handleTaskCreateAsync(agent.id, { to: params.to, title: params.title, input: params.input as object });
      if (result.assignee) {
        await notifyAgents([result.assignee.id], agent.id, JSON.stringify({
          type: 'task-assigned', from_agent_id: agent.id, from: agent.display_name,
          task_id: result.task_id, title: params.title,
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
      await notifyTaskParticipants(params.task_id, agent.id, JSON.stringify({
        type: 'task-claimed', from_agent_id: agent.id, from: agent.display_name,
        task_id: params.task_id, preview: `${agent.display_name} claimed: ${result.title}`,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive_tasks',
    'List tasks you created or are assigned to.',
    {
      as: asParam,
      status: z.string().optional().describe('Filter by status. Valid values: created, proposing, approved, in_progress, awaiting_approval, completed, failed, canceled.'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const tasks = db.getAgentTasks(agent.id, params.status);
      const board = tasks.map(t => ({
        task_id: t.id, title: t.title, status: t.status,
        creator: db.getAgentById(t.creator_agent_id)?.display_name ?? 'unknown',
        assignee: t.assignee_agent_id ? (db.getAgentById(t.assignee_agent_id)?.display_name ?? 'unknown') : 'unassigned',
        current_step: t.current_step,
        has_workflow: !!t.workflow_json,
        created_at: t.created_at,
      }));
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
        action: z.string(),
        completion: z.enum(['all', 'any']).default('all'),
        on_reject: z.string().optional().describe('What happens if THIS step is rejected. "revise" → re-do the same step (default). "back:N" → roll all the way back to step N (e.g. "back:1").'),
        gate: z.boolean().optional().describe('When true, after this step\'s assignees all finish the task pauses in `awaiting_approval` until the creator calls hive-workflow-step-approve. Use this for phases the creator will review before letting the next step start.'),
      })).describe('Workflow steps'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      await handleWorkflowProposeAsync(params.task_id, agent.id, params.workflow as any);
      await notifyTaskParticipants(params.task_id, agent.id, JSON.stringify({
        type: 'task-propose', from_agent_id: agent.id, from: agent.display_name,
        task_id: params.task_id, preview: `Workflow proposed: ${params.workflow.length} steps`,
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
      await notifyTaskParticipants(params.task_id, agent.id, JSON.stringify({
        type: 'step-start', from_agent_id: agent.id, from: agent.display_name,
        task_id: params.task_id, preview: `Step 1 started, assignees: ${action.assignees?.join(', ')}`,
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
      const resultPreview = params.result && params.result.length > 200 ? params.result.slice(0, 200) + ' [summary]' : params.result;
      let msg: string;
      if (action?.type === 'task-complete') {
        msg = 'Task completed!';
      } else if (action?.type === 'step-start') {
        msg = `Step ${action.step} started. Previous result: ${resultPreview || 'none'}`;
      } else if (action?.type === 'awaiting_approval') {
        const approver = action.approver ? db.getAgentById(action.approver)?.display_name ?? action.approver : 'creator';
        msg = `[hive note] Step ${action.step} complete — awaiting approval from ${approver}.\n` +
              `- Continue: hive-workflow-step-approve({ task_id: "${params.task_id}" })\n` +
              `- Rework:   hive-workflow-reject({ task_id: "${params.task_id}", step: ${action.step}, reason: "..." })\n` +
              `Do not start the next step until the gate is released.`;
      } else {
        msg = `Step ${params.step} progress recorded`;
      }
      await notifyTaskParticipants(params.task_id, agent.id, JSON.stringify({
        type: action?.type || 'step-complete', from_agent_id: agent.id, from: agent.display_name,
        task_id: params.task_id, preview: msg,
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
      const msg = action.type === 'task-complete'
        ? 'Task completed (final gated step approved)!'
        : `Step ${action.step} started (gate released by ${agent.display_name}).`;
      await notifyTaskParticipants(params.task_id, agent.id, JSON.stringify({
        type: action.type, from_agent_id: agent.id, from: agent.display_name,
        task_id: params.task_id, preview: msg,
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
      await notifyTaskParticipants(params.task_id, agent.id, JSON.stringify({
        type: 'task-reject', from_agent_id: agent.id, from: agent.display_name,
        task_id: params.task_id, preview: `Step ${params.step} rejected → back to step ${action.step}`,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ task_id: params.task_id, action }) }] };
    },
  );
}
