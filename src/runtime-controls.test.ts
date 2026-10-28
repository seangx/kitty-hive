import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { handleAdmin, type AgentRuntimeControls } from './admin-http.js';
import { createAgent, getAgentById, initDB } from './db.js';
import type { Agent } from './models.js';

const cli = fileURLToPath(new URL('./index.js', import.meta.url));

function makeAgent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    display_name: id,
    token: '',
    tool: 'codex',
    roles: '',
    expertise: '',
    status: 'idle',
    created_at: '',
    last_seen: '',
    origin_peer: '',
    remote_id: '',
    external_key: '',
    project_dir: '',
    thread_id: '',
    event_mode: 'auto',
    pool_enabled: 1,
    runtime_enabled: 1,
    parent_agent_id: '',
    runtime_scope: 'resident',
    runtime_ref: '',
    ...overrides,
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

async function close(server: Server): Promise<void> {
  server.closeIdleConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function adminServer(controls: AgentRuntimeControls): Server {
  return createServer((req, res) => {
    void handleAdmin(req, res, new URL(req.url || '/', 'http://127.0.0.1'), controls).catch(error => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(error) }));
    });
  });
}

async function runtimeRequest(port: number, agentId: string, action: unknown) {
  const response = await fetch(`http://127.0.0.1:${port}/admin/agents/${encodeURIComponent(agentId)}/runtime`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

test('runtime admin remains loopback-only before resolving or controlling an agent', async () => {
  let status = 0;
  let body = '';
  const req = { socket: { remoteAddress: '192.0.2.1' }, method: 'POST' } as IncomingMessage;
  const res = {
    writeHead(code: number) { status = code; },
    end(value: string) { body = value; },
  } as unknown as ServerResponse;
  const unexpected = () => { throw new Error('remote request reached runtime control'); };
  await handleAdmin(req, res, new URL('http://localhost/admin/agents/agent/runtime'), {
    getAgent: unexpected,
    start: unexpected,
    stop: unexpected,
  });
  assert.equal(status, 403);
  assert.match(JSON.parse(body).error, /loopback-only/);
});

function runCommand(...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data.toString(); });
    child.stderr.on('data', data => { stderr += data.toString(); });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

const runCLI = (...args: string[]) => runCommand('agent', ...args);

test('runtime admin rejects invalid actions and non-local/resident/Codex targets before control', async () => {
  const agents = [
    makeAgent('codex'),
    makeAgent('remote', { origin_peer: 'peer' }),
    makeAgent('child', { parent_agent_id: 'codex' }),
    makeAgent('workflow', { runtime_scope: 'workflow_run' }),
    makeAgent('opencode', { tool: 'opencode' }),
  ];
  const calls: string[] = [];
  const server = adminServer({
    getAgent: id => agents.find(agent => agent.id === id),
    start: id => { calls.push(`start:${id}`); return true; },
    stop: async id => { calls.push(`stop:${id}`); return { ok: true }; },
  });
  const port = await listen(server);
  try {
    for (const action of ['kill', '', null, 1]) {
      const result = await runtimeRequest(port, 'codex', action);
      assert.equal(result.status, 400);
      assert.match(String(result.body.error), /action must be start or stop/);
    }
    for (const id of ['missing', 'remote', 'child', 'workflow', 'opencode']) {
      assert.equal((await runtimeRequest(port, id, 'stop')).status, 404);
      assert.equal((await runtimeRequest(port, id, 'start')).status, 404);
    }
    assert.deepEqual(calls, []);
  } finally {
    await close(server);
  }
});

test('runtime admin reports safe-stop/start refusal without claiming success', async () => {
  const server = adminServer({
    getAgent: id => makeAgent(id),
    start: () => false,
    stop: async () => ({ ok: false, error: 'runtime is busy or has active connections' }),
  });
  const port = await listen(server);
  try {
    const stopped = await runtimeRequest(port, 'codex', 'stop');
    assert.equal(stopped.status, 409);
    assert.match(String(stopped.body.error), /busy or has active connections/);
    assert.equal((await runtimeRequest(port, 'codex', 'start')).status, 409);
  } finally {
    await close(server);
  }
});

test('registration reconcile does not cold-start Codex but preserves explicit demand and tool cleanup', async () => {
  let agent = makeAgent('codex');
  let ready = false;
  const calls: string[] = [];
  const server = adminServer({
    getAgent: () => agent,
    start: () => { throw new Error('registration must not use runtime start'); },
    stop: async () => { throw new Error('registration must not use runtime stop'); },
    hasReadyRuntime: () => ready,
    ensure: id => { calls.push(`ensure:${id}`); return true; },
    remove: id => { calls.push(`remove:${id}`); return true; },
  });
  const port = await listen(server);
  const notify = async (ensureRuntime: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/admin/notify-agent-created`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agent.id, ensure_runtime: ensureRuntime }),
    });
    return { status: response.status, body: await response.json() as { spawned: boolean } };
  };
  try {
    const cold = await notify(false);
    assert.equal(cold.status, 200);
    assert.equal(cold.body.spawned, false);
    assert.deepEqual(calls, []);

    ready = true;
    assert.equal((await notify(false)).body.spawned, true);
    assert.deepEqual(calls.splice(0), ['ensure:codex']);

    ready = false;
    assert.equal((await notify(true)).body.spawned, true);
    assert.deepEqual(calls.splice(0), ['ensure:codex']);
    assert.equal((await notify('yes')).status, 400);
    assert.deepEqual(calls, []);

    agent = makeAgent('codex', { tool: 'claude' });
    assert.equal((await notify(false)).body.spawned, false);
    assert.deepEqual(calls, ['remove:codex']);
  } finally {
    await close(server);
  }
});

test('runtime admin serializes stop/start for the same agent and contains control errors', async () => {
  let releaseStop!: () => void;
  let observedStop!: () => void;
  let observedStartLookup!: () => void;
  const stopped = new Promise<void>(resolve => { releaseStop = resolve; });
  const stopEntered = new Promise<void>(resolve => { observedStop = resolve; });
  const startLookup = new Promise<void>(resolve => { observedStartLookup = resolve; });
  const calls: string[] = [];
  let lookups = 0;
  const server = adminServer({
    getAgent: id => { if (++lookups === 2) observedStartLookup(); return makeAgent(id); },
    start: () => { calls.push('start'); throw new Error('start inspection failed'); },
    stop: async () => { calls.push('stop'); observedStop(); await stopped; return { ok: true }; },
  });
  const port = await listen(server);
  try {
    const stopRequest = runtimeRequest(port, 'codex', 'stop');
    await stopEntered;
    const startRequest = runtimeRequest(port, 'codex', 'start');
    await startLookup;
    assert.deepEqual(calls, ['stop']);
    releaseStop();
    assert.equal((await stopRequest).status, 200);
    const start = await startRequest;
    assert.equal(start.status, 409);
    assert.match(String(start.body.error), /start inspection failed/);
    assert.deepEqual(calls, ['stop', 'start']);
  } finally {
    releaseStop();
    await close(server);
  }
});

test('runtime admin stop/start and Pool changes remain independent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitty-hive-runtime-admin-'));
  const database = initDB(join(dir, 'hive.db'));
  const agent = createAgent('Resident', 'codex', '', '', { poolEnabled: false });
  const server = adminServer({
    getAgent: getAgentById,
    start: id => { database.prepare('UPDATE agents SET runtime_enabled = 1 WHERE id = ?').run(id); return true; },
    stop: async id => { database.prepare('UPDATE agents SET runtime_enabled = 0 WHERE id = ?').run(id); return { ok: true }; },
  });
  const port = await listen(server);
  try {
    const stopped = await runtimeRequest(port, agent.id, 'stop');
    assert.equal(stopped.status, 200);
    assert.deepEqual(stopped.body, { ok: true, agent_id: agent.id, action: 'stop', runtime_enabled: 0 });
    assert.equal(getAgentById(agent.id)?.runtime_enabled, 0);
    assert.equal(getAgentById(agent.id)?.pool_enabled, 0);

    const ensure = await fetch(`http://127.0.0.1:${port}/admin/notify-agent-created`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agent.id }),
    });
    assert.equal(ensure.status, 200);
    assert.equal((await ensure.json() as { runtime_enabled: number }).runtime_enabled, 0);
    assert.equal(getAgentById(agent.id)?.runtime_enabled, 0);

    const pool = await fetch(`http://127.0.0.1:${port}/admin/sidecar/agents/${agent.id}/pool`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(pool.status, 200);
    assert.equal(getAgentById(agent.id)?.runtime_enabled, 0);
    assert.equal(getAgentById(agent.id)?.pool_enabled, 1);

    const started = await runtimeRequest(port, agent.id, 'start');
    assert.equal(started.status, 200);
    assert.deepEqual(started.body, { ok: true, agent_id: agent.id, action: 'start', runtime_enabled: 1 });
    assert.equal(getAgentById(agent.id)?.runtime_enabled, 1);
    assert.equal(getAgentById(agent.id)?.pool_enabled, 1);
  } finally {
    await close(server);
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime CLI resolves --db and flag order, calls the chosen live port, and never writes runtime state itself', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitty-hive-runtime-cli-'));
  const dbPath = join(dir, 'hive.db');
  const database = initDB(dbPath);
  const agent = createAgent('Runtime Target', 'codex', '', '', { id: 'target/id ?#' });
  const requests: Array<{ url: string; body: unknown }> = [];
  let refuse = false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { action: string };
    requests.push({ url: req.url || '', body });
    res.writeHead(refuse ? 409 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(refuse
      ? { error: 'runtime is busy' }
      : { ok: true, agent_id: agent.id, action: body.action }));
  });
  const port = await listen(server);
  try {
    const stopped = await runCLI('stop', '--port', String(port), '--db', dbPath, agent.display_name);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /runtime=stopped/);
    const started = await runCLI('start', agent.id, '--db', dbPath, '-p', String(port));
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /runtime=starting/);
    assert.deepEqual(requests, [
      { url: `/admin/agents/${encodeURIComponent(agent.id)}/runtime`, body: { action: 'stop' } },
      { url: `/admin/agents/${encodeURIComponent(agent.id)}/runtime`, body: { action: 'start' } },
    ]);
    assert.equal(getAgentById(agent.id)?.runtime_enabled, 1);
    assert.equal(getAgentById(agent.id)?.pool_enabled, 1);

    refuse = true;
    const rejected = await runCLI('stop', agent.id, '--db', dbPath, '--port', String(port));
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /runtime is busy/);
    assert.equal(getAgentById(agent.id)?.runtime_enabled, 1);

    assert.equal((await runCLI('disable', agent.id, '--db', dbPath)).status, 0);
    assert.equal(getAgentById(agent.id)?.pool_enabled, 0);
    assert.equal(getAgentById(agent.id)?.runtime_enabled, 1);
    assert.equal((await runCLI('enable', agent.id, '--db', dbPath)).status, 0);
    assert.equal(getAgentById(agent.id)?.runtime_enabled, 1);
  } finally {
    await close(server);
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime CLI rejects ambiguous/invalid targets and malformed flags without HTTP or DB mutation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitty-hive-runtime-cli-invalid-'));
  const dbPath = join(dir, 'hive.db');
  const database = initDB(dbPath);
  createAgent('Duplicate', 'codex', '', '');
  createAgent('Duplicate', 'codex', '', '');
  const remote = createAgent('Remote', 'codex', '', '', { originPeer: 'peer' });
  const child = createAgent('Child', 'codex', '', '', { parentAgentId: 'resident' });
  const other = createAgent('Other', 'opencode', '', '');
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.writeHead(500).end(); });
  const port = await listen(server);
  const run = (...args: string[]) => runCLI(...args, '--port', String(port), '--db', dbPath);
  try {
    const ambiguous = await run('stop', 'Duplicate');
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /Use agent id to disambiguate/);
    for (const target of ['missing', remote.id, child.id, other.id]) {
      assert.equal((await run('start', target)).status, 1);
    }
    for (const args of [
      ['stop'],
      ['stop', 'Duplicate', '--force'],
      ['stop', 'Duplicate', '--port', '123abc'],
      ['stop', 'Duplicate', '--port', '0'],
      ['stop', 'Duplicate', '--port', '65536'],
      ['stop', 'Duplicate', '--port'],
      ['stop', 'Duplicate', '--db'],
      ['stop', 'Duplicate', 'extra-target'],
    ]) {
      assert.equal((await run(...args)).status, 1);
    }
    assert.equal(requests, 0);
    const missingDB = join(dir, 'missing.db');
    assert.equal((await runCLI('stop', 'missing', '--db', missingDB, '--port', String(port))).status, 1);
    assert.equal(existsSync(missingDB), false);
    for (const agent of [remote, child, other]) assert.equal(getAgentById(agent.id)?.runtime_enabled, 1);
  } finally {
    await close(server);
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime CLI fails when serve is offline without directly disabling the runtime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitty-hive-runtime-cli-offline-'));
  const dbPath = join(dir, 'hive.db');
  const database = initDB(dbPath);
  const agent = createAgent('Offline Target', 'codex', '', '');
  const server = createServer();
  const port = await listen(server);
  await close(server);
  try {
    const result = await runCLI('stop', agent.id, '--db', dbPath, '--port', String(port));
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`serve on port ${port} is offline or unreachable`));
    assert.equal(getAgentById(agent.id)?.runtime_enabled, 1);
  } finally {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex CLI registration requests metadata reconciliation without runtime demand', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitty-hive-codex-register-demand-'));
  const dbPath = join(dir, 'hive.db');
  const database = initDB(dbPath);
  const requests: unknown[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/admin/notify-agent-created');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, spawned: false }));
  });
  const port = await listen(server);
  try {
    const registered = await runCLI('register', '--key', 'registered-key', '--display-name', 'Registered', '--tool', 'codex', '--db', dbPath, '--port', String(port));
    assert.equal(registered.status, 0, registered.stderr);
    const agentId = registered.stdout.trim();
    assert.deepEqual(requests, [{ agent_id: agentId, ensure_runtime: false }]);
    assert.equal(getAgentById(agentId)?.runtime_enabled, 1);
    assert.equal(getAgentById(agentId)?.pool_enabled, 1);
  } finally {
    await close(server);
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex-pane explicitly requests an enabled cold runtime before polling and respects manual stop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitty-hive-codex-pane-demand-'));
  const dbPath = join(dir, 'hive.db');
  const database = initDB(dbPath);
  const agent = createAgent('Pane Target', 'codex', '', '', { externalKey: 'pane-key' });
  const requests: Array<{ method?: string; url?: string; body?: unknown }> = [];
  let enabled = true;
  const server = createServer(async (req, res) => {
    const record: typeof requests[number] = { method: req.method, url: req.url };
    requests.push(record);
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/admin/notify-agent-created') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      record.body = JSON.parse(Buffer.concat(chunks).toString());
      res.end(JSON.stringify({ ok: true, spawned: enabled, tool: 'codex', runtime_enabled: enabled ? 1 : 0 }));
    } else if (req.method === 'GET' && req.url === '/admin/codex-daemons') {
      res.end(JSON.stringify({ daemons: [{ agent_id: agent.id, ready: true, ws_url: 'ws://127.0.0.1:1', thread_id: 'saved-thread' }] }));
    } else {
      res.writeHead(500).end(JSON.stringify({ error: 'unexpected request' }));
    }
  });
  const port = await listen(server);
  const options = ['--db', dbPath, '--port', String(port), '--timeout-ms', '1000'];
  try {
    const byKey = await runCommand('codex-pane', 'ws', '--key', 'pane-key', ...options);
    assert.equal(byKey.status, 0, byKey.stderr);
    assert.equal(JSON.parse(byKey.stdout).status, 'ready');
    assert.deepEqual(requests.splice(0), [
      { method: 'POST', url: '/admin/notify-agent-created', body: { agent_id: agent.id, ensure_runtime: true } },
      { method: 'GET', url: '/admin/codex-daemons' },
    ]);

    const byId = await runCommand('codex-pane', 'ws', '--id', agent.id, ...options);
    assert.equal(byId.status, 0, byId.stderr);
    assert.equal(requests.splice(0).length, 2);

    enabled = false;
    const stopped = await runCommand('codex-pane', 'ws', '--key', 'pane-key', ...options);
    assert.equal(stopped.status, 1);
    assert.equal(JSON.parse(stopped.stdout).status, 'stopped');
    assert.match(JSON.parse(stopped.stdout).error, /agent start/);
    assert.deepEqual(requests, [{ method: 'POST', url: '/admin/notify-agent-created', body: { agent_id: agent.id, ensure_runtime: true } }]);
    assert.equal(getAgentById(agent.id)?.runtime_enabled, 1);

    for (const flags of [['--port'], ['--port', '0'], ['--port', '123x'], ['--timeout-ms', '-1']]) {
      assert.equal((await runCommand('codex-pane', 'ws', '--id', agent.id, ...flags)).status, 1);
    }
    assert.equal(requests.length, 1);
  } finally {
    await close(server);
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
