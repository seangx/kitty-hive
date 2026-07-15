/**
 * codex-channel-runtime — the testable core of codex-channel.ts.
 *
 * Encapsulates everything that talks to a codex app-server's JSON-RPC v2
 * protocol (https://github.com/openai/codex 0.124+): issuing `turn/start`,
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

export interface TurnTrackerOptions {
  /** How long to wait for `turn/completed` after `turn/start` succeeds.
   *  Default 10 min — matches codex's typical long-running turn budget. */
  turnTimeoutMs?: number;
  /** Hook for tests / observability. Called once per terminal outcome. */
  onOutcome?: (outcome: TurnOutcome, eventId?: string) => void;
}

export class TurnTracker {
  private waiters = new Map<string, Waiter>();
  private injectedEventIds = new Set<string>();
  private readonly turnTimeoutMs: number;
  private readonly onOutcome?: TurnTrackerOptions['onOutcome'];

  constructor(
    private readonly transport: RpcTransport,
    private threadId: string,
    opts: TurnTrackerOptions = {},
  ) {
    this.turnTimeoutMs = opts.turnTimeoutMs ?? 600_000;
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

  /** Diagnostic snapshot of in-flight turns. Not used at runtime; exposed
   *  for the optional `/admin/codex-daemons` extension and tests. */
  snapshot(): { activeTurns: string[]; injectedEventIds: number } {
    return {
      activeTurns: [...this.waiters.keys()],
      injectedEventIds: this.injectedEventIds.size,
    };
  }

  /** Test-only: drop all pending waiters (no resolution). Use to simulate
   *  daemon shutdown for cleanup tests. */
  destroyForTest(): void {
    for (const w of this.waiters.values()) clearTimeout(w.timer);
    this.waiters.clear();
  }
}
