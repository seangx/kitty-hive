/**
 * Local-only admin HTTP endpoints. Used by helper processes (e.g. `kitty-hive tunnel start`)
 * to push runtime state into the running hive without needing peer credentials.
 *
 * Auth: only accept connections from 127.0.0.1 / ::1 / ::ffff:127.0.0.1 (loopback).
 */

import { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import * as db from './db.js';
import { log } from './log.js';
import { getDaemonSnapshots, markDaemonReady, notifyAgentCreated, notifyAgentRemoved, requestDaemonRespawn } from './codex-supervisor.js';

// Per-agent serialization for /admin/codex-set-thread. Two concurrent
// callers must not both SIGTERM the daemon — the second would race against
// the supervisor's respawn from the first. A simple promise-chain per
// agent_id is enough; calls await the previous chain head before starting.
const setThreadLocks = new Map<string, Promise<unknown>>();
function lockPerAgent<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const prev = setThreadLocks.get(agentId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  setThreadLocks.set(agentId, next);
  // Cleanup map entry once this call settles AND no later call has chained
  // onto it (we re-check identity before deleting).
  next.finally(() => {
    if (setThreadLocks.get(agentId) === next) setThreadLocks.delete(agentId);
  });
  return next;
}

/** Locate the codex rollout jsonl for a given thread_id. Codex stores them
 *  under `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl`. We
 *  don't know the date directory, so this walks `~/.codex/sessions/` looking
 *  for any file whose name ends in `-<thread_id>.jsonl`. Returns true if
 *  found. Used to validate set_thread requests so callers can't pin to a
 *  non-existent thread (which would otherwise fall through to thread/start
 *  and silently overwrite the intended thread_id). */
function codexRolloutExists(threadId: string): boolean {
  const base = join(homedir(), '.codex', 'sessions');
  if (!existsSync(base)) return false;
  const needle = `-${threadId}.jsonl`;
  function scan(dir: string): boolean {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return false; }
    for (const e of entries) {
      const full = join(dir, e);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (scan(full)) return true;
      } else if (e.endsWith(needle)) {
        return true;
      }
    }
    return false;
  }
  return scan(base);
}

function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

