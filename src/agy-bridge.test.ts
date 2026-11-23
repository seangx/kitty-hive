import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AgyBridgeServer,
  AgyBridgeState,
  agyPushDedupKey,
  bridgeSocketPath,
  discoverBridgeSocket,
  formatAgyPushNotification,
  inspectAgyPaneForColdBootstrap,
  parseBridgeSocketPid,
} from './agy-bridge.js';
import { resolveAgentApiInvocation, runAgyRelay } from './agy-relay.js';

function sendHookLine(socketPath: string, payload: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      sock.write(JSON.stringify(payload) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk;
      const idx = buf.indexOf('\n');
      if (idx !== -1) {
        const line = buf.slice(0, idx).trim();
        sock.end();
        resolve(JSON.parse(line));
      }
    });
    sock.on('error', reject);
  });
}

function runHookScript(scriptPath: string, socketPath: string, stdinObj: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [scriptPath],
      {
        env: { ...process.env, HIVE_AGY_BRIDGE_SOCKET: socketPath },
        timeout: 5000,
      },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`hook failed: ${stderr || err.message}`));
        resolve(JSON.parse(stdout.trim()));
      },
    );
    child.stdin?.end(JSON.stringify(stdinObj));
  });
}

test('inspectAgyPaneForColdBootstrap detects idle empty prompt vs draft vs busy', () => {
  const rule = '─'.repeat(40);
  const idleWithPlaceholder = [
    'Some previous response',
    rule,
    '> Accept-edits mode: file edits auto-approved (shift+tab to cycle)',
    rule,
    'main │ Gemini 4 Argon',
  ].join('\n');
  assert.deepEqual(inspectAgyPaneForColdBootstrap(idleWithPlaceholder), {
    canBootstrap: true,
    reason: 'idle_empty',
  });

  const idleBare = ['ok', rule, '>', rule, 'status'].join('\n');
  assert.deepEqual(inspectAgyPaneForColdBootstrap(idleBare), {
    canBootstrap: true,
    reason: 'idle_empty',
  });

  const withDraft = ['ok', rule, '> working on a draft prompt', rule, 'status'].join('\n');
  assert.deepEqual(inspectAgyPaneForColdBootstrap(withDraft), {
    canBootstrap: false,
    reason: 'draft',
  });

  const busy = ['> user msg', '⢿  Generating...', rule, '>', rule, 'status'].join('\n');
  assert.deepEqual(inspectAgyPaneForColdBootstrap(busy), {
    canBootstrap: false,
    reason: 'busy',
  });
});

test('resolveAgentApiInvocation prepends agentapi subcommand when pointing to main antigravity binary', () => {
  assert.deepEqual(
    resolveAgentApiInvocation('/opt/homebrew/Caskroom/antigravity-cli/1.5.14/antigravity'),
    { bin: '/opt/homebrew/Caskroom/antigravity-cli/1.5.14/antigravity', prefixArgs: ['agentapi'] },
  );
  assert.deepEqual(
    resolveAgentApiInvocation('/Users/marvingod/.gemini/antigravity-cli/bin/agentapi'),
    { bin: '/Users/marvingod/.gemini/antigravity-cli/bin/agentapi', prefixArgs: [] },
  );
  assert.deepEqual(
    resolveAgentApiInvocation(''),
    { bin: 'agentapi', prefixArgs: [] },
  );
});

test('bridgeSocketPath and parseBridgeSocketPid round-trip owner pid', () => {
  const p = bridgeSocketPath(42424, '/tmp');
  assert.equal(p, '/tmp/kitty-hive-agy-42424.sock');
  assert.equal(parseBridgeSocketPid(p), 42424);
  assert.equal(parseBridgeSocketPid('/tmp/other.sock'), null);
});

test('agyPushDedupKey prefers event_id, then message_id, then fallback', () => {
  assert.equal(agyPushDedupKey({ event_id: 'ev-1', message_id: 9 }, 'x'), 'evid:ev-1');
  assert.equal(agyPushDedupKey({ message_id: 9 }, 'x'), 'dm:9');
  assert.equal(agyPushDedupKey({ from: 'alice', type: 'dm' }, 'hello'), 'alice:dm:hello');
});

