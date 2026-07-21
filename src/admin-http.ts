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
import { getPushDeliveryDecision } from './push-delivery.js';
import { getDaemonSnapshots, markDaemonReady, notifyAgentCreated, notifyAgentRemoved, requestDaemonRespawn, switchDaemonThread } from './codex-supervisor.js';
import {
  getOpenCodeDaemonForAgent,
  getOpenCodeDaemonSnapshots,
  markOpenCodeDaemonReady,
  notifyOpenCodeAgentCreated,
  notifyOpenCodeAgentRemoved,
  requestOpenCodeDaemonRespawn,
  switchOpenCodeSession,
} from './opencode-supervisor.js';

// Per-agent serialization for persistent conversation changes. Concurrent
// Codex respawns or OpenCode session switches must not race each other.
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

  // GET /admin/opencode-daemons — includes loopback attach credentials.
  if (url.pathname === '/admin/opencode-daemons' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ daemons: getOpenCodeDaemonSnapshots() }));
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
      // Reconcile both supervisors, not just spawn the requested one. This
      // endpoint is also used for tool morphs (codex <-> opencode): kill the
      // now-ineligible old daemon before ensuring the new one exists.
      const agent = db.getAgentById(agent_id);
      if (agent?.tool !== 'codex') notifyAgentRemoved(agent_id);
      if (agent?.tool !== 'opencode') notifyOpenCodeAgentRemoved(agent_id);
      const codex = agent?.tool === 'codex' ? notifyAgentCreated(agent_id) : false;
      const opencode = agent?.tool === 'opencode' ? notifyOpenCodeAgentCreated(agent_id) : false;
      const spawned = codex || opencode;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, spawned, supervisor: codex ? 'codex' : opencode ? 'opencode' : null }));
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
      const codex = notifyAgentRemoved(agent_id);
      const opencode = notifyOpenCodeAgentRemoved(agent_id);
      const killed = codex || opencode;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, killed, supervisor: codex ? 'codex' : opencode ? 'opencode' : null }));
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
      const { agent_id, ws_url, thread_id, control_url } = body;
      if (typeof agent_id !== 'string' || typeof ws_url !== 'string' || typeof thread_id !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'agent_id, ws_url, thread_id all required (strings)' }));
        return;
      }
      // control_url is optional (older daemons don't send it; a daemon whose
      // control server failed to start sends null).
      const controlUrl = typeof control_url === 'string' && control_url ? control_url : null;
      const ok = markDaemonReady(agent_id, ws_url, thread_id, controlUrl);
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

  // POST /admin/opencode-daemon-ready — bridge announces the authenticated
  // loopback server and the persistent session shared with `opencode attach`.
  if (url.pathname === '/admin/opencode-daemon-ready' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const {
        agent_id, server_url, session_id,
        server_username, server_password, control_url, version,
      } = body;
      if (
        typeof agent_id !== 'string' || typeof server_url !== 'string' ||
        typeof session_id !== 'string' || typeof server_username !== 'string' ||
        typeof server_password !== 'string'
      ) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'agent_id, server_url, session_id, server_username, server_password required (strings)' }));
        return;
      }
      const ok = markOpenCodeDaemonReady({
        agentId: agent_id,
        serverUrl: server_url,
        sessionId: session_id,
        serverUsername: server_username,
        serverPassword: server_password,
        controlUrl: typeof control_url === 'string' ? control_url : null,
        version: typeof version === 'string' ? version : null,
      });
      res.writeHead(ok ? 200 : 202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, tracked: ok }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message || err) }));
    }
    return;
  }

  // Read-only preflight used by channel daemons immediately before injecting
  // queued events. DM uses its per-sender cursor; task/team use stable stream
  // seq plus their read cursor. Task state hints are also suppressed when a
  // higher task seq already exists.
  if (
    [
      '/admin/push-delivery-status',
      '/admin/dm-delivery-status',
      '/admin/codex-dm-delivery-status',
      '/admin/opencode-dm-delivery-status',
    ].includes(url.pathname)
    && req.method === 'POST'
  ) {
    try {
      const body = JSON.parse(await readBody(req));
      const { agent_id, event_id, message_id, task_id, team_id } = body;
      const hasIdentity = typeof event_id === 'string'
        || (Number.isInteger(message_id) && message_id > 0)
        || typeof task_id === 'string'
        || typeof team_id === 'string';
      if (typeof agent_id !== 'string' || !agent_id || !hasIdentity) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'agent_id and event identity required' }));
        return;
      }
      const decision = getPushDeliveryDecision(agent_id, {
        event_id: typeof event_id === 'string' ? event_id : undefined,
        message_id: Number.isInteger(message_id) ? message_id : undefined,
        task_id: typeof task_id === 'string' ? task_id : undefined,
        team_id: typeof team_id === 'string' ? team_id : undefined,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(decision));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message || err) }));
    }
    return;
  }

  // POST /admin/daemon-respawn — force-refresh a supervised Codex/OpenCode
  // backend while preserving its current conversation identity. This is the
  // launcher-facing restart primitive: Kitty restarts only its visible attach
  // process, while Hive owns the daemon/app-server lifecycle and returns the
  // fresh coordinates after the replacement daemon reports ready.
  //
  // body: { agent_id: string }
  //
  // Success:
  // {
  //   ok: true, ready: true, mode: "respawn", tool, agent_id,
  //   conversation: { id, requested_id, preserved },
  //   daemon: { pid, uptime_ms, restart_count },
  //   attach: { kind, ...tool-specific coordinates }
  // }
  //
  // A non-empty pre-respawn conversation id is a hard preservation contract.
  // If the backend falls back to a fresh conversation, return HTTP 409 with
  // ok=false but include the recovered attach coordinates for diagnosis.
  if (url.pathname === '/admin/daemon-respawn' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const { agent_id } = body;
      if (typeof agent_id !== 'string' || !agent_id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'agent_id (string) required' }));
        return;
      }

      const agent = db.getAgentById(agent_id);
      if (!agent) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `agent not found: ${agent_id}` }));
        return;
      }
      if (agent.origin_peer !== '') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'cannot respawn a remote (federated) agent' }));
        return;
      }
      if (agent.tool !== 'codex' && agent.tool !== 'opencode') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `agent.tool="${agent.tool}" is not supervised` }));
        return;
      }

      const requestedConversationId = agent.thread_id || null;
      const result = await lockPerAgent(agent_id, async () => {
        log('info', `[admin] daemon-respawn agent=${agent_id.slice(-12)} tool=${agent.tool} preserve=${requestedConversationId || '(none)'}`);
        if (agent.tool === 'codex') {
          return { tool: 'codex' as const, snap: await requestDaemonRespawn(agent_id, 45_000) };
        }
        return { tool: 'opencode' as const, snap: await requestOpenCodeDaemonRespawn(agent_id, 45_000) };
      });
      if (!result.snap) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          ready: false,
          status: 'timeout',
          mode: 'respawn',
          agent_id,
          tool: agent.tool,
          conversation: {
            id: null,
            requested_id: requestedConversationId,
            preserved: null,
          },
          attach: null,
          error: 'replacement daemon did not become ready within 45s',
        }));
        return;
      }

      let conversationId: string | null;
      let attach: Record<string, unknown>;
      if (result.tool === 'codex') {
        conversationId = result.snap.thread_id;
        attach = {
          kind: 'codex-remote',
          ws_url: result.snap.ws_url,
          thread_id: result.snap.thread_id,
        };
      } else {
        conversationId = result.snap.session_id;
        attach = {
          kind: 'opencode-attach',
          server_url: result.snap.server_url,
          session_id: result.snap.session_id,
          server_username: result.snap.server_username,
          server_password: result.snap.server_password,
          version: result.snap.version,
        };
      }
      const preserved = requestedConversationId
        ? conversationId === requestedConversationId
        : null;
      const response = {
        ok: preserved !== false,
        ready: true,
        status: preserved === false ? 'conversation_changed' : 'ready',
        mode: 'respawn',
        agent_id,
        tool: agent.tool,
        conversation: {
          id: conversationId,
          requested_id: requestedConversationId,
          preserved,
        },
        daemon: {
          pid: result.snap.pid,
          uptime_ms: result.snap.uptime_ms,
          restart_count: result.snap.restart_count,
        },
        attach,
        ...(preserved === false
          ? { error: 'replacement daemon became ready on a different conversation id' }
          : {}),
      };
      res.writeHead(preserved === false ? 409 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
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
      // each other's switch / SIGTERM / respawn flow.
      const result = await lockPerAgent(agent_id, async () => {
        db.setAgentThreadId(agent_id, targetThreadId);
        log('info', `[admin] codex-set-thread agent=${agent_id.slice(-12)} → ${targetThreadId || '(reset)'}`);
        // Fast path: in-process switch on the live daemon (~1-2s, ws_url
        // stable). Falls back to the SIGTERM→respawn cycle when the daemon
        // has no control server (older daemon / control startup failure),
        // isn't ready, or the switch itself errors. The DB write above is
        // shared: the respawn path's fresh daemon reads agents.thread_id at
        // env-injection, and the in-process path passes the same target.
        const switched = await switchDaemonThread(agent_id, targetThreadId);
        if (switched) return { snap: switched, mode: 'in-process' as const };
        const snap = await requestDaemonRespawn(agent_id, 30_000);
        return { snap, mode: 'respawn' as const };
      });

      if (!result.snap) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          thread_id: targetThreadId || null,
          ws_url: null,
          ready: false,
          mode: result.mode,
          error: 'daemon did not become ready within 30s; poll hive_codex_pane_ws or GET /admin/codex-daemons',
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        thread_id: result.snap.thread_id,
        ws_url: result.snap.ws_url,
        ready: true,
        mode: result.mode,
      }));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message || err) }));
    }
    return;
  }

  // POST /admin/opencode-set-session
  // body: { agent_id, session_id: string | null }. null/"" creates a fresh
  // session. A live bridge switches in-process and asks attached TUIs to
  // select the new session; server_url stays stable.
  if (url.pathname === '/admin/opencode-set-session' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const { agent_id } = body;
      if (typeof agent_id !== 'string' || !agent_id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'agent_id (string) required' }));
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(body, 'session_id')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session_id required (pass null explicitly to create fresh)' }));
        return;
      }
      if (body.session_id !== null && typeof body.session_id !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session_id must be string or null' }));
        return;
      }
      const target = typeof body.session_id === 'string' && body.session_id.trim()
        ? body.session_id.trim()
        : null;
      if (target && !target.startsWith('ses')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'OpenCode session_id must start with "ses"' }));
        return;
      }
      const agent = db.getAgentById(agent_id);
      if (!agent) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `agent not found: ${agent_id}` }));
        return;
      }
      if (agent.tool !== 'opencode' || agent.origin_peer !== '') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `expected a local tool=opencode agent (got tool="${agent.tool}")` }));
        return;
      }

      const result = await lockPerAgent(agent_id, async () => {
        const live = getOpenCodeDaemonForAgent(agent_id);
        if (live?.ready && live.control_url) {
          const switched = await switchOpenCodeSession(agent_id, target);
          return { snap: switched, mode: 'in-process' as const, hadLiveControl: true };
        }
        db.setAgentThreadId(agent_id, target || '');
        const snap = await requestOpenCodeDaemonRespawn(agent_id);
        return { snap, mode: 'respawn' as const, hadLiveControl: false };
      });

      if (!result.snap) {
        res.writeHead(result.hadLiveControl ? 409 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          ready: false,
          mode: result.mode,
          error: result.hadLiveControl
            ? 'OpenCode session is busy or the requested session does not exist; current daemon was left untouched'
            : 'OpenCode daemon did not become ready within 45s',
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        ready: true,
        mode: result.mode,
        session_id: result.snap.session_id,
        server_url: result.snap.server_url,
        server_username: result.snap.server_username,
        server_password: result.snap.server_password,
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
