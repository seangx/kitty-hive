#!/usr/bin/env node

import { chmodSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

const PORT = 18000 + randomInt(0, 1000);
const DB = `/tmp/hive-opencode-supervisor-${process.pid}.db`;
const FAKE = `/tmp/fake-opencode-${process.pid}.mjs`;
const STATE = `/tmp/fake-opencode-state-${process.pid}.json`;
let server;
let pass = 0;
let fail = 0;
let serverLog = '';

function ok(condition, message) {
  if (condition) { console.log(`  ✓ ${message}`); pass++; }
  else { console.error(`  ✗ ${message}`); fail++; }
}

function cleanup() {
  if (server && !server.killed) server.kill('SIGTERM');
  for (const path of [FAKE, STATE, DB, `${DB}-wal`, `${DB}-shm`]) {
    if (existsSync(path)) try { unlinkSync(path); } catch { /* ignore */ }
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

writeFileSync(FAKE, `#!/usr/bin/env node
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.18.0-test'); process.exit(0); }
if (args[0] !== 'serve') process.exit(2);
const port = Number(args[args.indexOf('--port') + 1]);
const expected = 'Basic ' + Buffer.from((process.env.OPENCODE_SERVER_USERNAME || 'opencode') + ':' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
const statePath = process.env.FAKE_OPENCODE_STATE;
const saved = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { next: 1, sessions: [] };
let next = saved.next;
let selected = '';
const sessions = new Map(saved.sessions.map(value => [value.id, value]));
const persist = () => { if (statePath) writeFileSync(statePath, JSON.stringify({ next, sessions: [...sessions.values()].map(value => ({ ...value, busy: false })) })); };
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = createServer(async (req, res) => {
  if (req.headers.authorization !== expected) return json(res, 401, { error: 'unauthorized' });
  const url = new URL(req.url, 'http://localhost');
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  if (url.pathname === '/global/health') return json(res, 200, { healthy: true, version: '1.18.0-test' });
  if (url.pathname === '/session/status') {
    const out = {}; for (const [id, value] of sessions) if (value.busy) out[id] = { type: 'busy' };
    return json(res, 200, out);
  }
  if (url.pathname === '/session' && req.method === 'POST') {
    const id = 'ses_test_' + next++; sessions.set(id, { id, title: body.title, messages: [], busy: false }); persist();
    return json(res, 200, { id, title: body.title, version: '1.18.0-test' });
  }
  const match = url.pathname.match(/^\\/session\\/(ses[^/]+)(?:\\/(message|prompt_async))?$/);
  if (match) {
    const session = sessions.get(match[1]);
    if (!session) return json(res, 404, { error: 'not found' });
    if (!match[2] && req.method === 'GET') return json(res, 200, { id: session.id, title: session.title });
    if (match[2] === 'message' && req.method === 'GET') return json(res, 200, session.messages);
    if (match[2] === 'prompt_async' && req.method === 'POST') {
      session.messages.push({ info: { role: 'user' }, parts: body.parts }); session.busy = true; persist();
      res.writeHead(204); res.end(); setTimeout(() => { session.busy = false; persist(); }, 40); return;
    }
  }
  if (url.pathname === '/tui/select-session' && req.method === 'POST') { selected = body.sessionID; return json(res, 200, true); }
  if (url.pathname === '/test/selected') return json(res, 200, { session_id: selected });
  return json(res, 404, { error: 'not found', path: url.pathname });
});
server.listen(port, '127.0.0.1', () => console.log('fake opencode listening ' + port));
for (const sig of ['SIGINT','SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
`);
chmodSync(FAKE, 0o755);

server = spawn(process.execPath, ['dist/index.js', 'serve', '--port', String(PORT), '--db', DB, '--quiet'], {
  env: { ...process.env, OPENCODE_CMD: FAKE, FAKE_OPENCODE_STATE: STATE },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', chunk => { serverLog += chunk; });
server.stderr.on('data', chunk => { serverLog += chunk; });

async function waitFor(fn, timeout = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { const value = await fn(); if (value) return value; } catch { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timeout; server log tail:\n${serverLog.slice(-3000)}`);
}

await waitFor(async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/admin/opencode-daemons`);
  return res.ok;
});

console.log('\n=== Unified respawn validation ===');
const missingAgentRes = await fetch(`http://127.0.0.1:${PORT}/admin/daemon-respawn`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
});
ok(missingAgentRes.status === 400, 'missing agent_id fails closed');
const unknownAgentRes = await fetch(`http://127.0.0.1:${PORT}/admin/daemon-respawn`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_id: 'missing-agent' }),
});
ok(unknownAgentRes.status === 404, 'unknown agent fails closed');

