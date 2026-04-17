import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { log } from './log.js';
import * as db from './db.js';

export interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

export const sessions: Record<string, Session> = {};
export const sessionAgents = new Map<string, string>();
export const agentSessions = new Map<string, Set<string>>();
// Sessions with an active SSE GET stream (push notifications only work for these).
export const activeSSE = new Set<string>();

export function bindSession(sessionId: string, agentId: string) {
  const oldAgentId = sessionAgents.get(sessionId);
  if (oldAgentId && oldAgentId !== agentId) {
    const oldSet = agentSessions.get(oldAgentId);
    if (oldSet) { oldSet.delete(sessionId); if (oldSet.size === 0) agentSessions.delete(oldAgentId); }
  }
  sessionAgents.set(sessionId, agentId);
  let set = agentSessions.get(agentId);
  if (!set) { set = new Set(); agentSessions.set(agentId, set); }
  set.add(sessionId);
  log('info', `[bind] session=${sessionId} → agent=${agentId} (sessions: ${set.size})`);
}

export function unbindSession(sessionId: string) {
  const agentId = sessionAgents.get(sessionId);
  if (agentId) {
    const set = agentSessions.get(agentId);
    if (set) { set.delete(sessionId); if (set.size === 0) agentSessions.delete(agentId); }
    sessionAgents.delete(sessionId);
    log('info', `[unbind] session=${sessionId} → agent=${agentId} (remaining sessions: ${set?.size ?? 0})`);
  }
  activeSSE.delete(sessionId);
}

export async function notifyAgents(agentIds: string[], excludeAgentId?: string, message?: string) {
  for (const agentId of agentIds) {
    if (agentId === excludeAgentId) continue;
    const sids = agentSessions.get(agentId);
    if (!sids || sids.size === 0) {
      log('info', `[notify] agent=${agentId} → no bound sessions, push dropped`);
      continue;
    }
    const live = [...sids].filter(s => activeSSE.has(s));
    log('info', `[notify] agent=${agentId} bound=${sids.size} live-sse=${live.length}`);
    if (live.length === 0) {
      log('warn', `[notify] agent=${agentId} has bound sessions but no active SSE stream → push dropped`);
      continue;
    }
    for (const sid of live) {
      const session = sessions[sid];
      if (!session) { log('warn', `[notify] session ${sid} NOT FOUND`); continue; }
      try {
        await session.server.sendLoggingMessage({ level: 'info', data: message ?? 'New event' }, sid);
        session.server.server.sendResourceUpdated({ uri: 'hive://inbox' });
        log('info', `[notify] sent to session ${sid} (SSE active) OK`);
      } catch (err) {
        log('warn', `[notify] failed sid=${sid}: ${err}`);
      }
    }
  }
}

export async function notifyTeamMembers(teamId: string, excludeAgentId?: string, message?: string) {
  const memberIds = db.getTeamMemberAgentIds(teamId);
  await notifyAgents(memberIds, excludeAgentId, message);
}

export async function notifyTaskParticipants(taskId: string, excludeAgentId?: string, message?: string) {
  const task = db.getTaskById(taskId);
  if (!task) return;
  const participants = new Set<string>();
  participants.add(task.creator_agent_id);
  if (task.assignee_agent_id) participants.add(task.assignee_agent_id);
  if (task.workflow_json) {
    try {
      const steps = JSON.parse(task.workflow_json);
      for (const step of steps) {
        for (const a of step.assignees || []) {
          if (a.startsWith('role:')) {
            const agent = db.findAgentByRole(a.slice(5));
            if (agent) participants.add(agent.id);
          } else {
            const byId = db.getAgentById(a);
            if (byId) participants.add(byId.id);
          }
        }
      }
    } catch { /* ignore */ }
  }
  await notifyAgents([...participants], excludeAgentId, message);
}
