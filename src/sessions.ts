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
  // If SSE is already active for this session, drain immediately. (When SSE
  // opens before bind, the SSE handler also schedules a drain; this covers
  // the opposite ordering.)
  if (activeSSE.has(sessionId)) {
    setImmediate(() => {
      drainPushesForAgent(agentId).catch(err => log('warn', `[drain] failed for ${agentId}: ${err}`));
    });
  }
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
  const payload = message ?? 'New event';
  for (const agentId of agentIds) {
    if (agentId === excludeAgentId) continue;
    const sids = agentSessions.get(agentId);
    const live = sids ? [...sids].filter(s => activeSSE.has(s)) : [];
    if (live.length === 0) {
      // No live SSE — persist so a future reconnect / restart can pick it up.
      db.enqueuePendingPush(agentId, payload);
      log('info', `[notify] agent=${agentId} → no live SSE, enqueued`);
      continue;
    }
    log('info', `[notify] agent=${agentId} live-sse=${live.length}`);
    let anyDelivered = false;
    for (const sid of live) {
      const session = sessions[sid];
      if (!session) { log('warn', `[notify] session ${sid} NOT FOUND`); continue; }
      try {
        await session.server.sendLoggingMessage({ level: 'info', data: payload }, sid);
        session.server.server.sendResourceUpdated({ uri: 'hive://inbox' });
        log('info', `[notify] sent to session ${sid} (SSE active) OK`);
        anyDelivered = true;
      } catch (err) {
        log('warn', `[notify] failed sid=${sid}: ${err}`);
      }
    }
    // If every live session failed to receive, fall back to persistent queue
    // so the message isn't lost. (Channel-side dedup by event_id will absorb
    // any duplicate that manages to slip through later.)
    if (!anyDelivered) {
      db.enqueuePendingPush(agentId, payload);
      log('warn', `[notify] agent=${agentId} all sends failed → enqueued`);
    }
  }
}

/**
 * Drains every pending push for the given agent through whichever live SSE
 * sessions are currently bound. Called from the SSE GET handler right after
 * the stream is registered. Idempotent: rows are removed only after at least
 * one session confirmed the send.
 */
export async function drainPushesForAgent(agentId: string): Promise<void> {
  const sids = agentSessions.get(agentId);
  const live = sids ? [...sids].filter(s => activeSSE.has(s)) : [];
  if (live.length === 0) return;

  const rows = db.listPendingPushes(agentId);
  if (rows.length === 0) return;

  log('info', `[drain] agent=${agentId} pending=${rows.length} live-sse=${live.length}`);
  const delivered: number[] = [];
  for (const row of rows) {
    let ok = false;
    for (const sid of live) {
      const session = sessions[sid];
      if (!session) continue;
      try {
        await session.server.sendLoggingMessage({ level: 'info', data: row.payload }, sid);
        session.server.server.sendResourceUpdated({ uri: 'hive://inbox' });
        ok = true;
      } catch (err) {
        log('warn', `[drain] failed sid=${sid} push=${row.id}: ${err}`);
      }
    }
    if (ok) delivered.push(row.id);
    else break; // stop on first failure to preserve order
  }
  if (delivered.length > 0) {
    db.deletePendingPushes(delivered);
    log('info', `[drain] agent=${agentId} delivered=${delivered.length}/${rows.length}`);
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
