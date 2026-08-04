/**
 * codex-channel-runtime — the testable core of codex-channel.ts.
 *
 * Encapsulates everything that talks to a codex app-server's JSON-RPC v2
 * protocol (https://github.com/openai/codex 0.125+): issuing `turn/start`,
 * tracking in-flight turns by their server-assigned turn id, and reacting to
 * `turn/completed` / `turn/interrupt` / `error` notifications.
 *
 * The 2026-05-26 monkeys-tester incident exposed two bugs in the previous
 * implementation that this module replaces:
 *
 *   1. **FIFO waiter mismatch.** sendTurn pushed a bare `resolve` onto an
 *      array; the WS handler shifted from the front on any `turn/completed`.
 *      A timeout left orphan resolvers behind, so later `turn/completed`s
 *      woke the wrong waiter — cascading misroutes silently failed all
 *      subsequent turns.
 *
 *   2. **Retry-after-turn/start duplication.** When the daemon's wait for
 *      `turn/completed` timed out at 10 min, the old retry loop issued a
 *      fresh `turn/start` — but codex had already created the turn and
 *      written the input text into the thread. Each retry produced another
 *      duplicate turn. Affected agent saw the same DM 2-3× in their codex
 *      thread, sometimes more.
 *
 * Design:
 *
 *   - One `TurnTracker` instance per daemon, owns a `Map<turnId, Waiter>`
 *     keyed by the turn id from `turn/start` response. WS notifications are
 *     routed by `turnId` (or `turn.id`) — no FIFO assumption.
 *
 *   - `sendTurn(text)` returns a `TurnOutcome` discriminated-union. Callers
 *     branch on `outcome.kind` instead of catching errors. The kind is one of
 *     `completed | failed | interrupted | timeout | rpc_send_error |
 *     skipped_duplicate`. This makes the "do not retry on timeout" rule
 *     explicit in the type rather than relying on caller discipline.
 *
 *   - `sendTurn(text, {eventId})` dedups by `eventId`. Once a turn/start has
 *     been issued for an eventId (whether successful, timeout, or anything
 *     else short of a pre-send error), the tracker refuses to issue another
 *     turn/start for the same eventId in this process lifetime. Conservative
 *     trade-off: prefer losing one event over duplicating it. Hive's SSE
 *     replay/pending_pushes can recover lost events; nothing recovers a
 *     duplicated turn from a user's codex thread.
 */

import type { PushIdentity, PushDeliveryReason } from './push-delivery.js';

export interface CodexTurn {
  id: string;
  status?: string;
  [k: string]: unknown;
}

export interface TurnStartResponse {
  turn: CodexTurn;
}

export interface ErrorNotificationParams {
  error: unknown;
  threadId: string;
  turnId: string;
  willRetry: boolean;
}

export type TurnOutcome =
  | { kind: 'completed'; turnId: string; turn: CodexTurn }
  | { kind: 'failed'; turnId: string; willRetry: boolean; error: unknown }
  | { kind: 'interrupted'; turnId: string; turn?: CodexTurn }
  | { kind: 'timeout'; turnId: string; afterMs: number }
  | { kind: 'rpc_send_error'; error: Error }
  | { kind: 'skipped_duplicate'; eventId: string };

interface Waiter {
  turnId: string;
  resolve: (outcome: TurnOutcome) => void;
  timer: NodeJS.Timeout;
}

/** Adapter so the tracker can stay agnostic about whether the underlying
 *  transport is a real WebSocket (codex-channel.ts) or a stub (tests). */
