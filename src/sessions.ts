import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { log } from './log.js';
import * as db from './db.js';
import { getPushDeliveryDecision, markPushReplayed, parsePushPayload } from './push-delivery.js';
import { notifyKittyWakeup } from './kitty-wakeup.js';
import { notifyAgentCreated, noteCodexRuntimeDemand, isCodexRuntimeRetiring } from './codex-supervisor.js';
import { shouldWakeCodexForEvent } from './codex-runtime-policy.js';

export interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

export const sessions: Record<string, Session> = {};
export const sessionAgents = new Map<string, string>();
export const agentSessions = new Map<string, Set<string>>();
// Sessions with an active SSE GET stream. Standard MCP clients also open one
// for server notifications, so activeSSE alone does not mean "Hive event
// consumer".
export const activeSSE = new Set<string>();
// Channel daemons opt in through the kitty-hive/event-consumer experimental
// MCP capability. When at least one opted-in session exists for an agent,
// pushes go only there.
export const eventConsumers = new Set<string>();
// Remember agents that have used the explicit consumer protocol. If their
// channel disconnects while an ordinary MCP SSE remains open, queue events
// instead of falling back to the tool session and falsely reporting delivery.
export const eventConsumerAgents = new Set<string>();
const activeDrains = new Map<string, Promise<void>>();

export function declaresEventConsumer(
  clientName: unknown,
  experimentalCapabilities: unknown,
): boolean {
  const capabilities = experimentalCapabilities && typeof experimentalCapabilities === 'object'
    ? experimentalCapabilities as Record<string, unknown>
    : {};
  return Object.prototype.hasOwnProperty.call(capabilities, 'kitty-hive/event-consumer')
    // Compatibility for channel clients released before the capability marker
    // was added.
    || clientName === 'hive-channel'
    || clientName === 'codex-channel'
    || clientName === 'opencode-channel';
}

export function livePushSessionsForAgent(agentId: string): string[] {
  // The retiring SSE may still accept bytes while its process is exiting.
  // Treat it as offline until the replacement daemon has announced ready.
  if (isCodexRuntimeRetiring(agentId)) return [];
  const sids = agentSessions.get(agentId);
  const live = sids ? [...sids].filter(s => activeSSE.has(s)) : [];
  const consumers = live.filter(s => eventConsumers.has(s));
  if (consumers.length > 0) return consumers;
  return eventConsumerAgents.has(agentId) ? [] : live;
}

export function markEventConsumer(sessionId: string) {
  eventConsumers.add(sessionId);
  const agentId = sessionAgents.get(sessionId);
  if (agentId) eventConsumerAgents.add(agentId);
}

export function bindSession(sessionId: string, agentId: string) {
  const oldAgentId = sessionAgents.get(sessionId);
  if (oldAgentId && oldAgentId !== agentId) {
    const oldSet = agentSessions.get(oldAgentId);
    if (oldSet) { oldSet.delete(sessionId); if (oldSet.size === 0) agentSessions.delete(oldAgentId); }
  }
  sessionAgents.set(sessionId, agentId);
  if (eventConsumers.has(sessionId)) eventConsumerAgents.add(agentId);
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
  eventConsumers.delete(sessionId);
}

// ===== Push holds (GX-89 fresh context) =====
// While Hive clears an agent's conversation, other pushes must not become the
// new conversation's first input. Held pushes go to the persistent queue and
// drain only after the hold ends; the fresh-context DM itself bypasses it.
const pushHolds = new Map<string, number>();

export function beginPushHold(agentId: string): void {
  pushHolds.set(agentId, (pushHolds.get(agentId) ?? 0) + 1);
}

export function endPushHold(agentId: string): void {
  const remaining = (pushHolds.get(agentId) ?? 0) - 1;
  if (remaining > 0) {
    pushHolds.set(agentId, remaining);
    return;
  }
  pushHolds.delete(agentId);
  // A drain that started before the hold may have stopped early; run a new
  // pass after it settles instead of sharing its (truncated) promise.
  const inFlight = activeDrains.get(agentId) ?? Promise.resolve();
  inFlight
    .catch(() => undefined)
    .then(() => drainPushesForAgent(agentId))
    .catch(err => log('warn', `[drain] failed for ${agentId}: ${err}`));
}

export function isPushHeld(agentId: string): boolean {
  return (pushHolds.get(agentId) ?? 0) > 0;
}

export interface NotifyOptions {
  /** Deliver even while the target's pushes are held (fresh-context DM). */
  bypassHold?: boolean;
}