let rpc = 0;
async function newMcpSession() {
  const init = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'initialize', params: {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'opencode-test', version: '1' },
    } }),
  });
  const sid = init.headers.get('mcp-session-id');
  await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': sid },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return sid;
}

async function call(sid, name, args) {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': sid },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await res.text();
  const line = text.split('\n').find(item => item.startsWith('data:'));
  const envelope = JSON.parse(line ? line.slice(5) : text);
  const tool = envelope.result;
  if (tool.isError) throw new Error(tool.content?.[0]?.text || 'tool error');
  return JSON.parse(tool.content[0].text);
}

console.log('\n=== Dynamic spawn and attach contract ===');
const receiverSid = await newMcpSession();
const receiver = await call(receiverSid, 'hive_start', {
  key: `opencode-test-${process.pid}`, name: 'opencode-test-agent', tool: 'opencode',
});
const ready = await waitFor(async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/admin/opencode-daemons`);
  const body = await res.json();
  return body.daemons.find(item => item.agent_id === receiver.agent_id && item.ready);
}, 20_000);
ok(ready.server_url?.startsWith('http://127.0.0.1:'), 'supervisor exposes loopback OpenCode server');
ok(ready.session_id?.startsWith('ses'), 'supervisor persists OpenCode session id');
ok(ready.server_password && !serverLog.includes(ready.server_password), 'attach password is present but never logged');

const unauth = await fetch(`${ready.server_url}/global/health`);
ok(unauth.status === 401, 'OpenCode backend rejects unauthenticated local clients');
const auth = `Basic ${Buffer.from(`${ready.server_username}:${ready.server_password}`).toString('base64')}`;
const health = await fetch(`${ready.server_url}/global/health`, { headers: { Authorization: auth } });
ok(health.ok, 'returned credentials authenticate to the backend');

const pane = spawnSync(process.execPath, ['dist/index.js', 'opencode-pane', 'server', '--id', receiver.agent_id,
  '--port', String(PORT), '--db', DB, '--timeout-ms', '3000'], { encoding: 'utf8' });
ok(pane.status === 0, `opencode-pane CLI exits 0 (stderr=${pane.stderr.trim()})`);
const paneInfo = JSON.parse(pane.stdout.trim());
ok(paneInfo.session_id === ready.session_id && paneInfo.server_url === ready.server_url, 'CLI returns the same supervised backend/session');
const paneTool = await call(receiverSid, 'hive_opencode_pane_server', { agent_id: receiver.agent_id });
ok(
  paneTool.status === 'ready'
  && paneTool.session_id === ready.session_id
  && paneTool.server_password === ready.server_password,
  'MCP launcher tool returns the same authenticated backend/session',
);

console.log('\n=== Hive DM reaches the persistent OpenCode session ===');
const senderSid = await newMcpSession();
const sender = await call(senderSid, 'hive_start', { name: 'opencode-test-sender', tool: 'shell' });
const unsupportedRes = await fetch(`http://127.0.0.1:${PORT}/admin/daemon-respawn`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_id: sender.agent_id }),
});
ok(unsupportedRes.status === 400, 'non-supervised tool fails closed');
const sent = await call(senderSid, 'hive_dm', { to: receiver.agent_id, content: 'integration push payload' });
await waitFor(async () => {
  const res = await fetch(`${ready.server_url}/session/${ready.session_id}/message?limit=100`, { headers: { Authorization: auth } });
  const messages = await res.json();
  return messages.some(message => message.parts?.some(part => part.text?.includes(`message_id: ${sent.message_id}`)));
}, 10_000);
ok(true, 'DM push was injected with the fetch-only message id');

