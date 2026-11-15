import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addTeamMember,
  closeTeam,
  createAgent,
  createTeam,
  hostsOpenTeamOfMember,
  initDB,
  listPendingPushes,
} from './db.js';
import { deliverWithFreshContext, type FreshContextDeps } from './fresh-context.js';
import { lookupKittyFreshContextResult, requestKittyFreshContext } from './kitty-wakeup.js';
import { beginPushHold, endPushHold, isPushHeld, notifyAgents } from './sessions.js';
import type { Agent } from './models.js';

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id, display_name: id, token: '', tool: 'claude', roles: '', expertise: '',
    status: 'idle', created_at: '', last_seen: '', origin_peer: '', remote_id: '',
    external_key: 'kitty-' + id, project_dir: '', thread_id: '', event_mode: 'auto',
    pool_enabled: 1, runtime_enabled: 1, parent_agent_id: '', runtime_scope: 'resident', runtime_ref: '',
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<FreshContextDeps> = {}) {
  const calls: string[] = [];
  let held = 0;
  const deps: FreshContextDeps = {
    isAuthorized: () => true,
    hasLivePush: () => true,
    request: async (key, input) => { calls.push(`request:${key}:${input.tool}:${input.requestId}`); return { kind: 'cleared' }; },
    lookup: async (_key, id) => { calls.push(`lookup:${id}`); return { kind: 'not_found' }; },
    beginHold: (id) => { held++; calls.push(`hold:${id}`); },
    endHold: (id) => { held--; calls.push(`release:${id}`); },
    waitForLivePush: async () => true,
    timeoutMs: () => 1000,
    newRequestId: () => 'req-1',
    ...overrides,
  };
  return { deps, calls, isHeld: () => held > 0 };
}

const host = agent('host');

test('authorization uses open teams hosted by the sender that contain the target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitty-hive-fresh-auth-'));
  initDB(join(dir, 'hive.db'));
  try {
    const h = createAgent('host', 'claude', '', '');
    const worker = createAgent('worker', 'claude', '', '');
    const outsider = createAgent('outsider', 'claude', '', '');
    const peer = createAgent('peer', 'claude', '', '');
    const team = createTeam('fresh-auth', h.id);
    addTeamMember(team.id, h.id);
    addTeamMember(team.id, worker.id);
    addTeamMember(team.id, peer.id);
    assert.equal(hostsOpenTeamOfMember(h.id, worker.id), true);
    assert.equal(hostsOpenTeamOfMember(peer.id, worker.id), false, 'members are not hosts');
    assert.equal(hostsOpenTeamOfMember(h.id, outsider.id), false, 'target outside the team');
    closeTeam(team.id);
    assert.equal(hostsOpenTeamOfMember(h.id, worker.id), false, 'closed teams grant nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preflight refusals never contact Kitty or deliver', async () => {
  const cases: Array<[string, Agent, Partial<FreshContextDeps>]> = [
    ['forbidden', agent('w1'), { isAuthorized: () => false }],
    ['unsupported_target', agent('w2', { origin_peer: 'alice' }), {}],
    ['unsupported_tool', agent('w3', { tool: 'opencode' }), {}],
    ['not_managed', agent('w4', { external_key: '' }), {}],
    ['not_running', agent('w5'), { hasLivePush: () => false }],
  ];
  for (const [reason, target, overrides] of cases) {
    const { deps, calls } = fakeDeps(overrides);
    let delivered = 0;
    const out = await deliverWithFreshContext(host, target, async () => { delivered++; }, deps);
    assert.equal(out.fresh.ok, false, reason);
    assert.equal(out.fresh.cleared, false, reason);
    assert.equal(out.fresh.reason, reason);
    assert.equal(delivered, 0, reason);
    assert.deepEqual(calls, [], reason);
  }
});

test('codex targets do not need a live push session before the clear', async () => {
  const { deps } = fakeDeps({ hasLivePush: () => false });
  const out = await deliverWithFreshContext(host, agent('cx', { tool: 'codex' }), async () => 'sent', deps);
  assert.equal(out.fresh.ok, true);
  assert.equal(out.delivered, 'sent');
});

test('confirmed clear delivers once while other pushes are held', async () => {
  const { deps, calls, isHeld } = fakeDeps({
    request: async () => ({ kind: 'cleared', newExternalId: 'new-claude-session' }),
  });
  let heldDuringDelivery = false;
  const out = await deliverWithFreshContext(host, agent('w'), async () => {
    heldDuringDelivery = isHeld();
    return 42;
  }, deps);
  assert.deepEqual(out.fresh, { request_id: 'req-1', tool: 'claude', ok: true, cleared: true, new_external_id: 'new-claude-session' });
  assert.equal(out.delivered, 42);
  assert.equal(heldDuringDelivery, true);
  assert.equal(isHeld(), false);
  assert.deepEqual(calls, ['hold:w', 'release:w']);
});

test('Kitty rejection passes its reason through and releases the hold', async () => {
  const { deps, isHeld } = fakeDeps({ request: async () => ({ kind: 'rejected', reason: 'draft' }) });
  let delivered = 0;
  const out = await deliverWithFreshContext(host, agent('w'), async () => { delivered++; }, deps);
  assert.equal(out.fresh.ok, false);
  assert.equal(out.fresh.cleared, false);
  assert.equal(out.fresh.reason, 'draft');
  assert.equal(delivered, 0);
  assert.equal(isHeld(), false);
});

test('a missing Kitty socket is a definite failure without a result lookup', async () => {
  const { deps, calls } = fakeDeps({ request: async () => ({ kind: 'unavailable', reason: 'connect ENOENT /x/wakeup.sock' }) });
  const out = await deliverWithFreshContext(host, agent('w'), async () => 1, deps);
  assert.equal(out.fresh.cleared, false);
  assert.equal(out.fresh.reason, 'kitty_unavailable');
  assert.equal(calls.some(c => c.startsWith('lookup:')), false);
});

test('timeout is resolved through the recorded Kitty result', async () => {
  const timeout = async () => ({ kind: 'timeout' as const, reason: 'timeout after 1000ms' });

  const late = fakeDeps({ request: timeout, lookup: async () => ({ kind: 'found', cleared: true }) });
  const delivered = await deliverWithFreshContext(host, agent('w'), async () => 'sent', late.deps);
  assert.equal(delivered.fresh.ok, true);
  assert.equal(delivered.fresh.late, true);
  assert.equal(delivered.delivered, 'sent');

  const failed = fakeDeps({ request: timeout, lookup: async () => ({ kind: 'found', cleared: false, reason: 'busy' }) });
  const refused = await deliverWithFreshContext(host, agent('w'), async () => 'sent', failed.deps);
  assert.deepEqual([refused.fresh.cleared, refused.fresh.reason, refused.delivered], [false, 'busy', undefined]);

  const unknown = fakeDeps({ request: timeout });
  const uncertain = await deliverWithFreshContext(host, agent('w'), async () => 'sent', unknown.deps);
  assert.equal(uncertain.fresh.ok, false);
  assert.equal(uncertain.fresh.cleared, 'unknown');
  assert.equal(uncertain.fresh.reason, 'timeout');
  assert.equal(uncertain.fresh.request_id, 'req-1');
  assert.equal(uncertain.delivered, undefined);
});

test('a second fresh request for the same target is refused while one is in flight', async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const slow = fakeDeps({ request: async () => { await gate; return { kind: 'cleared' }; } });
  const first = deliverWithFreshContext(host, agent('same'), async () => 'first', slow.deps);
  const second = await deliverWithFreshContext(host, agent('same'), async () => 'second', fakeDeps().deps);
  assert.equal(second.fresh.reason, 'busy');
  release();
  assert.equal((await first).delivered, 'first');
});

