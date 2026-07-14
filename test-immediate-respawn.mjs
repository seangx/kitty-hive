#!/usr/bin/env node
// e2e for v0.7.6 supervisor changes: intentional-shutdown skips exp backoff
// and 30s-healthy reset of restartCount.
//
// Root incident being defended: 2026-07-12 my-game had restart_count=89
// because kitty called /admin/codex-set-thread on every session restart.
// The supervisor's exit handler applied exp backoff (cap 60s) to the
// respawn, which was well past kitty's 10s poll window — so kitty saw
// "daemon never ready" and gave up, users looped forever.
//
// What we verify (against a real codex binary in the test env):
//   1. First set-thread call → daemon respawns and reports ready within a
//      reasonable window (codex spawn overhead ~5-15s).
//   2. AFTER the first respawn, call set-thread again → the second respawn
//      must also happen fast. Under the OLD code, restart_count would have
//      climbed by 1 each intentional restart, so by call 3 you'd already
//      be at ~4s backoff. Under the NEW code, intentional restarts keep
//      restart_count at 0.
//   3. Snapshot after several intentional restarts shows restart_count
//      stays low (ideally 0 after each one thanks to the reset).

import { spawn } from 'node:child_process';
import { unlinkSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PORT = 15100 + randomInt(0, 99);
const DB_PATH = `/tmp/hive-test-immed-${process.pid}.db`;
const BASE = `http://127.0.0.1:${PORT}/mcp`;
const ADMIN = `http://127.0.0.1:${PORT}`;

let serverProcess = null;
let pass = 0, fail = 0;
const scratchJsonl = [];

function cleanup() {
  if (serverProcess) try { serverProcess.kill('SIGTERM'); } catch { /* ignore */ }
  for (const ext of ['', '-wal', '-shm']) {
    const p = DB_PATH + ext;
    if (existsSync(p)) try { unlinkSync(p); } catch { /* ignore */ }
  }
  for (const p of scratchJsonl) try { unlinkSync(p); } catch { /* ignore */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function startHive() {
  serverProcess = spawn('node', ['dist/index.js', 'serve', '--port', String(PORT), '--db', DB_PATH], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  const onData = d => {
    process.stderr.write(`[hive] ${d}`);
    if (String(d).includes('listening on')) ready = true;
  };
  serverProcess.stdout.on('data', onData);
  serverProcess.stderr.on('data', onData);
  for (let i = 0; i < 80 && !ready; i++) await new Promise(r => setTimeout(r, 100));
  if (!ready) throw new Error('hive did not become ready');
}

let idCounter = 0;
async function mcpCall(sid, method, params) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (sid) headers['Mcp-Session-Id'] = sid;
  const res = await fetch(BASE, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++idCounter, method, params }),
  });
  const newSid = res.headers.get('mcp-session-id');
  const text = await res.text();
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) {
      const data = JSON.parse(line.slice(5));
      if (data.error) throw new Error(JSON.stringify(data.error));
      return { sid: newSid, result: data.result };
    }
  }
  const data = JSON.parse(text);
  if (data.error) throw new Error(JSON.stringify(data.error));
  return { sid: newSid, result: data.result };
}

async function initClient() {
  let { sid } = await mcpCall(null, 'initialize', {
    protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 'immed-test', version: '1.0' },
  });
  await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Mcp-Session-Id': sid },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return sid;
}

async function getDaemon(agentId) {
  const res = await fetch(`${ADMIN}/admin/codex-daemons`);
  const body = await res.json();
  return body.daemons.find(d => d.agent_id === agentId) || null;
}

function ok(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.error(`  ✗ ${msg}`); fail++; }
}

