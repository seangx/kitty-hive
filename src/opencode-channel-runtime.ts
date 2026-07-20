import { buildEventTimingLines } from './codex-channel-runtime.js';

export interface OpenCodeSession {
  id: string;
  title?: string;
  directory?: string;
  version?: string;
}

export interface OpenCodeAssistantMessage {
  info?: {
    id?: string;
    role?: string;
    time?: { completed?: number };
    finish?: string;
  };
  parts?: Array<{ type?: string; text?: string }>;
}

export interface HivePushEvent {
  type?: string;
  from?: string;
  from_agent_id?: string;
  message_id?: number;
  task_id?: string;
  team_id?: string;
  preview?: string;
  title?: string;
  event_id?: string;
  raw?: string;
  received_at?: string;
  replayed?: boolean;
  queued_at?: string;
}

export type OpenCodeInjectOutcome =
  | { kind: 'completed'; eventId: string }
  | { kind: 'skipped_duplicate'; eventId: string }
  | { kind: 'timeout'; eventId: string; afterMs: number }
  | { kind: 'failed'; eventId: string; error: Error; status?: number };

export class OpenCodeHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = 'OpenCodeHttpError';
  }
}

export function eventDedupKey(ev: HivePushEvent): string {
  if (ev.event_id) return `evid:${ev.event_id}`;
  if (ev.message_id != null) return `dm:${ev.message_id}`;
  if (ev.task_id) return `task:${ev.task_id}:${ev.type || 'unknown'}`;
  if (ev.team_id) return `team:${ev.team_id}:${ev.type || 'unknown'}`;
  return `raw:${ev.from_agent_id || 'unknown'}:${ev.type || 'unknown'}:${(ev.raw || ev.preview || '').slice(0, 80)}`;
}

export function buildOpenCodePrompt(
  ev: HivePushEvent,
  agent: { id: string; name: string },
): string {
  const eventId = eventDedupKey(ev);
  if (ev.type === 'daemon-intro') {
    return [
      `You are kitty-hive agent "${agent.name}" (id: ${agent.id}).`,
      `You are running inside a persistent OpenCode session driven by the`,
      `kitty-hive opencode-channel daemon. The daemon injects one short turn`,
      `per hive event; handle that event, then wait for the next.`,
      ``,
      `FIRST ACTION: call hive_start({ id: "${agent.id}" }) to bind the MCP`,
      `session to your hive identity. Do this before handling the first event.`,
      `If a later turn says the daemon restarted, call hive_start again.`,
      ``,
      `Push notifications are id-only. Always call the fetch tool named by the`,
      `event (hive_dm_read / hive_check / hive_team_events / hive_team_info)`,
      `before acting. For task-assigned, finish the work and call`,
      `hive_task_complete; only propose a workflow when multiple agents,`,
      `multiple steps, or review gates are genuinely needed.`,
      ``,
      `Acknowledge readiness briefly, then wait for the first event.`,
      `event_id: ${eventId}`,
    ].join('\n');
  }
  if (ev.type === 'daemon-rebind') {
    return [
      `[kitty-hive] daemon restarted — your MCP session is fresh.`,
      `Call hive_start({ id: "${agent.id}" }) again to re-bind your identity`,
      `before handling the next event. This OpenCode conversation was resumed.`,
      `Compare each later event's received timestamp with the current time;`,
      `for stale work, fetch current hive state before responding.`,
      `Then wait silently for the next push.`,
      `event_id: ${eventId}`,
    ].join('\n');
  }

  const senderLabel = ev.from || ev.from_agent_id || 'unknown';
  const summary = ev.title || ev.preview || ev.raw || '(no summary)';
  let fetchHint: string;
  if (ev.message_id != null) {
    fetchHint = `hive_dm_read({ message_id: ${ev.message_id}, as: "${agent.id}" })`;
  } else if (ev.task_id) {
    fetchHint = `hive_check({ task_id: "${ev.task_id}", as: "${agent.id}" })`;
  } else if (ev.team_id) {
    fetchHint = ev.type === 'team-rules-update'
      ? `hive_team_info({ team_id: "${ev.team_id}", as: "${agent.id}" })`
      : `hive_team_events({ team_id: "${ev.team_id}", as: "${agent.id}" })`;
  } else {
    fetchHint = `hive_inbox({ as: "${agent.id}" })`;
  }

  return [
    `[kitty-hive event] type=${ev.type || 'unknown'} from=${senderLabel}`,
    `summary: ${summary}`,
    `fetch: ${fetchHint}`,
    ...buildEventTimingLines(ev),
    `event_id: ${eventId}`,
    ``,
    `You are kitty-hive agent "${agent.name}" (id: ${agent.id}).`,
    `The notification is id-only by design: fetch the full content before acting.`,
    `DM: reply with hive_dm when appropriate. Task assigned: do the work, then call`,
    `hive_task_complete({ task_id, result }); only propose a workflow for genuinely`,
    `multi-step, multi-agent, or review-gated work. Step start: finish your part and`,
    `call hive_workflow_step_complete. Do not approve gates unless you are the creator.`,
  ].join('\n');
}