export interface RpcTransport {
  /** Send a JSON-RPC request and resolve to its `result`. Reject with Error
   *  on network failure, RPC-level error, or timeout. */
  call(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
}

export interface ThreadResumeParams {
  threadId: string;
  cwd: string;
  excludeTurns: true;
}

export interface AppServerInitializeParams {
  clientInfo: {
    name: string;
    version: string;
  };
  capabilities: {
    experimentalApi: true;
  };
}

/** Opt in to Codex's experimental protocol surface.
 *
 * `thread/resume.excludeTurns` is experimental and Codex rejects the field
 * unless the client enables this capability during its single initialize
 * request. The field is available in Codex 0.125+.
 */
export function buildAppServerInitializeParams(
  clientInfo: AppServerInitializeParams['clientInfo'],
): AppServerInitializeParams {
  return {
    clientInfo,
    capabilities: { experimentalApi: true },
  };
}

export type ProcessProbe = (pid: number, signal: 0) => void;

/** True only when a configured supervisor PID is known to no longer exist.
 *
 * Missing/invalid configuration keeps standalone codex-channel invocations
 * working. EPERM also means "still alive but not signalable", so only ESRCH
 * authorizes the daemon to tear itself down.
 */
export function supervisorProcessIsMissing(
  rawPid: string | undefined,
  probe: ProcessProbe = process.kill,
): boolean {
  if (!rawPid) return false;
  const pid = Number(rawPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    probe(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Build resume overrides for a supervised Codex thread.
 *
 * A rollout's original session_meta cwd is immutable, so resuming with only
 * threadId restores that stale cwd and hides project-local skills deployed
 * after the thread was first created. Codex app-server supports cwd as a
 * thread/resume override; always carry the daemon's authoritative project cwd
 * on both boot-time resume and in-process thread switches. `excludeTurns`
 * omits the potentially enormous serialized history from the RPC response;
 * it does not discard the history Codex loads internally for the resumed
 * thread.
 */
export function buildThreadResumeParams(threadId: string, cwd: string): ThreadResumeParams {
  return { threadId, cwd, excludeTurns: true };
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Preserve the useful details hidden inside Node/Undici WebSocket events.
 *
 * Undici exposes protocol failures such as its maximum-payload rejection on
 * `event.error`, while the outer event commonly contains only `type=error`.
 */
export function describeWebSocketEvent(event: unknown): string {
  const outer = recordOf(event);
  const nested = recordOf(outer?.error);
  const type = nonEmptyString(outer?.type);
  const message = nonEmptyString(nested?.message) ?? nonEmptyString(outer?.message);
  const code = nested?.code ?? outer?.code;
  const reason = nonEmptyString(outer?.reason);
  const details: string[] = [];

  if (type) details.push(`type=${type}`);
  if (code !== undefined && code !== null && String(code).trim()) details.push(`code=${String(code)}`);
  if (message) details.push(`message=${message}`);
  if (reason) details.push(`reason=${reason}`);

  return details.join(' ') || 'unknown';
}

export interface TurnTrackerOptions {
  /** How long to wait for `turn/completed` after `turn/start` succeeds.
   *  Default 10 min — matches codex's typical long-running turn budget. */
  turnTimeoutMs?: number;
  /** Retain daemon-started turn ids after their waiter times out so a late
   *  terminal notification cannot be mistaken for a foreground TUI turn. */
  ownedTurnTtlMs?: number;
  /** Hard memory bound for retained daemon-owned turn ids. */
  ownedTurnMaxEntries?: number;
  /** Injectable clock for deterministic ownership-expiry tests. */
  now?: () => number;
  /** Hook for tests / observability. Called once per terminal outcome. */
  onOutcome?: (outcome: TurnOutcome, eventId?: string) => void;
}

export type HistoryInjectOutcome =
  | { kind: 'injected'; eventId?: string }
  | { kind: 'rpc_send_error'; error: Error }
  | { kind: 'skipped_duplicate'; eventId: string };

export type HiveEventMode = 'auto' | 'foreground';
export type ChannelPushMode = 'appserver' | 'exec' | null;
export type EventDeliveryPath = 'background_turn' | 'foreground_history' | 'foreground_unavailable';

/** Pure ownership decision used before any model-capable operation. */
export function decideEventDelivery(eventMode: HiveEventMode, pushMode: ChannelPushMode): EventDeliveryPath {
  if (eventMode === 'foreground') {
    return pushMode === 'appserver' ? 'foreground_history' : 'foreground_unavailable';
  }
  return 'background_turn';
}

/** Persist model-visible context without starting a Codex turn. This is the
 *  safety boundary for foreground-owned Hive agents: only the next real
 *  user-authored turn can run tools and advance Hive read cursors. */
export class HistoryItemInjector {
  private injectedEventIds = new Set<string>();

  constructor(
    private readonly transport: RpcTransport,
    private threadId: string,
  ) {}

  setThreadId(threadId: string): void {
    this.threadId = threadId;
  }

  async injectDeveloperText(text: string, opts: { eventId?: string } = {}): Promise<HistoryInjectOutcome> {
    const { eventId } = opts;
    if (eventId && this.injectedEventIds.has(eventId)) {
      return { kind: 'skipped_duplicate', eventId };
    }
    if (eventId) this.injectedEventIds.add(eventId);

    try {
      await this.transport.call('thread/inject_items', {
        threadId: this.threadId,
        items: [{
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text }],
        }],
      });
      return { kind: 'injected', eventId };
    } catch (err) {
      // The RPC may have reached app-server even if the response was lost.
      // Keep the id reserved and never retry in-process; Hive remains unread
      // and the next foreground hive_inbox call is the authoritative recovery.
      return {
        kind: 'rpc_send_error',
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }
}

export interface EventDeliveryDecision {
  deliver: boolean;
  reason: PushDeliveryReason | 'preflight_error';
  message_id?: number;
  cursor?: number;
  seq?: number;
  latest_seq?: number;
  error?: string;
}

export type DmDeliveryDecision = EventDeliveryDecision;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Ask hive whether a queued event is still actionable immediately before
 * injection. Fail open on transport/protocol errors: a duplicate notification
 * is safer than silently dropping a genuinely unread event during a restart.
 */
export async function checkEventDeliveryBeforeInject(
  adminUrl: string,
  agentId: string,
  event: PushIdentity,
  fetchImpl: FetchLike = fetch,
): Promise<EventDeliveryDecision> {
  try {
    const res = await fetchImpl(adminUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agentId, ...event }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as Partial<EventDeliveryDecision>;
    if (typeof data.deliver !== 'boolean' || typeof data.reason !== 'string') {
      throw new Error('invalid delivery-status response');
    }
    return data as EventDeliveryDecision;
  } catch (err: any) {
    return {
      deliver: true,
      reason: 'preflight_error',
      message_id: event.message_id,
      error: String(err?.message || err),
    };
  }
}

/** Backward-compatible convenience wrapper used by older integrations/tests. */
export function checkDmDeliveryBeforeInject(
  adminUrl: string,
  agentId: string,
  messageId: number,
  fetchImpl: FetchLike = fetch,
): Promise<DmDeliveryDecision> {
  return checkEventDeliveryBeforeInject(adminUrl, agentId, { message_id: messageId }, fetchImpl);
}

export interface EventTiming {
  received_at?: string;
  replayed?: boolean;
  queued_at?: string;
}

/** Make queue delay/restart replay explicit in model-visible event prompts. */
export function buildEventTimingLines(
  event: EventTiming,
  nowMs = Date.now(),
  delayedAfterMs = 30_000,
): string[] {
  const received = event.received_at || new Date(nowMs).toISOString();
  const lines = [`received: ${received}`];
  if (event.replayed) {
    lines.push(`replayed: true${event.queued_at ? ` (originally queued ${event.queued_at})` : ''}`);
  }
  const originMs = Date.parse(event.queued_at || received);
  if (Number.isFinite(originMs)) {
    const delayMs = Math.max(0, nowMs - originMs);
    if (delayMs >= delayedAfterMs) {
      lines.push(`queued_delivery: true (delay_ms=${delayMs}; fetch authoritative current state before acting)`);
    }
  }
  return lines;
}

export type CodexTerminalStatus = 'completed' | 'interrupted' | 'failed';

export interface CodexTerminalNotice {
  threadId: string;
  turnId: string;
  status: CodexTerminalStatus;
}

export type CodexTerminalDecision =
  | { kind: 'notify'; notice: CodexTerminalNotice }
  | {
      kind: 'ignored';
      reason: 'not-terminal' | 'wrong-thread' | 'daemon-owned' | 'duplicate';
      notice?: CodexTerminalNotice;
    };

export interface CodexTerminalNotificationTrackerOptions {
  seenTtlMs?: number;
  seenMaxEntries?: number;
  now?: () => number;
}

export function parseCodexTerminalNotice(
  method: string,
  params: unknown,
): CodexTerminalNotice | null {
  if (method === 'turn/completed') {
    const p = params as { threadId?: string; turn?: CodexTurn };
    const turnId = p?.turn?.id;
    const threadId = p?.threadId;
    if (!threadId || !turnId || p.turn?.status === 'inProgress') return null;
    const status: CodexTerminalStatus =
      p.turn?.status === 'interrupted'
        ? 'interrupted'
        : p.turn?.status === 'failed'
          ? 'failed'
          : 'completed';
    return { threadId, turnId, status };
  }
  if (method === 'turn/interrupt') {
    const p = params as { threadId?: string; turnId?: string; turn?: CodexTurn };
    const turnId = p?.turn?.id || p?.turnId;
    if (!p?.threadId || !turnId) return null;
    return { threadId: p.threadId, turnId, status: 'interrupted' };
  }
  if (method === 'error') {
    const p = params as Partial<ErrorNotificationParams>;
    if (!p?.threadId || !p?.turnId || p.willRetry === true) return null;
    return { threadId: p.threadId, turnId: p.turnId, status: 'failed' };
  }
  return null;
}

/**
 * Classify terminal app-server notifications for Kitty UI delivery.
 *
 * The app-server broadcasts thread events to both the daemon and an attached
 * remote TUI. Only terminal events for the daemon's CURRENT thread that were
 * not started by the daemon itself are user-visible foreground completions.
 * Every terminal id is remembered before ownership filtering so a duplicate
 * notification cannot become visible after daemon ownership is released.
 */
export class CodexTerminalNotificationTracker {
  private seen = new Map<string, number>();
  private readonly seenTtlMs: number;
  private readonly seenMaxEntries: number;
  private readonly now: () => number;

  constructor(
    private threadId: string,
    opts: CodexTerminalNotificationTrackerOptions = {},
  ) {
    this.seenTtlMs = opts.seenTtlMs ?? 24 * 60 * 60 * 1000;
    this.seenMaxEntries = Math.max(1, opts.seenMaxEntries ?? 2048);
    this.now = opts.now ?? Date.now;
  }

  setThreadId(threadId: string): void {
    this.threadId = threadId;
  }

  observe(
    method: string,
    params: unknown,
    daemonOwned: boolean,
  ): CodexTerminalDecision {
    return this.observeNotice(
      parseCodexTerminalNotice(method, params),
      daemonOwned,
    );
  }

  observeNotice(
    notice: CodexTerminalNotice | null,
    daemonOwned: boolean,
  ): CodexTerminalDecision {
    if (!notice) return { kind: 'ignored', reason: 'not-terminal' };

    const now = this.now();
    this.prune(now);
    const dedupKey = `${notice.threadId}:${notice.turnId}`;
    if (this.seen.has(dedupKey)) {
      return { kind: 'ignored', reason: 'duplicate', notice };
    }
    this.seen.set(dedupKey, now + this.seenTtlMs);
    this.enforceBound();

    if (notice.threadId !== this.threadId) {
      return { kind: 'ignored', reason: 'wrong-thread', notice };
    }
    if (daemonOwned) {
      return { kind: 'ignored', reason: 'daemon-owned', notice };
    }
    return { kind: 'notify', notice };
  }

  private prune(now: number): void {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(key);
    }
  }

  private enforceBound(): void {
    while (this.seen.size > this.seenMaxEntries) {
      const oldest = this.seen.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }
}

export class TurnTracker {
  private waiters = new Map<string, Waiter>();
  private injectedEventIds = new Set<string>();
  private daemonOwnedTurns = new Map<string, number>();
  private readonly turnTimeoutMs: number;
  private readonly ownedTurnTtlMs: number;
  private readonly ownedTurnMaxEntries: number;
  private readonly now: () => number;
  private readonly onOutcome?: TurnTrackerOptions['onOutcome'];

  constructor(
    private readonly transport: RpcTransport,
    private threadId: string,
    opts: TurnTrackerOptions = {},
  ) {
    this.turnTimeoutMs = opts.turnTimeoutMs ?? 600_000;
    this.ownedTurnTtlMs = opts.ownedTurnTtlMs ?? 24 * 60 * 60 * 1000;
    this.ownedTurnMaxEntries = Math.max(1, opts.ownedTurnMaxEntries ?? 2048);
    this.now = opts.now ?? Date.now;
    this.onOutcome = opts.onOutcome;
  }

  /** Retarget future `turn/start` calls at a different codex thread. Used by
   *  the in-process thread switch (daemon stays alive, thread changes).
   *  In-flight waiters are unaffected: notifications route by turnId, so a
   *  turn started on the old thread still resolves normally. The
   *  injectedEventIds set is intentionally kept — event ids are globally
   *  unique, and a switch must not reopen the duplicate-inject window. */
  setThreadId(threadId: string): void {
    this.threadId = threadId;
  }

  /** Issue `turn/start` and resolve when codex reports the turn's terminal
   *  state. Never throws — failure modes are encoded in the returned
   *  `TurnOutcome.kind` so callers can branch declaratively. */
  async sendTurn(text: string, opts: { eventId?: string } = {}): Promise<TurnOutcome> {
    const { eventId } = opts;

    // Idempotency: refuse to re-issue turn/start for an event we've already
    // tried, regardless of how that prior attempt ended. Without this, a
    // caller that catches an outcome.kind === 'timeout' and re-queues the
    // event would re-trigger the original duplication bug — codex would
    // create a second turn in the thread for the same logical hive event.
    if (eventId && this.injectedEventIds.has(eventId)) {
      const outcome: TurnOutcome = { kind: 'skipped_duplicate', eventId };
      this.onOutcome?.(outcome, eventId);
      return outcome;
    }
    if (eventId) this.injectedEventIds.add(eventId);

    let resp: TurnStartResponse;
    try {
      resp = (await this.transport.call('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text }],
      })) as TurnStartResponse;
    } catch (err) {
      // Pre-RPC-response failure: TCP/WS error, or rpcCall timeout (codex
      // didn't reply within rpcCall's own deadline — much shorter than the
      // turn deadline). NOTE we still keep the eventId in injectedEventIds
      // because we cannot prove codex didn't receive the start; resending
      // the same eventId might create a duplicate turn there. Conservative
      // by design.
      const outcome: TurnOutcome = {
        kind: 'rpc_send_error',
        error: err instanceof Error ? err : new Error(String(err)),
      };
      this.onOutcome?.(outcome, eventId);
      return outcome;
    }

    const turnId = resp?.turn?.id;
    if (!turnId) {
      const outcome: TurnOutcome = {
        kind: 'rpc_send_error',
        error: new Error(`turn/start response missing turn.id: ${JSON.stringify(resp)}`),
      };
      this.onOutcome?.(outcome, eventId);
      return outcome;
    }
    this.rememberOwnedTurn(turnId);

    // Register waiter keyed by turn id. Codex's notifications include turnId
    // — we use that to route, not the FIFO order. Multiple concurrent turns
    // on the same thread (rare for our use case but supported by codex) work
    // correctly because each waiter is independently identified.
    return new Promise<TurnOutcome>((resolve) => {
      const timer = setTimeout(() => {
        // Codex never fired turn/completed within budget. The turn is still
        // (possibly) in-flight on codex's side and the input text is in
        // thread history. We do NOT re-issue turn/start. Caller drops the
        // event; if codex eventually completes the turn, that completion
        // notification will hit our handler with no waiter to resolve, and
        // is safely ignored.
        if (this.waiters.has(turnId)) {
          this.waiters.delete(turnId);
          const outcome: TurnOutcome = { kind: 'timeout', turnId, afterMs: this.turnTimeoutMs };
          this.onOutcome?.(outcome, eventId);
          resolve(outcome);
        }
      }, this.turnTimeoutMs);

      this.waiters.set(turnId, {
        turnId,
        resolve: (outcome) => {
          clearTimeout(timer);
          this.waiters.delete(turnId);
          this.onOutcome?.(outcome, eventId);
          resolve(outcome);
        },
        timer,
      });
    });
  }

  /** Route a codex JSON-RPC notification (anything that isn't an RPC response
   *  to a request the daemon issued). The caller — typically the WS message
   *  handler — should invoke this for every parsed notification. Returns
   *  true if the notification matched a waiter, false otherwise (useful for
   *  diagnostic logging). */
  handleNotification(method: string, params: unknown): boolean {
    if (method === 'turn/completed') {
      const p = params as { threadId?: string; turn?: CodexTurn };
      const turnId = p?.turn?.id;
      if (!turnId) return false;
      const w = this.waiters.get(turnId);
      if (!w) return false;  // unknown turn (late completion after timeout etc.)
      w.resolve({ kind: 'completed', turnId, turn: p.turn! });
      return true;
    }
    if (method === 'turn/interrupt') {
      const p = params as { threadId?: string; turn?: CodexTurn };
      const turnId = p?.turn?.id;
      if (!turnId) return false;
      const w = this.waiters.get(turnId);
      if (!w) return false;
      w.resolve({ kind: 'interrupted', turnId, turn: p.turn });
      return true;
    }
    if (method === 'error') {
      const p = params as Partial<ErrorNotificationParams>;
      const turnId = p?.turnId;
      if (!turnId) return false;
      const w = this.waiters.get(turnId);
      if (!w) return false;
      // willRetry === true means codex's own retry layer will try the turn
      // again internally — leave the waiter pending and wait for the eventual
      // completion / final error. Only resolve when willRetry is false.
      if (p.willRetry === true) return false;
      w.resolve({
        kind: 'failed',
        turnId,
        willRetry: !!p.willRetry,
        error: p.error ?? null,
      });
      return true;
    }
    return false;
  }

  /** True when `turnId` belongs to a turn THIS tracker started and is still
   *  waiting on. Used as the ownership gate for server→client approval
   *  requests: the daemon must never answer approvals for turns a human
   *  pane started on the shared app-server. */
  isActiveTurn(turnId: string | undefined): boolean {
    return !!turnId && this.waiters.has(turnId);
  }

  /** True for any retained turn id started by this daemon, including a turn
   *  whose waiter already timed out. This is deliberately broader than
   *  isActiveTurn(), which remains the strict approval-response gate. */
  isOwnedTurn(turnId: string | undefined): boolean {
    if (!turnId) return false;
    this.pruneOwnedTurns(this.now());
    return this.daemonOwnedTurns.has(turnId);
  }

  /** Release ownership after a terminal notification has been classified.
   *  The separate terminal-notification dedup set guards duplicate delivery. */
  releaseOwnedTurn(turnId: string | undefined): void {
    if (turnId) this.daemonOwnedTurns.delete(turnId);
  }

  /** Diagnostic snapshot of in-flight turns. Not used at runtime; exposed
   *  for the optional `/admin/codex-daemons` extension and tests. */
  snapshot(): { activeTurns: string[]; ownedTurns: string[]; injectedEventIds: number } {
    this.pruneOwnedTurns(this.now());
    return {
      activeTurns: [...this.waiters.keys()],
      ownedTurns: [...this.daemonOwnedTurns.keys()],
      injectedEventIds: this.injectedEventIds.size,
    };
  }

  /** Test-only: drop all pending waiters (no resolution). Use to simulate
   *  daemon shutdown for cleanup tests. */
  destroyForTest(): void {
    for (const w of this.waiters.values()) clearTimeout(w.timer);
    this.waiters.clear();
    this.daemonOwnedTurns.clear();
  }

  private rememberOwnedTurn(turnId: string): void {
    const now = this.now();
    this.pruneOwnedTurns(now);
    this.daemonOwnedTurns.set(turnId, now + this.ownedTurnTtlMs);
    while (this.daemonOwnedTurns.size > this.ownedTurnMaxEntries) {
      const oldest = this.daemonOwnedTurns.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.daemonOwnedTurns.delete(oldest);
    }
  }

  private pruneOwnedTurns(now: number): void {
    for (const [turnId, expiresAt] of this.daemonOwnedTurns) {
      if (expiresAt <= now) this.daemonOwnedTurns.delete(turnId);
    }
  }
}

// ===== Headless server→client request policy =====
// codex app-server sends JSON-RPC REQUESTS to its client (approval
// elicitations, exec approvals, permission grants) and BLOCKS the turn until
// answered. A headless daemon has no human to ask, so every request must get
// a deterministic answer — silence hangs the turn for the full tracker
// timeout and the event is lost (2026-07-15 incident: codex 0.144 update
// made every event turn dead at the first approval-gated hive tool call).
//
// Pure function so the policy is unit-testable; codex-channel.ts just sends
// whatever this returns.

export type ServerRequestAnswer =
  | { kind: 'result'; payload: unknown }
  | { kind: 'error'; payload: { code: number; message: string } }
  // Deliberately stay silent: the request belongs to a turn some OTHER
  // client started (a human pane attached to the same app-server). Answering
  // would hijack their approval dialog — real incident 2026-07-16: the
  // daemon auto-declined every shell approval of a user actively working in
  // the monkeys-cli pane, making the session unusable.
  | { kind: 'ignore'; reason: string };

/** Best-effort form fill for approval elicitations we ACCEPT: prefer the
 *  affirmative enum option per field; persist choices prefer 'session' (never
 *  'always' — a headless daemon must not permanently rewrite user config). */
export function synthesizeElicitationContent(schema: unknown): Record<string, unknown> {
  const props = (schema as any)?.properties;
  if (!props || typeof props !== 'object') return {};
  const PRIORITY = ['approve', 'accept', 'allow', 'yes', 'session', 'true'];
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries<any>(props)) {
    if (Array.isArray(spec?.enum) && spec.enum.length > 0) {
      const pick = PRIORITY.map(pref => spec.enum.find((e: any) => String(e).toLowerCase() === pref)).find(v => v !== undefined);
      out[key] = pick ?? spec.enum[0];
    } else if (spec?.type === 'boolean') {
      out[key] = true;
    } else if (spec?.default !== undefined) {
      out[key] = spec.default;
    } else if (spec?.type === 'number' || spec?.type === 'integer') {
      out[key] = 0;
    } else {
      out[key] = 'approve';
    }
  }
  return out;
}

/** Decide the answer for a server→client request.
 *
 *  Turn OWNERSHIP is the first gate. The daemon shares its codex app-server
 *  (and often the very thread) with human panes attached via
 *  `codex resume <thread> --remote <ws_url>`; approval requests reach every
 *  connected client. The daemon may only answer requests for turns IT
 *  started (`isOwnTurn(turnId)` — the TurnTracker's active-waiter set).
 *  Requests for other turns are the attached human's to answer.
 *
 *  Policy for OWN turns (headless, nobody to ask):
 *   - hive MCP elicitations → accept (spawn-time approval_mode=auto
 *     overrides should prevent these entirely; net under the net)
 *   - everything else → decline/refuse. Failing one tool call lets the turn
 *     FINISH; a headless daemon must never self-grant shell or fs access.
 *
 *  Exception: hive elicitations are accepted regardless of ownership — hive
 *  is OUR server, the spawn overrides already made its tools auto on this
 *  app-server, and accepting is what the pane user wants ~always (identity
 *  bind, dm read...). Everything non-hive without proven ownership is left
 *  alone. */
export function answerServerRequest(method: string, params: any, isOwnTurn: (turnId: string | undefined) => boolean): ServerRequestAnswer {
  const p = params ?? {};
  const turnId: string | undefined = p.turnId ?? p.turn_id ?? undefined;
  if (method === 'mcpServer/elicitation/request') {
    if (p.serverName === 'hive') {
      return { kind: 'result', payload: { action: 'accept', content: synthesizeElicitationContent(p.requestedSchema) } };
    }
    if (!isOwnTurn(turnId)) return { kind: 'ignore', reason: `turn ${turnId ?? '(none)'} not started by daemon — leaving for attached client` };
    return { kind: 'result', payload: { action: 'decline', content: null } };
  }
  if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval' || method === 'applyPatchApproval') {
    if (!isOwnTurn(turnId)) return { kind: 'ignore', reason: `turn ${turnId ?? '(none)'} not started by daemon — leaving for attached client` };
    return { kind: 'result', payload: { decision: 'decline' } };
  }
  if (method === 'item/permissions/requestApproval') {
    if (!isOwnTurn(turnId)) return { kind: 'ignore', reason: `turn ${turnId ?? '(none)'} not started by daemon — leaving for attached client` };
    return { kind: 'result', payload: { scope: 'turn', permissions: {} } };
  }
  // Unknown request types: only answer (with an error, to unblock the await)
  // when the turn is provably ours; otherwise stay out of the way.
  if (!isOwnTurn(turnId)) return { kind: 'ignore', reason: `unknown method ${method}, turn ${turnId ?? '(none)'} not ours` };
  return { kind: 'error', payload: { code: -32601, message: `codex-channel daemon cannot handle ${method} (headless)` } };
}