test('held pushes are persisted instead of sent until the hold ends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitty-hive-fresh-hold-'));
  initDB(join(dir, 'hive.db'));
  try {
    const worker = createAgent('worker', 'claude', '', '');
    beginPushHold(worker.id);
    assert.equal(isPushHeld(worker.id), true);
    await notifyAgents([worker.id], undefined, JSON.stringify({ type: 'dm', event_id: 'dm:999' }));
    assert.equal(listPendingPushes(worker.id).length, 1);
    endPushHold(worker.id);
    assert.equal(isPushHeld(worker.id), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ----- Kitty socket client -----

async function withKittySocket(
  handler: (req: IncomingMessage, body: string) => { status: number; body?: unknown; hang?: boolean },
  run: (socketPath: string) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), 'khfc-'));
  const socketPath = join(dir, 's.sock');
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const out = handler(req, Buffer.concat(chunks).toString());
      if (out.hang) return;
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(out.body === undefined ? '' : JSON.stringify(out.body));
    });
  });
  await new Promise<void>(r => server.listen(socketPath, r));
  try {
    await run(socketPath);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
}

test('fresh-context request uses the agreed Kitty contract', async () => {
  let seen: { method?: string; url?: string; session?: string; body?: unknown } = {};
  await withKittySocket((req, body) => {
    seen = { method: req.method, url: req.url, session: String(req.headers['x-kitty-session']), body: JSON.parse(body) };
    return { status: 200, body: { ok: true, tool: 'claude', new_external_id: 'claude-2' } };
  }, async (socketPath) => {
    const res = await requestKittyFreshContext('kitty-1', { agentId: 'a1', tool: 'claude', requestId: 'r1' }, { socketPath });
    assert.deepEqual(res, { kind: 'cleared', newExternalId: 'claude-2' });
  });
  assert.deepEqual(seen, {
    method: 'POST', url: '/fresh-context', session: 'kitty-1',
    body: { agent_id: 'a1', tool: 'claude', request_id: 'r1' },
  });
});

test('fresh-context request maps rejection, missing endpoint and timeout', async () => {
  await withKittySocket(() => ({ status: 409, body: { ok: false, reason: 'busy' } }), async (socketPath) => {
    assert.deepEqual(
      await requestKittyFreshContext('k', { agentId: 'a', tool: 'codex', requestId: 'r' }, { socketPath }),
      { kind: 'rejected', reason: 'busy' },
    );
  });
  await withKittySocket(() => ({ status: 404 }), async (socketPath) => {
    const res = await requestKittyFreshContext('k', { agentId: 'a', tool: 'codex', requestId: 'r' }, { socketPath });
    assert.equal(res.kind, 'unavailable');
  });
  await withKittySocket(() => ({ status: 200, hang: true }), async (socketPath) => {
    const res = await requestKittyFreshContext('k', { agentId: 'a', tool: 'codex', requestId: 'r' }, { socketPath, timeoutMs: 50 });
    assert.equal(res.kind, 'timeout');
  });
});

test('fresh-context result lookup parses found / not found records', async () => {
  let url = '';
  await withKittySocket((req) => {
    url = String(req.url);
    return { status: 200, body: { found: true, cleared: false, reason: 'draft' } };
  }, async (socketPath) => {
    assert.deepEqual(
      await lookupKittyFreshContextResult('k', 'r 1', { socketPath }),
      { kind: 'found', cleared: false, reason: 'draft' },
    );
  });
  assert.equal(url, '/fresh-context/result?request_id=r%201');
  await withKittySocket(() => ({ status: 200, body: { found: false } }), async (socketPath) => {
    assert.deepEqual(await lookupKittyFreshContextResult('k', 'r', { socketPath }), { kind: 'not_found' });
  });
});