export async function notifyAgents(agentIds: string[], excludeAgentId?: string, message?: string, opts: NotifyOptions = {}) {
  const payload = message ?? 'New event';
  const visibleNotifications: Promise<void>[] = [];
  for (const agentId of agentIds) {
    if (agentId === excludeAgentId) continue;
    const target = db.getAgentById(agentId);
    // Invalidate any in-flight idle-stop before either live delivery or enqueue.
    if (target?.tool === 'codex') noteCodexRuntimeDemand(agentId);
    if (
      target?.event_mode === 'foreground'
      && target.tool === 'codex'
      && target.origin_peer === ''
      && target.external_key
    ) {
      visibleNotifications.push(notifyKittyWakeup(target.external_key, payload).then((result) => {
        if (result.kind === 'sent') {
          log('info', `[notify] agent=${agentId} → kitty visible wakeup OK`);
        } else {
          // Headless/server-only Hive installs normally have no Kitty socket;
          // that is not a delivery failure. Keep details at debug level.
          log('debug', `[notify] agent=${agentId} kitty wakeup ${result.kind}: ${result.reason}`);
        }
      }));
    }
    if (isPushHeld(agentId) && !opts.bypassHold) {
      db.enqueuePendingPush(agentId, payload);
      log('info', `[notify] agent=${agentId} → push held (fresh context in progress), enqueued`);
      continue;
    }
    const live = livePushSessionsForAgent(agentId);
    if (live.length === 0) {
      // No live SSE — persist so a future reconnect / restart can pick it up.
      db.enqueuePendingPush(agentId, payload);
      if (shouldWakeCodexForEvent(target)) notifyAgentCreated(agentId);
      log('info', `[notify] agent=${agentId} → no live event consumer, enqueued`);
      continue;
    }
    log('info', `[notify] agent=${agentId} live-consumers=${live.length}`);
    let anyDelivered = false;
    for (const sid of live) {
      const session = sessions[sid];
      if (!session) { log('warn', `[notify] session ${sid} NOT FOUND`); continue; }
      try {
        await session.server.sendLoggingMessage({ level: 'info', data: payload }, sid);
        session.server.server.sendResourceUpdated({ uri: 'hive://inbox' });
        log('info', `[notify] sent to event consumer ${sid} OK`);
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
      if (shouldWakeCodexForEvent(target)) notifyAgentCreated(agentId);
      log('warn', `[notify] agent=${agentId} all sends failed → enqueued`);
    }
  }
  await Promise.all(visibleNotifications);
}

/**
 * Drains every pending push for the given agent through whichever live SSE
 * sessions are currently bound. Called from the SSE GET handler right after
 * the stream is registered. Idempotent: rows are removed only after at least
 * one session confirmed the send.
 */
async function drainPendingPushesOnce(agentId: string): Promise<void> {
  const live = livePushSessionsForAgent(agentId);
  if (live.length === 0) return;

  const rows = db.listPendingPushes(agentId);
  if (rows.length === 0) return;

  log('info', `[drain] agent=${agentId} pending=${rows.length} live-consumers=${live.length}`);
  const settled: number[] = [];
  let deliveredCount = 0;
  let skippedCount = 0;
  for (const row of rows) {
    // A fresh-context hold may begin while an older drain is iterating.
    if (isPushHeld(agentId)) break;
    const identity = parsePushPayload(row.payload);
    if (identity) {
      try {
        const decision = getPushDeliveryDecision(agentId, identity);
        if (!decision.deliver) {
          settled.push(row.id);
          skippedCount++;
          log('info', `[drain] skipped stale push=${row.id} agent=${agentId} reason=${decision.reason} seq=${decision.seq ?? decision.message_id ?? 'n/a'} cursor=${decision.cursor ?? 'n/a'}`);
          continue;
        }
      } catch (err) {
        // Fail open. A duplicate notification is recoverable through the
        // channel's own preflight; silently losing unread work is not.
        log('warn', `[drain] watermark check failed push=${row.id}; fail-open: ${err}`);
      }
    }

    const replayPayload = markPushReplayed(row.payload, row.created_at);
    let ok = false;
    for (const sid of live) {
      const session = sessions[sid];
      if (!session) continue;
      try {
        await session.server.sendLoggingMessage({ level: 'info', data: replayPayload }, sid);
        session.server.server.sendResourceUpdated({ uri: 'hive://inbox' });
        ok = true;
      } catch (err) {
        log('warn', `[drain] failed sid=${sid} push=${row.id}: ${err}`);
      }
    }
    if (ok) {
      settled.push(row.id);
      deliveredCount++;
    }
    else break; // stop on first failure to preserve order
  }
  if (settled.length > 0) {
    db.deletePendingPushes(settled);
    log('info', `[drain] agent=${agentId} delivered=${deliveredCount} skipped=${skippedCount} settled=${settled.length}/${rows.length}`);
  }
}

/**
 * Single-flight wrapper: SSE-open and hive_start binding can schedule a drain
 * for the same agent on adjacent ticks. Sharing one promise prevents both
 * callers from reading and replaying the same pending rows before deletion.
 */
export function drainPushesForAgent(agentId: string): Promise<void> {
  // endPushHold drains once the hold is released.
  if (isPushHeld(agentId)) return Promise.resolve();
  const existing = activeDrains.get(agentId);
  if (existing) return existing;
  const run = drainPendingPushesOnce(agentId).finally(() => {
    if (activeDrains.get(agentId) === run) activeDrains.delete(agentId);
  });
  activeDrains.set(agentId, run);
  return run;
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
      const workflow = JSON.parse(task.workflow_json);
      const nodes = Array.isArray(workflow) ? workflow : Array.isArray(workflow?.nodes) ? workflow.nodes : [];
      for (const node of nodes) {
        for (const a of node.assignees || []) {
          if (a.startsWith('role:')) {
            const agent = db.findAgentByRole(a.slice(5), { teamId: task.source_team_id ?? undefined });
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
