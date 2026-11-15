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

function kittySocketPath(opts: KittyWakeupOptions): string {
  return opts.socketPath || process.env.KITTY_WAKEUP_SOCKET || join(homedir(), '.kitty-kitty', 'wakeup.sock');
}

type KittySocketResponse =
  | { kind: 'response'; status: number; body: Record<string, unknown> }
  | { kind: 'error'; reason: string; timedOut: boolean };

/** One bounded JSON request over Kitty's local wakeup socket. */
function kittySocketRequest(
  method: 'GET' | 'POST',
  path: string,
  sessionKey: string,
  payload: Record<string, unknown> | null,
  opts: KittyWakeupOptions,
  defaultTimeoutMs: number,
): Promise<KittySocketResponse> {
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
  const body = payload ? JSON.stringify(payload) : '';
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const finish = (result: KittySocketResponse) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const headers: Record<string, string | number> = { 'x-kitty-session': sessionKey };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    const req = request({ socketPath: kittySocketPath(opts), path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        if (size >= 16 * 1024) return;
        chunks.push(chunk);
        size += chunk.length;
      });
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { /* non-JSON response */ }
        finish({
          kind: 'response',
          status: res.statusCode ?? 0,
          body: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {},
        });
      });
      res.on('error', (err) => finish({ kind: 'error', reason: err.message, timedOut }));
    });
    req.setTimeout(timeoutMs, () => {
      timedOut = true;
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.on('error', (err) => finish({ kind: 'error', reason: err.message, timedOut }));
    req.end(body || undefined);
  });
}

async function postKittyWakeup(
  externalKey: string,
  payload: Record<string, string>,
  opts: KittyWakeupOptions,
): Promise<KittyWakeupResult> {
  const sessionKey = externalKey.trim();
  if (!sessionKey) return { kind: 'unavailable', reason: 'missing external key' };
  const res = await kittySocketRequest('POST', '/wakeup', sessionKey, payload, opts, 750);
  if (res.kind === 'error') return { kind: 'unavailable', reason: res.reason };
  if (res.status === 200 && res.body.ok === true) {
    return { kind: 'sent', sessionId: typeof res.body.sessionId === 'string' && res.body.sessionId ? res.body.sessionId : sessionKey };
  }
  return {
    kind: 'rejected',
    reason: typeof res.body.reason === 'string' && res.body.reason ? res.body.reason : `HTTP ${res.status || 'unknown'}`,
  };
}

// ===== Fresh context (GX-89) =====
// Hive asks Kitty to clear a managed session's conversation before a host
// delivers new work. Kitty owns the idle/draft checks and the actual clear;
// a repeated POST with the same request_id returns the recorded outcome.

export interface KittyFreshContextRequest {
  agentId: string;
  tool: string;
  requestId: string;
}

export type KittyFreshContextResult =
  | { kind: 'cleared'; newExternalId?: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'timeout'; reason: string };

export type KittyFreshContextLookup =
  | { kind: 'found'; cleared: boolean; reason?: string; newExternalId?: string }
  | { kind: 'not_found' }
  | { kind: 'unavailable'; reason: string };

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

export async function requestKittyFreshContext(
  externalKey: string,
  input: KittyFreshContextRequest,
  opts: KittyWakeupOptions = {},
): Promise<KittyFreshContextResult> {
  const sessionKey = externalKey.trim();
  if (!sessionKey) return { kind: 'unavailable', reason: 'missing external key' };
  const res = await kittySocketRequest('POST', '/fresh-context', sessionKey, {
    agent_id: input.agentId,
    tool: input.tool,
    request_id: input.requestId,
  }, opts, 20_000);
  if (res.kind === 'error') {
    return res.timedOut ? { kind: 'timeout', reason: res.reason } : { kind: 'unavailable', reason: res.reason };
  }
  if (res.status >= 200 && res.status < 300 && res.body.ok === true) {
    const newExternalId = optionalString(res.body.new_external_id);
    return newExternalId ? { kind: 'cleared', newExternalId } : { kind: 'cleared' };
  }
  // A Kitty without this endpoint answers 404 without a reason.
  if (res.status === 404 && !optionalString(res.body.reason)) {
    return { kind: 'unavailable', reason: 'kitty does not support fresh-context' };
  }
  return { kind: 'rejected', reason: optionalString(res.body.reason) || `HTTP ${res.status || 'unknown'}` };
}

export async function lookupKittyFreshContextResult(
  externalKey: string,
  requestId: string,
  opts: KittyWakeupOptions = {},
): Promise<KittyFreshContextLookup> {
  const sessionKey = externalKey.trim();
  if (!sessionKey) return { kind: 'unavailable', reason: 'missing external key' };
  const res = await kittySocketRequest(
    'GET',
    `/fresh-context/result?request_id=${encodeURIComponent(requestId)}`,
    sessionKey,
    null,
    opts,
    2_000,
  );
  if (res.kind === 'error') return { kind: 'unavailable', reason: res.reason };
  if (res.status < 200 || res.status >= 300) {
    return res.status === 404 && res.body.found !== true
      ? { kind: 'not_found' }
      : { kind: 'unavailable', reason: `HTTP ${res.status || 'unknown'}` };
  }
  if (res.body.found !== true) return { kind: 'not_found' };
  if (typeof res.body.cleared !== 'boolean') return { kind: 'unavailable', reason: 'invalid lookup response' };
  const reason = optionalString(res.body.reason);
  const newExternalId = optionalString(res.body.new_external_id);
  return {
    kind: 'found',
    cleared: res.body.cleared,
    ...(reason ? { reason } : {}),
    ...(newExternalId ? { newExternalId } : {}),
  };
}