test('formatAgyPushNotification adds fetch hint when preview omits it', () => {
  const dm = formatAgyPushNotification({ type: 'dm', from: 'alice', from_agent_id: 'A1', message_id: 77, preview: 'New DM' }, 'raw');
  assert.equal(dm.title, '[hive] dm from alice');
  assert.match(dm.content, /hive-dm-read\(\{ message_id: 77 \}\)/);

  const alreadyHinted = formatAgyPushNotification(
    { type: 'dm', from: 'alice', message_id: 77, preview: '[hive] dm from alice — call hive-dm-read({ message_id: 77 }) for full content.' },
    'raw',
  );
  assert.equal((alreadyHinted.content.match(/hive-dm-read/g) || []).length, 1);
});

test('AgyBridgeState deduplicates, skips join/leave, and preserves order on relay failure/disconnect', () => {
  const st = new AgyBridgeState();
  assert.equal(st.enqueue({ type: 'join', from: 'bob' }, '{}'), null);
  assert.equal(st.enqueue({ type: 'leave', from: 'bob' }, '{}'), null);

  const first = st.enqueue({ type: 'dm', from: 'alice', message_id: 1, preview: 'm1' }, 'm1');
  const dup = st.enqueue({ type: 'dm', from: 'alice', message_id: 1, preview: 'm1' }, 'm1');
  const second = st.enqueue({ type: 'dm', from: 'alice', message_id: 2, preview: 'm2' }, 'm2');
  assert.ok(first);
  assert.equal(dup, null);
  assert.ok(second);

  // 未连接 relay 或无 conversationId 时不取走
  assert.deepEqual(st.takeForRelay(), []);
  st.setRelayConnected(true);
  assert.deepEqual(st.takeForRelay(), []);

  st.setConversationId('conv-1');
  const batch = st.takeForRelay();
  assert.equal(batch.length, 2);
  assert.equal(batch[0].conversationId, 'conv-1');
  assert.equal(st.getStatus().pendingCount, 0);
  assert.equal(st.getStatus().inFlightCount, 2);

  // 在途期间 hook 不应重复拿到同一批推送
  assert.deepEqual(st.drainForHook('PreInvocation'), []);

  // 第一条成功，第二条断连回退
  st.ackRelay(batch[0].deliveryId, true);
  st.onRelayDisconnect();
  assert.equal(st.getStatus().inFlightCount, 0);
  assert.equal(st.getStatus().pendingCount, 1);

  const hookItems = st.drainForHook('Stop', false);
  assert.equal(hookItems.length, 1);
  assert.equal(hookItems[0].dedupKey, 'dm:2');
});

test('AgyBridgeState Stop hook guards against continuationActive loops', () => {
  const st = new AgyBridgeState();
  st.enqueue({ type: 'dm', from: 'alice', message_id: 10, preview: 'first' }, 'first');
  const firstDrain = st.drainForHook('Stop', false);
  assert.equal(firstDrain.length, 1);

  // continuationActive=true 且无新事件时返回空
  assert.deepEqual(st.drainForHook('Stop', true), []);

  // 若续跑期间又来了新消息，允许再次 drain
  st.enqueue({ type: 'dm', from: 'alice', message_id: 11, preview: 'second' }, 'second');
  const secondDrain = st.drainForHook('Stop', true);
  assert.equal(secondDrain.length, 1);
  assert.equal(secondDrain[0].dedupKey, 'dm:11');
});

test('discoverBridgeSocket walks ancestor PIDs to locate matching agy-channel socket', () => {
  const parents = new Map<number, number>([
    [500, 400],
    [400, 300],
    [300, 1],
  ]);
  const expected = bridgeSocketPath(300, '/tmp');
  const prevEnv = process.env.HIVE_AGY_BRIDGE_SOCKET;
  delete process.env.HIVE_AGY_BRIDGE_SOCKET;
  try {
    const found = discoverBridgeSocket(500, {
      dir: '/tmp',
      getParentPid: (p) => parents.get(p) ?? null,
      exists: (p) => p === expected,
    });
    assert.deepEqual(found, { socketPath: expected, ownerPid: 300 });

    const missing = discoverBridgeSocket(500, {
      dir: '/tmp',
      getParentPid: (p) => parents.get(p) ?? null,
      exists: () => false,
    });
    assert.equal(missing, null);
  } finally {
    if (prevEnv !== undefined) process.env.HIVE_AGY_BRIDGE_SOCKET = prevEnv;
  }
});