console.log('\n=== In-process new session ===');
const switched = await waitFor(async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/admin/opencode-set-session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: receiver.agent_id, session_id: null }),
  });
  const body = await res.json();
  return res.ok && body.ok ? body : null;
});
ok(true, `set-session succeeds in-process (mode=${switched.mode}, session=${switched.session_id})`);
ok(switched.server_url === ready.server_url, 'server URL stays stable across session reset');
ok(switched.session_id !== ready.session_id && switched.session_id.startsWith('ses'), 'fresh OpenCode session selected');
const selectedRes = await fetch(`${ready.server_url}/test/selected`, { headers: { Authorization: auth } });
const selected = await selectedRes.json();
ok(selected.session_id === switched.session_id, 'attached TUI selection endpoint received the new session');
await waitFor(async () => {
  const res = await fetch(`${ready.server_url}/session/${switched.session_id}/message?limit=100`, { headers: { Authorization: auth } });
  const messages = await res.json();
  return messages.some(message => message.parts?.some(part => part.text?.includes('FIRST ACTION: call hive_start')));
});
ok(true, 'fresh in-process session receives the identity brief');
const db = new Database(DB, { readonly: true });
const row = db.prepare('SELECT thread_id FROM agents WHERE id = ?').get(receiver.agent_id);
db.close();
ok(row.thread_id === switched.session_id, 'new session id persisted for daemon restart');

console.log('\n=== Forced daemon respawn preserves session and returns fresh attach ===');
const beforeRespawn = await waitFor(async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/admin/opencode-daemons`);
  const body = await res.json();
  return body.daemons.find(item => item.agent_id === receiver.agent_id && item.ready);
});
const respawnRes = await fetch(`http://127.0.0.1:${PORT}/admin/daemon-respawn`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ agent_id: receiver.agent_id }),
});
const respawned = await respawnRes.json();
ok(respawnRes.status === 200 && respawned.ok && respawned.ready, 'unified respawn waits for ready');
ok(respawned.tool === 'opencode' && respawned.mode === 'respawn', 'response identifies OpenCode respawn');
ok(
  respawned.conversation?.requested_id === switched.session_id
  && respawned.conversation?.id === switched.session_id
  && respawned.conversation?.preserved === true,
  'forced respawn preserves the existing OpenCode session',
);
ok(
  respawned.attach?.kind === 'opencode-attach'
  && respawned.attach?.session_id === switched.session_id
  && respawned.attach?.server_url !== switched.server_url,
  'response returns fresh OpenCode attach coordinates',
);
ok(respawned.daemon?.pid !== beforeRespawn.pid, 'replacement daemon has a new pid');
const respawnAuth = `Basic ${Buffer.from(`${respawned.attach.server_username}:${respawned.attach.server_password}`).toString('base64')}`;
const respawnHealth = await fetch(`${respawned.attach.server_url}/global/health`, { headers: { Authorization: respawnAuth } });
ok(respawnHealth.ok, 'fresh attach credentials authenticate to the replacement backend');

console.log('\n=== Conversation preservation fails closed ===');
const mismatchDb = new Database(DB);
mismatchDb.prepare('UPDATE agents SET thread_id = ? WHERE id = ?').run('ses_missing_for_respawn_test', receiver.agent_id);
mismatchDb.close();
const mismatchRes = await fetch(`http://127.0.0.1:${PORT}/admin/daemon-respawn`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ agent_id: receiver.agent_id }),
});
const mismatch = await mismatchRes.json();
ok(mismatchRes.status === 409 && mismatch.ok === false && mismatch.ready === true,
  'conversation mismatch returns HTTP 409 with recovered ready state');
ok(
  mismatch.status === 'conversation_changed'
  && mismatch.conversation?.requested_id === 'ses_missing_for_respawn_test'
  && mismatch.conversation?.preserved === false
  && mismatch.attach?.session_id,
  'mismatch response exposes requested id and recovered attach coordinates',
);

console.log(`\n${pass} passed, ${fail} failed`);
server.kill('SIGTERM');
await new Promise(resolve => server.once('exit', resolve));
process.exit(fail === 0 ? 0 : 1);