export async function broadcastUrlChange(newUrl: string): Promise<{ ok: number; fail: number }> {
  const peers = db.listPeers();
  let ok = 0, fail = 0;
  await Promise.all(peers.map(async p => {
    try {
      const r = await fetch(p.url.replace('/mcp', '/federation/update-url'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${p.secret}`,
        },
        body: JSON.stringify({ url: newUrl }),
      });
      if (r.ok) ok++; else fail++;
    } catch { fail++; }
  }));
  return { ok, fail };
}

export async function handleAdmin(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (!isLoopback(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Admin endpoints are loopback-only' }));
    return;
  }

  // POST /admin/tunnel-url — set/clear the current public URL and broadcast to peers
  if (url.pathname === '/admin/tunnel-url' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const newUrl: string = (body.url || '').trim();
    if (newUrl && !/^https?:\/\//i.test(newUrl)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid url' }));
      return;
    }
    const previous = db.getNodeState('public_url') || '';
    if (newUrl) {
      db.setNodeState('public_url', newUrl);
    } else {
      db.deleteNodeState('public_url');
    }
    let broadcast = { ok: 0, fail: 0 };
    if (newUrl && newUrl !== previous) {
      broadcast = await broadcastUrlChange(newUrl);
      log('info', `[admin] tunnel url → ${newUrl} (broadcast ok=${broadcast.ok} fail=${broadcast.fail})`);
    } else if (!newUrl && previous) {
      log('info', `[admin] tunnel url cleared (was ${previous})`);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, previous, current: newUrl, broadcast }));
    return;
  }

  // GET /admin/tunnel-url — query current public URL
  if (url.pathname === '/admin/tunnel-url' && req.method === 'GET') {
    const url = db.getNodeState('public_url') || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url }));
    return;
  }

  // GET /admin/codex-daemons — snapshot of the codex daemon supervisor
  if (url.pathname === '/admin/codex-daemons' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ daemons: getDaemonSnapshots() }));
    return;
  }

  // POST /admin/notify-agent-created — the CLI `agent register` calls this
  // after it writes a new agent row, so the codex-supervisor (in serve's
  // process) can dynamically spawn a daemon for new tool=codex agents without
  // requiring a serve restart. The in-process onAgentCreated hook only fires
  // when register goes through the live serve via MCP; this endpoint bridges
  // the CLI-direct-DB-write path.
  if (url.pathname === '/admin/notify-agent-created' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const { agent_id } = body;
      if (typeof agent_id !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'agent_id (string) required' }));
        return;
      }
      const spawned = notifyAgentCreated(agent_id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, spawned }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message || err) }));
    }
    return;
  }

  // POST /admin/notify-agent-removed — the CLI `agent remove` calls this
  // after deleting an agent row so the codex-supervisor can kill the daemon
  // (and its codex app-server + ws) right away. Without this, a removed
  // agent leaves a ghost daemon running on the old ws_url, causing routing
  // schisms when a new agent later self-registers with the same name. See
  // Bug 1 reported on 2026-05-20.
  if (url.pathname === '/admin/notify-agent-removed' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const { agent_id } = body;
      if (typeof agent_id !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'agent_id (string) required' }));
        return;
      }
      const killed = notifyAgentRemoved(agent_id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, killed }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message || err) }));
    }
    return;
  }

  // POST /admin/codex-daemon-ready — daemon announces (ws_url, thread_id) after
  // its codex app-server is up. Lets external callers (kitty-kitty) discover
  // where to point `codex --remote` to see the same thread the daemon is
  // injecting into.
  if (url.pathname === '/admin/codex-daemon-ready' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const { agent_id, ws_url, thread_id } = body;
      if (typeof agent_id !== 'string' || typeof ws_url !== 'string' || typeof thread_id !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'agent_id, ws_url, thread_id all required (strings)' }));
        return;
      }
      const ok = markDaemonReady(agent_id, ws_url, thread_id);
      if (!ok) {
        // Daemon wasn't in the supervisor's map — could be a manually-started
        // codex-channel (not via supervisor). Accept the POST silently with a
        // soft warning; admin endpoint is loopback-only so it's safe.
        log('warn', `[admin] codex-daemon-ready for unknown agent_id=${agent_id}; not tracked by supervisor`);
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, tracked: false }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, tracked: true }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message || err) }));
    }
    return;
  }

  // POST /admin/codex-set-thread — switch the daemon for a codex agent to a
  // specific thread (resume) or to a fresh thread (reset).
  //
  // body: { agent_id: string, thread_id: string | null }
  //   thread_id non-empty string → resume that thread. jsonl must exist on
  //                                 disk in ~/.codex/sessions/.
  //   thread_id === null or "" → reset: clear agents.thread_id and let the
  //                                 daemon thread/start a new thread.
  //   thread_id field missing → 400 (use null explicitly to reset; prevents
  //                                 accidental reset from a serialization bug).
  //
  // Implementation:
  //   1. UPDATE agents.thread_id (or '' for reset)
  //   2. SIGTERM existing daemon (supervisor auto-respawns) OR spawn fresh if
  //      none exists. requestDaemonRespawn() handles both.
  //   3. Wait up to 30s for the new daemon to report ready (which means it
  //      successfully resumed/started a thread and POSTed to
  //      /admin/codex-daemon-ready).
  //
  // Returns: { ok, thread_id, ws_url, ready, error? }
  //   thread_id is the ACTUAL one the new daemon now holds (matches the
  //   request on resume; on reset it's the codex-assigned new id).
  //   ws_url is the new daemon's ws://127.0.0.1:<port>; differs from any
  //   previous value if the daemon respawned with a new free port.
  //
  // Use cases (kitty UI):
  //   - User picks a historical thread from a session picker → resume
  //   - User clicks "🆕 new conversation" → reset
  //
  // Serialized per agent_id so two concurrent callers can't race the
  // SIGTERM/respawn flow.
  if (url.pathname === '/admin/codex-set-thread' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const { agent_id } = body;
      if (typeof agent_id !== 'string' || !agent_id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'agent_id (string) required' }));
        return;
      }
      // thread_id MUST be present. Accept string | null. A missing field is
      // a 400 — never want a JSON-serialization bug (e.g. undefined dropped
      // by JSON.stringify) to silently nuke an agent's thread.
      if (!('thread_id' in body)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'thread_id required (pass null explicitly to reset)' }));
        return;
      }
      const rawThreadId = body.thread_id;
      if (rawThreadId !== null && typeof rawThreadId !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'thread_id must be string or null' }));
        return;
      }
      const targetThreadId = (rawThreadId ?? '').trim();  // '' means reset

      const agent = db.getAgentById(agent_id);
      if (!agent) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `agent not found: ${agent_id}` }));
        return;
      }
      if (agent.tool !== 'codex') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `agent.tool="${agent.tool}", expected "codex"` }));
        return;
      }
      if (agent.origin_peer !== '') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'cannot set thread for a remote (federated) agent' }));
        return;
      }
      // For resume: verify the jsonl exists. If we just blindly trust the
      // caller and the file is missing, the daemon's thread/resume will
      // fail and fall back to thread/start — overwriting the intended
      // thread_id with a fresh one (and from the caller's perspective the
      // pin silently failed).
      if (targetThreadId && !codexRolloutExists(targetThreadId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: `no codex rollout jsonl found for thread_id=${targetThreadId} under ~/.codex/sessions/`,
        }));
        return;
      }

      // Serialize per-agent so concurrent set_thread calls don't trample
      // each other's SIGTERM / respawn flow.
      const result = await lockPerAgent(agent_id, async () => {
        db.setAgentThreadId(agent_id, targetThreadId);
        log('info', `[admin] codex-set-thread agent=${agent_id.slice(-12)} → ${targetThreadId || '(reset)'}`);
        const snap = await requestDaemonRespawn(agent_id, 30_000);
        return snap;
      });

      if (!result) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          thread_id: targetThreadId || null,
          ws_url: null,
          ready: false,
          error: 'daemon did not become ready within 30s; poll hive_codex_pane_ws or GET /admin/codex-daemons',
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        thread_id: result.thread_id,
        ws_url: result.ws_url,
        ready: true,
      }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message || err) }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unknown admin endpoint' }));
}
