import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface KittyWakeupOptions {
  socketPath?: string;
  timeoutMs?: number;
}

export type KittyWakeupResult =
  | { kind: 'sent'; sessionId: string }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'rejected'; reason: string };

export interface KittyCodexTurnCompletedNotice {
  status: 'completed' | 'interrupted' | 'failed';
  threadId: string;
  turnId: string;
}

interface HivePushNotice {
  type?: string;
  from?: string;
  event_id?: string;
}

function parsePushNotice(payload: string): HivePushNotice {
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' ? parsed as HivePushNotice : {};
  } catch {
    return {};
  }
}

function eventLabel(type: string | undefined): string {
  if (type === 'dm') return '私信';
  if (type === 'team-message') return '团队消息';
  if (type?.startsWith('task-') || type === 'step-start' || type === 'awaiting_approval') return '任务更新';
  return '事件';
}

/**
 * Build the privacy-preserving notification sent to kitty-kitty. Hive push
 * payloads are id-only, and this deliberately forwards only sender/type/id —
 * never the DM body or task contents.
 */
export function buildKittyWakeupPayload(payload: string): Record<string, string> {
  const notice = parsePushNotice(payload);
  const sender = notice.from?.trim();
  const label = eventLabel(notice.type);
  return {
    tool: 'hive',
    hook_event_name: 'Notification',
    notification_type: 'hive_event',
    event_id: notice.event_id || '',
    message: sender ? `Hive：收到来自 ${sender} 的${label}，请查看 inbox` : `Hive：收到新的${label}，请查看 inbox`,
  };
}

/** Minimal, content-free lifecycle payload for Kitty's transient completion
 * notification. The session is addressed separately by X-Kitty-Session. */
export function buildKittyCodexTurnCompletedPayload(
  notice: KittyCodexTurnCompletedNotice,
): Record<string, string> {
  return {
    tool: 'codex',
    hook_event_name: 'TurnCompleted',
    notification_type: 'codex_turn_completed',
    status: notice.status,
    thread_id: notice.threadId,
    turn_id: notice.turnId,
  };
}

/**
 * Best-effort bridge to kitty-kitty's local wakeup server. A successful call
 * lights the matching session badge and shows the pet speech bubble. Failure
 * never changes Hive delivery/read state.
 */
export function notifyKittyWakeup(
  externalKey: string,
  payload: string,
  opts: KittyWakeupOptions = {},
): Promise<KittyWakeupResult> {
  return postKittyWakeup(
    externalKey,
    buildKittyWakeupPayload(payload),
    opts,
  );
}

/** Best-effort Codex lifecycle bridge. Unlike Hive wakeups this is a
 * transient UI event and must not create or consume Hive unread state. */
export function notifyKittyCodexTurnCompleted(
  externalKey: string,
  notice: KittyCodexTurnCompletedNotice,
  opts: KittyWakeupOptions = {},
): Promise<KittyWakeupResult> {
  return postKittyWakeup(
    externalKey,
    buildKittyCodexTurnCompletedPayload(notice),
    opts,
  );
}

function postKittyWakeup(
  externalKey: string,
  payload: Record<string, string>,
  opts: KittyWakeupOptions,
): Promise<KittyWakeupResult> {
  const sessionKey = externalKey.trim();
  if (!sessionKey) return Promise.resolve({ kind: 'unavailable', reason: 'missing external key' });

  const socketPath = opts.socketPath || process.env.KITTY_WAKEUP_SOCKET || join(homedir(), '.kitty-kitty', 'wakeup.sock');
  const timeoutMs = opts.timeoutMs ?? 750;
  const body = JSON.stringify(payload);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: KittyWakeupResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = request({
      socketPath,
      path: '/wakeup',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-kitty-session': sessionKey,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        if (size >= 16 * 1024) return;
        chunks.push(chunk);
        size += chunk.length;
      });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let response: { ok?: boolean; sessionId?: string; reason?: string } = {};
        try { response = raw ? JSON.parse(raw) : {}; } catch { /* non-JSON response */ }
        if (res.statusCode === 200 && response.ok === true) {
          finish({ kind: 'sent', sessionId: response.sessionId || sessionKey });
          return;
        }
        finish({
          kind: 'rejected',
          reason: response.reason || `HTTP ${res.statusCode ?? 'unknown'}`,
        });
      });
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', (err) => finish({ kind: 'unavailable', reason: err.message }));
    req.end(body);
  });
}