export class OpenCodeClient {
  private readonly authorization: string;

  constructor(
    public readonly baseUrl: string,
    username: string,
    password: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs = 30_000,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', this.authorization);
    if (init.body != null && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const signal = init.signal ?? AbortSignal.timeout(timeoutMs);
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers, signal });
    const body = await res.text();
    if (!res.ok) {
      throw new OpenCodeHttpError(
        `OpenCode ${init.method || 'GET'} ${path} failed: HTTP ${res.status}${body ? ` ${body.slice(0, 300)}` : ''}`,
        res.status,
        body,
      );
    }
    if (!body) return undefined as T;
    return JSON.parse(body) as T;
  }

  health(timeoutMs = 5_000): Promise<{ healthy: boolean; version: string }> {
    return this.request('/global/health', {}, timeoutMs);
  }

  getSession(sessionId: string, timeoutMs = 5_000): Promise<OpenCodeSession> {
    return this.request(`/session/${encodeURIComponent(sessionId)}`, {}, timeoutMs);
  }

  createSession(title: string, timeoutMs = 10_000): Promise<OpenCodeSession> {
    return this.request('/session', {
      method: 'POST',
      body: JSON.stringify({ title }),
    }, timeoutMs);
  }

  async getSessionStatus(sessionId: string, timeoutMs = 5_000): Promise<'idle' | 'busy' | 'retry'> {
    const statuses = await this.request<Record<string, { type?: string }>>('/session/status', {}, timeoutMs);
    const type = statuses?.[sessionId]?.type;
    return type === 'busy' || type === 'retry' ? type : 'idle';
  }

  async waitUntilIdle(sessionId: string, timeoutMs = 30 * 60_000): Promise<boolean> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const status = await this.getSessionStatus(sessionId);
      if (status === 'idle') return true;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return false;
  }

  async selectTuiSession(sessionId: string, timeoutMs = 5_000): Promise<boolean> {
    return this.request('/tui/select-session', {
      method: 'POST',
      body: JSON.stringify({ sessionID: sessionId }),
    }, timeoutMs);
  }

  async hasEventMarker(sessionId: string, eventId: string, timeoutMs = 10_000): Promise<boolean> {
    const messages = await this.request<Array<{
      info?: { role?: string };
      parts?: Array<{ type?: string; text?: string }>;
    }>>(`/session/${encodeURIComponent(sessionId)}/message?limit=100`, {}, timeoutMs);
    const marker = `event_id: ${eventId}`;
    return messages.some(message =>
      message.info?.role === 'user'
      && message.parts?.some(part => part.type === 'text' && part.text?.includes(marker))
    );
  }

  async inject(
    sessionId: string,
    eventId: string,
    text: string,
    timeoutMs = 10 * 60_000,
  ): Promise<OpenCodeInjectOutcome> {
    try {
      const idle = await this.waitUntilIdle(sessionId, timeoutMs);
      if (!idle) return { kind: 'timeout', eventId, afterMs: timeoutMs };

      // OpenCode's request schema accepts a caller-supplied messageID, but
      // 1.18.0 treats non-native ids as a continuation-loop parent and can
      // emit unbounded empty assistant turns. Keep OpenCode-generated ids and
      // use the event marker in recent user messages as the idempotency check.
      if (await this.hasEventMarker(sessionId, eventId)) {
        return { kind: 'skipped_duplicate', eventId };
      }

      await this.request<void>(
        `/session/${encodeURIComponent(sessionId)}/prompt_async`,
        {
          method: 'POST',
          body: JSON.stringify({
            parts: [{ type: 'text', text }],
          }),
        }, 30_000,
      );

      // prompt_async returns 204 as soon as the message is accepted. Observe
      // the subsequent busy/retry state and only release the next queued hive
      // event after this session becomes idle again. The short idle grace
      // handles a very fast failure/completion that occurs between polls.
      const started = Date.now();
      let sawBusy = false;
      while (Date.now() - started < timeoutMs) {
        const status = await this.getSessionStatus(sessionId);
        if (status !== 'idle') sawBusy = true;
        if (status === 'idle' && (sawBusy || Date.now() - started >= 1_000)) {
          return { kind: 'completed', eventId };
        }
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      return { kind: 'timeout', eventId, afterMs: timeoutMs };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        return { kind: 'timeout', eventId, afterMs: timeoutMs };
      }
      if (err instanceof OpenCodeHttpError) {
        return { kind: 'failed', eventId, error: err, status: err.status };
      }
      return { kind: 'failed', eventId, error: err instanceof Error ? err : new Error(String(err)) };
    }
  }
}
