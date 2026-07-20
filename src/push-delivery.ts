import * as db from './db.js';

export interface PushIdentity {
  event_id?: string;
  message_id?: number;
  task_id?: string;
  team_id?: string;
}

export type PushDeliveryReason =
  | 'unread'
  | 'already_read'
  | 'superseded'
  | 'not_recipient'
  | 'not_found'
  | 'untracked';

export interface PushDeliveryDecision {
  deliver: boolean;
  reason: PushDeliveryReason;
  cursor?: number;
  seq?: number;
  latest_seq?: number;
  message_id?: number;
}

interface StreamSequence {
  kind: 'task' | 'team';
  id: string;
  seq: number;
}

/** Parse stable event ids: `<task|team>:<stream-id>:<type>:<seq>`. */
export function parseStreamSequence(eventId: string | undefined): StreamSequence | null {
  if (!eventId) return null;
  const match = eventId.match(/^(task|team):([^:]+):[^:]+:(\d+)$/);
  if (!match) return null;
  const seq = Number(match[3]);
  if (!Number.isSafeInteger(seq) || seq <= 0) return null;
  return { kind: match[1] as StreamSequence['kind'], id: match[2], seq };
}

/**
 * Decide whether a channel push is still actionable immediately before it is
 * delivered. This is read-only: fetching through hive_inbox/hive_dm_read owns
 * cursor advancement; delivery only consults the current watermark.
 */
export function getPushDeliveryDecision(
  agentId: string,
  push: PushIdentity,
): PushDeliveryDecision {
  if (Number.isInteger(push.message_id) && (push.message_id ?? 0) > 0) {
    const messageId = push.message_id!;
    const message = db.getDMById(messageId);
    if (!message) return { deliver: false, reason: 'not_found', message_id: messageId };
    if (message.to_agent_id !== agentId) {
      return { deliver: false, reason: 'not_recipient', message_id: messageId };
    }
    const cursor = db.getReadCursor(agentId, 'dm', message.from_agent_id);
    return {
      deliver: message.id > cursor,
      reason: message.id > cursor ? 'unread' : 'already_read',
      message_id: message.id,
      cursor,
    };
  }

  const stream = parseStreamSequence(push.event_id);
  if (!stream) return { deliver: true, reason: 'untracked' };

  if (stream.kind === 'task') {
    if (push.task_id && push.task_id !== stream.id) {
      return { deliver: false, reason: 'not_found', seq: stream.seq };
    }
    if (!db.getTaskById(stream.id)) {
      return { deliver: false, reason: 'not_found', seq: stream.seq };
    }
    const cursor = db.getReadCursor(agentId, 'task', stream.id);
    const latestSeq = db.getLatestTaskEventSeq(stream.id);
    if (stream.seq > latestSeq) return { deliver: true, reason: 'untracked' };
    if (stream.seq <= cursor) {
      return { deliver: false, reason: 'already_read', cursor, seq: stream.seq, latest_seq: latestSeq };
    }
    // Task pushes are state-transition hints. When a higher task seq already
    // exists, hive_check will expose that authoritative current state; an old
    // assignment/step notification must not start a stale model turn.
    if (stream.seq < latestSeq) {
      return { deliver: false, reason: 'superseded', cursor, seq: stream.seq, latest_seq: latestSeq };
    }
    return { deliver: true, reason: 'unread', cursor, seq: stream.seq, latest_seq: latestSeq };
  }

  if (push.team_id && push.team_id !== stream.id) {
    return { deliver: false, reason: 'not_found', seq: stream.seq };
  }
  if (!db.getTeamById(stream.id)) {
    return { deliver: false, reason: 'not_found', seq: stream.seq };
  }
  const cursor = db.getReadCursor(agentId, 'team', stream.id);
  const latestSeq = db.getLatestTeamEventSeq(stream.id);
  // Legacy team event ids ended in Date.now(), not team_events.seq. They are
  // intentionally fail-open rather than being mistaken for a future seq.
  if (stream.seq > latestSeq) return { deliver: true, reason: 'untracked' };
  // Team messages are independent content, so a later seq does not supersede
  // an earlier unread one. The monotonic cursor is the only safe skip gate.
  return {
    deliver: stream.seq > cursor,
    reason: stream.seq > cursor ? 'unread' : 'already_read',
    cursor,
    seq: stream.seq,
    latest_seq: latestSeq,
  };
}

export function parsePushPayload(payload: string): PushIdentity | null {
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' ? parsed as PushIdentity : null;
  } catch {
    return null;
  }
}

/** Mark a persisted queue delivery so channel prompts can identify replay. */
export function markPushReplayed(payload: string, queuedAt: string): string {
  try {
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== 'object') return payload;
    return JSON.stringify({ ...parsed, replayed: true, queued_at: queuedAt });
  } catch {
    return payload;
  }
}