async function run() {
  await startHive();

  // Register a codex agent. Supervisor will spawn a real codex app-server
  // (since codex binary is installed in this dev env). That's fine — this
  // test intentionally exercises the full spawn/ready loop.
  const sid = await initClient();
  const registerRes = await mcpCall(sid, 'tools/call', {
    name: 'hive_start',
    arguments: { name: 'immed-test-agent', tool: 'codex' },
  });
  const agent = JSON.parse(registerRes.result.content[0].text);
  ok(!!agent.agent_id, `agent registered: ${agent.agent_id}`);

  // Wait for the initial daemon to reach ready. Give real codex time to spawn.
  console.log('\n=== Waiting for initial daemon spawn... ===');
  let initialDaemon = null;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    const d = await getDaemon(agent.agent_id);
    if (d && d.ready) { initialDaemon = d; break; }
  }
  if (!initialDaemon) {
    console.error('FATAL: initial daemon never became ready in 30s — is codex installed?');
    process.exit(1);
  }
  ok(initialDaemon.ready === true, `initial daemon ready at ${initialDaemon.ws_url}`);
  ok(initialDaemon.restart_count === 0, `initial restart_count=0 (got ${initialDaemon.restart_count})`);

  // Provide a fake rollout jsonl so set-thread validation passes. We'll
  // point at a fabricated thread id.
  const fakeThreadId = '01999999-bbbb-7bbb-abbb-bbbbbbbbbbbb';
  const fakeDir = join(homedir(), '.codex', 'sessions', '2099', '99', '99-immed');
  mkdirSync(fakeDir, { recursive: true });
  const fakePath = join(fakeDir, `rollout-immed-${fakeThreadId}.jsonl`);
  writeFileSync(fakePath, '{"type":"thread_meta","id":"' + fakeThreadId + '"}\n');
  scratchJsonl.push(fakePath);

  async function callSetThread(threadId) {
    const t0 = Date.now();
    const res = await fetch(`${ADMIN}/admin/codex-set-thread`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agent.agent_id, thread_id: threadId }),
    });
    const body = await res.json();
    return { elapsed: Date.now() - t0, status: res.status, body };
  }

  console.log('\n=== Test 1: intentional respawn is fast (first call) ===');
  {
    const r = await callSetThread(fakeThreadId);
    ok(r.status === 200, `set-thread → 200 (got ${r.status})`);
    ok(r.body.ok === true, `body.ok=true (respawn reached ready within 30s window)`);
    ok(r.elapsed < 45_000, `elapsed ${r.elapsed}ms < 45s (real codex spawn budget; the /admin/codex-set-thread API has its own 30s timeout so anything <45s here means we reached ready + returned)`);
  }

  console.log('\n=== Test 2: after 3 consecutive intentional restarts, restart_count stays 0 ===');
  // Under OLD code, each intentional restart would increment restart_count.
  // By call 3 the exit handler would schedule 4s backoff (min(60, 1000*2^2))
  // and by call 8 it would be 60s. The regression check: NEW code keeps
  // restart_count at 0 across these because the intentionalShutdown flag
  // both skips the backoff and resets the counter.
  for (let i = 0; i < 3; i++) {
    const t = i % 2 === 0 ? null : fakeThreadId;  // alternate reset ↔ resume
    const r = await callSetThread(t);
    // ok=false is acceptable here — it means the /admin API's own 30s
    // ready-poll timed out. The core invariant of this test isn't API
    // response timing (real codex spawn under 4-in-a-row load is slow),
    // it's that restart_count stays 0 so we DON'T inherit an exp-backoff
    // penalty. We wait a bit longer to see the daemon actually reach
    // ready — that's the real "did the immediate-respawn path work".
    if (!r.body.ok) {
      for (let j = 0; j < 30; j++) {
        await new Promise(r => setTimeout(r, 500));
        const d = await getDaemon(agent.agent_id);
        if (d && d.ready) break;
      }
    }
    const d = await getDaemon(agent.agent_id);
    ok(d?.ready === true, `set-thread call ${i + 2}: daemon eventually ready (api ok=${r.body.ok})`);
    ok(d?.restart_count === 0,
      `after intentional restart ${i + 2}: restart_count=0 (got ${d?.restart_count}) — this is the core regression check`);
    ok(r.elapsed < 45_000,
      `elapsed ${r.elapsed}ms < 45s (would climb to 60s+ under old code once counter went past ~6)`);
  }

  console.log('\n=== Test 3: reset via in-process switch keeps ws_url stable ===');
  // v0.7.8 flipped this expectation: set-thread(null) on a READY daemon now
  // takes the in-process switch path (no respawn), so ws_url must be
  // UNCHANGED. (The original "snapshot reflects NEW url after respawn"
  // regression is still covered implicitly by Test 1/2's fake-thread resumes:
  // a fake thread makes the in-process resume fail → 500 → fallback respawn,
  // and those calls' ok/ready assertions read the post-respawn snapshot.)
  {
    // Ensure the daemon is ready so the in-process path is eligible (test 2's
    // last fake-resume may have left it mid-respawn). mode=respawn is legal
    // graceful degradation (e.g. the switch raced a daemon hand-over), so
    // retry a couple of times — a READY daemon with a control server must
    // eventually serve the in-process path.
    let before = null, r = null, after = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      for (let j = 0; j < 60; j++) {
        const d = await getDaemon(agent.agent_id);
        if (d && d.ready) break;
        await new Promise(rr => setTimeout(rr, 500));
      }
      before = await getDaemon(agent.agent_id);
      r = await callSetThread(null);
      after = await getDaemon(agent.agent_id);
      if (r.body.mode === 'in-process') break;
      console.log(`  (info: attempt ${attempt + 1} degraded to respawn — retrying)`);
    }
    ok(before && after, 'both snapshots present');
    if (before && after) {
      ok(r.body.mode === 'in-process', `mode=in-process (got ${r.body.mode})`);
      ok(before.ws_url === after.ws_url,
        `ws_url unchanged (${before.ws_url})`);
      ok(before.pid === after.pid, `pid unchanged (${before.pid})`);
      ok(r.body.ws_url === after.ws_url,
        `set-thread response ws_url matches daemon snapshot`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(err => {
  console.error('FATAL:', err);
  cleanup();
  process.exit(1);
});