test('AgyBridgeServer + AgyRelay + agy-hook.mjs end-to-end delivery, /resume switch, and fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-bridge-test-'));
  const socketPath = join(dir, 'bridge.sock');
  const hookScript = new URL('../antigravity-plugin/scripts/agy-hook.mjs', import.meta.url).pathname;

  const bridge = new AgyBridgeServer({
    socketPath,
    getIdentity: () => ({ agentId: 'AG1', agentName: 'agy-tester' }),
    onLog: () => {},
  });
  await bridge.start();

  const delivered: Array<{ conversationId: string; title: string; content: string }> = [];
  const relayLogs: string[] = [];
  let failNext = false;

  const ac = new AbortController();
  const relayPromise = runAgyRelay([], {
    socketPath,
    conversationId: 'conv-initial',
    signal: ac.signal,
    onLog: (m) => relayLogs.push(m),
    sender: async (input) => {
      if (failNext) {
        failNext = false;
        throw new Error('simulated agentapi outage');
      }
      delivered.push(input);
    },
  });

  try {
    // 等待 relay 连上
    for (let i = 0; i < 40 && !bridge.state.getStatus().relayConnected; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(bridge.state.getStatus().relayConnected, true, `relay did not connect: ${relayLogs.join('; ')}`);

    // 1. SessionStart hook 上报初始会话 ID
    const s1 = await runHookScript(hookScript, socketPath, {
      hookEventName: 'SessionStart',
      conversationId: 'conv-A',
      cwd: dir,
    });
    assert.deepEqual(s1, {});

    // 2. 推送消息，验证经 relay 投递到 conv-A
    bridge.pushEvent({ type: 'dm', from: 'master', message_id: 101, preview: 'hi A' }, 'hi A');
    for (let i = 0; i < 40 && delivered.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].conversationId, 'conv-A');
    assert.match(delivered[0].content, /message_id=101/);

    // 3. 模拟 /resume 切换会话：PreInvocation hook 上报 conv-B
    const s2 = await runHookScript(hookScript, socketPath, {
      hookEventName: 'PreInvocation',
      conversationId: 'conv-B',
      cwd: dir,
    });
    assert.deepEqual(s2, {});

    bridge.pushEvent({ type: 'dm', from: 'master', message_id: 102, preview: 'hi B' }, 'hi B');
    for (let i = 0; i < 40 && delivered.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(delivered.length, 2);
    assert.equal(delivered[1].conversationId, 'conv-B');

    // 4. 模拟 relay 投递失败 → 消息自动退回队列，由 Stop hook 兜底注入
    failNext = true;
    bridge.pushEvent({ type: 'dm', from: 'master', message_id: 103, preview: 'fallback msg' }, 'fallback msg');
    for (let i = 0; i < 40 && bridge.state.getStatus().pendingCount < 1; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(bridge.state.getStatus().pendingCount, 1);

    const stopOut = await runHookScript(hookScript, socketPath, {
      hookEventName: 'Stop',
      conversationId: 'conv-B',
      continuationActive: false,
    });
    assert.equal(stopOut.decision, 'continue');
    assert.match(stopOut.reason, /message_id=103/);

    // 验证直接短连接 hook 查询在清空后返回空
    const after = await sendHookLine(socketPath, {
      type: 'hook',
      event: 'PreInvocation',
      conversationId: 'conv-B',
    });
    assert.equal(after.pending.length, 0);
  // 5. 验证 PreToolUse 自动放行 kitty-hive MCP 工具与 agy-relay，其余保持 ask
  const allowMcp = await runHookScript(hookScript, socketPath, {
    hookEventName: 'PreToolUse',
    toolCall: { name: 'call_mcp_tool', args: { ServerName: 'kitty-hive_hive-channel', ToolName: 'hive-dm-read' } },
  });
  assert.deepEqual(allowMcp, { decision: 'allow' });

  const allowRelay = await runHookScript(hookScript, socketPath, {
    hookEventName: 'PreToolUse',
    toolCall: { name: 'run_command', args: { CommandLine: 'kitty-hive agy-relay' } },
  });
  assert.deepEqual(allowRelay, { decision: 'allow' });

  const askOther = await runHookScript(hookScript, socketPath, {
    hookEventName: 'PreToolUse',
    toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf /tmp/foo' } },
  });
  assert.deepEqual(askOther, { decision: 'ask' });
  } finally {
    // 关闭服务与中继并清理，避免断言失败时残留事件循环句柄
    ac.abort();
    await bridge.close();
    await relayPromise;
    rmSync(dir, { recursive: true, force: true });
  }
});
