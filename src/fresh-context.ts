import { randomUUID } from 'node:crypto';
import * as db from './db.js';
import { log } from './log.js';
import type { Agent } from './models.js';
import {
  lookupKittyFreshContextResult,
  requestKittyFreshContext,
  type KittyFreshContextLookup,
  type KittyFreshContextRequest,
  type KittyFreshContextResult,
  type KittyWakeupOptions,
} from './kitty-wakeup.js';
import { beginPushHold, endPushHold, livePushSessionsForAgent } from './sessions.js';

/**
 * GX-89: a team host may ask Hive to clear a Kitty-managed worker's
 * conversation before delivering a DM. Hive authorizes, holds other pushes,
 * asks Kitty to clear, and delivers only after Kitty confirms the clear.
 */

export const FRESH_CONTEXT_TOOLS = ['claude', 'codex'] as const;

/** Upper bound for Kitty's own work (claude ~15s, codex daemon respawn ~35s)
 *  plus slack, so Hive does not give up before Kitty does. */
const DEFAULT_TIMEOUT_MS: Record<string, number> = { claude: 20_000, codex: 40_000 };

export interface FreshContextOutcome {
  ok: boolean;
  /** 'unknown' only when Kitty may have cleared but never confirmed. */
  cleared: boolean | 'unknown';
  reason?: string;
  detail?: string;
  request_id: string;
  tool: string;
  new_external_id?: string;
  /** Kitty's response timed out but its recorded result confirmed the clear. */
  late?: boolean;
}

export interface FreshContextDeps {
  isAuthorized(actorId: string, targetId: string): boolean;
  hasLivePush(agentId: string): boolean;
  request(externalKey: string, input: KittyFreshContextRequest, opts: KittyWakeupOptions): Promise<KittyFreshContextResult>;
  lookup(externalKey: string, requestId: string, opts?: KittyWakeupOptions): Promise<KittyFreshContextLookup>;
  beginHold(agentId: string): void;
  endHold(agentId: string): void;
  waitForLivePush(agentId: string, timeoutMs: number): Promise<boolean>;
  timeoutMs(tool: string): number;
  newRequestId(): string;
}

async function waitForLivePush(agentId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (livePushSessionsForAgent(agentId).length === 0) {
    if (Date.now() >= deadline) return false;
    await new Promise(r => setTimeout(r, 200));
  }
  return true;
}

export const defaultFreshContextDeps: FreshContextDeps = {
  isAuthorized: db.hostsOpenTeamOfMember,
  hasLivePush: (agentId) => livePushSessionsForAgent(agentId).length > 0,
  request: requestKittyFreshContext,
  lookup: lookupKittyFreshContextResult,
  beginHold: beginPushHold,
  endHold: endPushHold,
  waitForLivePush,
  timeoutMs: (tool) => {
    const override = Number(process.env.HIVE_FRESH_CONTEXT_TIMEOUT_MS);
    if (Number.isFinite(override) && override > 0) return override;
    return DEFAULT_TIMEOUT_MS[tool] ?? 20_000;
  },
  newRequestId: () => randomUUID(),
};

const inFlight = new Set<string>();

/** Hive-side refusal reason, or null when Kitty may be asked to clear. */
export function preflightFreshContext(actor: Agent, target: Agent, deps: FreshContextDeps): string | null {
  if (target.origin_peer) return 'unsupported_target';
  if (!deps.isAuthorized(actor.id, target.id)) return 'forbidden';
  if (!(FRESH_CONTEXT_TOOLS as readonly string[]).includes(target.tool)) return 'unsupported_tool';
  if (!target.external_key) return 'not_managed';
  // Claude only receives pushes through its live channel. Without one the DM
  // would sit in the pending queue and the clear would be pointless.
  if (target.tool === 'claude' && !deps.hasLivePush(target.id)) return 'not_running';
  if (inFlight.has(target.id)) return 'busy';
  return null;
}

/** Connection failures where Kitty cannot have received the request. */
function requestNeverArrived(reason: string): boolean {
  return /ENOENT|ECONNREFUSED|missing external key|does not support/i.test(reason);
}

async function resolveUncertain(
  target: Agent,
  base: Pick<FreshContextOutcome, 'request_id' | 'tool'>,
  failure: string,
  deps: FreshContextDeps,
): Promise<FreshContextOutcome> {
  const lookup = await deps.lookup(target.external_key, base.request_id);
  if (lookup.kind === 'found' && lookup.cleared) {
    return {
      ...base,
      ok: true,
      cleared: true,
      late: true,
      ...(lookup.newExternalId ? { new_external_id: lookup.newExternalId } : {}),
    };
  }
  if (lookup.kind === 'found') {
    return { ...base, ok: false, cleared: false, reason: lookup.reason || 'clear_failed' };
  }
  return {
    ...base,
    ok: false,
    cleared: 'unknown',
    reason: 'timeout',
    detail: lookup.kind === 'unavailable' ? `${failure}; result lookup: ${lookup.reason}` : `${failure}; result lookup: not found`,
  };
}

export async function deliverWithFreshContext<T>(
  actor: Agent,
  target: Agent,
  deliver: () => Promise<T>,
  deps: FreshContextDeps = defaultFreshContextDeps,
): Promise<{ fresh: FreshContextOutcome; delivered?: T }> {
  const base = { request_id: deps.newRequestId(), tool: target.tool };
  const refusal = preflightFreshContext(actor, target, deps);
  if (refusal) return { fresh: { ...base, ok: false, cleared: false, reason: refusal } };

  inFlight.add(target.id);
  deps.beginHold(target.id);
  try {
    log('info', `[fresh-context] actor=${actor.id} target=${target.id} tool=${target.tool} request=${base.request_id}`);
    const res = await deps.request(
      target.external_key,
      { agentId: target.id, tool: target.tool, requestId: base.request_id },
      { timeoutMs: deps.timeoutMs(target.tool) },
    );
    let fresh: FreshContextOutcome;
    if (res.kind === 'cleared') {
      fresh = { ...base, ok: true, cleared: true, ...(res.newExternalId ? { new_external_id: res.newExternalId } : {}) };
    } else if (res.kind === 'rejected') {
      fresh = { ...base, ok: false, cleared: false, reason: res.reason };
    } else if (res.kind === 'unavailable' && requestNeverArrived(res.reason)) {
      fresh = { ...base, ok: false, cleared: false, reason: 'kitty_unavailable', detail: res.reason };
    } else {
      fresh = await resolveUncertain(target, base, res.reason, deps);
    }
    log('info', `[fresh-context] request=${base.request_id} ok=${fresh.ok} cleared=${fresh.cleared}${fresh.reason ? ` reason=${fresh.reason}` : ''}`);
    if (!fresh.ok) return { fresh };

    // A respawned Codex daemon may still be reconnecting its event stream.
    // Wait briefly so the DM goes live instead of queueing behind held pushes.
    if (target.tool === 'codex') await deps.waitForLivePush(target.id, 10_000);
    const delivered = await deliver();
    return { fresh, delivered };
  } finally {
    deps.endHold(target.id);
    inFlight.delete(target.id);
  }
}
