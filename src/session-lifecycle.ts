export const SESSION_DISCONNECT_GRACE_MS = 30_000;

interface ReaperClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: ReaperClock = {
  setTimeout(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/**
 * Keeps a disconnected stateful MCP session alive briefly so a Streamable
 * HTTP client can reconnect its GET stream. If it does not reconnect, the
 * owner callback releases the transport and server references.
 *
 * Stream and request tokens make close handling idempotent and prevent an old
 * response's `close` event from retiring a newer connection for the same
 * session.
 */
export class DisconnectedSessionReaper {
  private readonly streams = new Map<string, Set<symbol>>();
  private readonly requests = new Map<string, Set<symbol>>();
  private readonly disconnected = new Set<string>();
  private readonly pending = new Map<string, unknown>();

  constructor(
    private readonly activeSSE: Set<string>,
    private readonly onExpire: (sessionId: string) => void | Promise<void>,
    private readonly graceMs = SESSION_DISCONNECT_GRACE_MS,
    private readonly onError: (error: unknown) => void = () => {},
    private readonly clock: ReaperClock = systemClock,
  ) {}

  openStream(sessionId: string): symbol {
    const token = Symbol(sessionId);
    let streams = this.streams.get(sessionId);
    if (!streams) {
      streams = new Set();
      this.streams.set(sessionId, streams);
    }
    streams.add(token);
    this.disconnected.delete(sessionId);
    this.cancelPending(sessionId);
    this.activeSSE.add(sessionId);
    return token;
  }

  closeStream(sessionId: string, token: symbol): void {
    const streams = this.streams.get(sessionId);
    if (!streams?.delete(token)) return;
    if (streams.size > 0) return;

    this.streams.delete(sessionId);
    this.activeSSE.delete(sessionId);
    this.disconnected.add(sessionId);
    this.scheduleIfIdle(sessionId);
  }

  beginRequest(sessionId: string): symbol {
    const token = Symbol(sessionId);
    let requests = this.requests.get(sessionId);
    if (!requests) {
      requests = new Set();
      this.requests.set(sessionId, requests);
    }
    requests.add(token);
    if (this.disconnected.has(sessionId)) this.cancelPending(sessionId);
    return token;
  }

  endRequest(sessionId: string, token: symbol): void {
    const requests = this.requests.get(sessionId);
    if (!requests?.delete(token)) return;
    if (requests.size === 0) this.requests.delete(sessionId);
    this.scheduleIfIdle(sessionId);
  }

  clear(sessionId: string): void {
    this.cancelPending(sessionId);
    this.streams.delete(sessionId);
    this.requests.delete(sessionId);
    this.disconnected.delete(sessionId);
    this.activeSSE.delete(sessionId);
  }

  private scheduleIfIdle(sessionId: string): void {
    if (!this.disconnected.has(sessionId)) return;
    if ((this.streams.get(sessionId)?.size ?? 0) > 0) return;
    if ((this.requests.get(sessionId)?.size ?? 0) > 0) return;

    this.cancelPending(sessionId);
    const handle = this.clock.setTimeout(() => {
      if (this.pending.get(sessionId) !== handle) return;
      this.pending.delete(sessionId);
      if (!this.disconnected.has(sessionId)) return;
      this.clear(sessionId);
      try {
        Promise.resolve(this.onExpire(sessionId)).catch(this.onError);
      } catch (error) {
        this.onError(error);
      }
    }, this.graceMs);
    this.pending.set(sessionId, handle);
  }

  private cancelPending(sessionId: string): void {
    const handle = this.pending.get(sessionId);
    if (handle === undefined) return;
    this.clock.clearTimeout(handle);
    this.pending.delete(sessionId);
  }
}
