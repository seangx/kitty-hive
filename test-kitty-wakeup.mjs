#!/usr/bin/env node

import { createServer } from 'node:http';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildKittyCodexTurnCompletedPayload,
  buildKittyWakeupPayload,
  notifyKittyCodexTurnCompleted,
  notifyKittyWakeup,
} from './dist/kitty-wakeup.js';
import { createAgent, initDB, listPendingPushes } from './dist/db.js';
import { notifyAgents } from './dist/sessions.js';
import { buildPushMessage } from './dist/preview.js';

const ROOT = join(tmpdir(), `hive-kitty-wakeup-${process.pid}`);
const SOCKET = join(ROOT, 'wakeup.sock');
const DB = join(ROOT, 'hive.db');
let pass = 0;
let fail = 0;

function ok(condition, message) {
  if (condition) { console.log(`  ✓ ${message}`); pass++; }
  else { console.error(`  ✗ ${message}`); fail++; }
}

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

const requests = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    requests.push({
      path: req.url,
      session: req.headers['x-kitty-session'],
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessionId: req.headers['x-kitty-session'] }));
  });
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(SOCKET, resolve);
});
process.env.KITTY_WAKEUP_SOCKET = SOCKET;

const payload = buildPushMessage({
  type: 'dm',
  from: 'sender',
  from_agent_id: 'sender-id',
  event_id: 'dm:42',
  message_id: 42,
});
const payloadWithSecretPreview = JSON.stringify({
  ...JSON.parse(payload),
  preview: 'TOP-SECRET BODY MUST NOT LEAK',
});

console.log('\n=== Privacy-preserving wakeup payload ===');
const visible = buildKittyWakeupPayload(payloadWithSecretPreview);
ok(visible.tool === 'hive' && visible.hook_event_name === 'Notification', 'uses Kitty Notification hook contract');
ok(visible.event_id === 'dm:42' && visible.message.includes('sender'), 'keeps id-only event metadata');
ok(!JSON.stringify(visible).includes('TOP-SECRET'), 'does not forward message body/preview');

console.log('\n=== Unix socket delivery ===');
const direct = await notifyKittyWakeup('abcdef123456', payloadWithSecretPreview);
ok(direct.kind === 'sent', 'accepts Kitty wakeup acknowledgement');
ok(requests[0]?.path === '/wakeup', 'posts to /wakeup');
ok(requests[0]?.session === 'abcdef123456', 'addresses the matching Kitty session');
ok(!JSON.stringify(requests[0]?.body).includes('TOP-SECRET'), 'wire payload remains content-free');

console.log('\n=== Codex turn-completed contract ===');
const codexNotice = {
  status: 'completed',
  threadId: 'thread-123',
  turnId: 'turn-456',
};
const codexPayload = buildKittyCodexTurnCompletedPayload(codexNotice);
ok(
  codexPayload.tool === 'codex'
    && codexPayload.hook_event_name === 'TurnCompleted'
    && codexPayload.notification_type === 'codex_turn_completed',
  'uses the dedicated Codex terminal-event contract',
);
ok(
  codexPayload.status === 'completed'
    && codexPayload.thread_id === 'thread-123'
    && codexPayload.turn_id === 'turn-456',
  'includes only terminal lifecycle identifiers',
);
ok(!('message' in codexPayload), 'does not forward conversation content or synthesize message text');
const codexDelivery = await notifyKittyCodexTurnCompleted('abcdef123456', codexNotice);
ok(codexDelivery.kind === 'sent', 'delivers Codex terminal event through the existing Kitty socket');
ok(requests.at(-1)?.session === 'abcdef123456', 'Codex event uses X-Kitty-Session routing');
ok(requests.at(-1)?.body?.notification_type === 'codex_turn_completed', 'Codex wire payload preserves notification type');

console.log('\n=== Foreground Hive integration ===');
initDB(DB);
const sender = createAgent('sender', 'claude', '', '');
const foreground = createAgent('foreground', 'codex', '', '', {
  externalKey: 'feedface1234',
  eventMode: 'foreground',
});
const automatic = createAgent('automatic', 'codex', '', '', {
  externalKey: 'cafebabe1234',
  eventMode: 'auto',
});

const beforeForeground = requests.length;
await notifyAgents([foreground.id], sender.id, payloadWithSecretPreview);
ok(requests.length === beforeForeground + 1, 'foreground Codex event triggers visible Kitty wakeup');
ok(requests.at(-1)?.session === 'feedface1234', 'integration uses agent external_key');
ok(listPendingPushes(foreground.id).length === 1, 'visible wakeup does not consume or replace unread Hive delivery');

const beforeAutomatic = requests.length;
await notifyAgents([automatic.id], sender.id, payloadWithSecretPreview);
ok(requests.length === beforeAutomatic, 'auto-mode agents do not receive foreground UI wakeups');
ok(listPendingPushes(automatic.id).length === 1, 'auto-mode Hive delivery remains unchanged');

console.log('\n=== Fail-open behavior ===');
const missingKey = await notifyKittyWakeup('', payload, { socketPath: SOCKET });
ok(missingKey.kind === 'unavailable', 'missing Kitty session key is a no-op');
const missingSocket = await notifyKittyWakeup('abcdef123456', payload, {
  socketPath: join(ROOT, 'absent.sock'),
  timeoutMs: 100,
});
ok(missingSocket.kind === 'unavailable', 'missing Kitty app/socket does not fail Hive delivery');

await new Promise(resolve => server.close(resolve));
rmSync(ROOT, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
