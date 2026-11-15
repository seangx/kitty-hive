#!/usr/bin/env node

import { existsSync, unlinkSync } from 'node:fs';
import {
  activeSSE,
  beginPushHold,
  endPushHold,
  agentSessions,
  declaresEventConsumer,
  drainPushesForAgent,
  eventConsumerAgents,
  eventConsumers,
  livePushSessionsForAgent,
  markEventConsumer,
  notifyAgents,
  sessionAgents,
  sessions,
} from './dist/sessions.js';
import {
  addTeamMember,
  appendDM,
  appendTaskEvent,
  appendTeamEvent,
  createAgent,
  createTask,
  createTeam,
  enqueuePendingPush,
  getReadCursor,
  initDB,
  listPendingPushes,
  setReadCursor,
} from './dist/db.js';
import { getPushDeliveryDecision } from './dist/push-delivery.js';

const DB = `/tmp/hive-push-delivery-${process.pid}.db`;
let pass = 0;
let fail = 0;

function ok(condition, message) {
  if (condition) { console.log(`  ✓ ${message}`); pass++; }
  else { console.error(`  ✗ ${message}`); fail++; }
}

function cleanup() {
  activeSSE.clear();
  eventConsumerAgents.clear();
  eventConsumers.clear();
  agentSessions.clear();
  sessionAgents.clear();
  for (const key of Object.keys(sessions)) delete sessions[key];
  for (const suffix of ['', '-wal', '-shm']) {
    const path = DB + suffix;
    if (existsSync(path)) try { unlinkSync(path); } catch { /* ignore */ }
  }
}
process.on('exit', cleanup);

initDB(DB);
const sender = createAgent('delivery-sender');
const recipient = createAgent('delivery-recipient');

console.log('\n=== Event consumer capability ===');
ok(declaresEventConsumer('codex-channel', undefined), 'legacy channel client name remains an event consumer');
ok(
  declaresEventConsumer('custom-channel', { 'kitty-hive/event-consumer': {} }),
  'custom client can opt in through the event-consumer capability',
);
ok(
  !declaresEventConsumer('codex-mcp-client', {}),
  'ordinary Codex MCP tool client is not an event consumer',
);

console.log('\n=== Forward-only read watermarks ===');
const firstDm = appendDM(sender.id, recipient.id, 'first');
let decision = getPushDeliveryDecision(recipient.id, {
  event_id: `dm:${firstDm.id}`,
  message_id: firstDm.id,
});
ok(decision.deliver && decision.reason === 'unread', 'unread DM is deliverable');
setReadCursor(recipient.id, 'dm', sender.id, firstDm.id);
setReadCursor(recipient.id, 'dm', sender.id, firstDm.id - 1);
ok(getReadCursor(recipient.id, 'dm', sender.id) === firstDm.id, 'older writes cannot regress a read cursor');
decision = getPushDeliveryDecision(recipient.id, { message_id: firstDm.id });
ok(!decision.deliver && decision.reason === 'already_read', 'read DM is suppressed');

console.log('\n=== Task state seq suppresses stale queued transitions ===');
const task = createTask('delivery task', sender.id, { assigneeId: recipient.id });
const taskStart = appendTaskEvent(task.id, 'task-start', sender.id, {});
decision = getPushDeliveryDecision(recipient.id, {
  event_id: `task:${task.id}:task-assigned:${taskStart.seq}`,
  task_id: task.id,
});
ok(decision.deliver && decision.reason === 'unread', 'current task seq is deliverable');
const taskComplete = appendTaskEvent(task.id, 'task-complete', sender.id, {});
decision = getPushDeliveryDecision(recipient.id, {
  event_id: `task:${task.id}:task-assigned:${taskStart.seq}`,
  task_id: task.id,
});
ok(!decision.deliver && decision.reason === 'superseded' && decision.latest_seq === taskComplete.seq, 'higher task seq suppresses stale assignment');
setReadCursor(recipient.id, 'task', task.id, taskComplete.seq);
decision = getPushDeliveryDecision(recipient.id, {
  event_id: `task:${task.id}:task-complete:${taskComplete.seq}`,
  task_id: task.id,
});
ok(!decision.deliver && decision.reason === 'already_read', 'task cursor suppresses an already-read current seq');

console.log('\n=== Team messages remain ordered independent content ===');
const team = createTeam('delivery-team', sender.id);
addTeamMember(team.id, sender.id);
addTeamMember(team.id, recipient.id);
const teamFirst = appendTeamEvent(team.id, 'message', sender.id, { content: 'one' });
const teamSecond = appendTeamEvent(team.id, 'message', sender.id, { content: 'two' });
decision = getPushDeliveryDecision(recipient.id, {
  event_id: `team:${team.id}:team-message:${teamFirst.seq}`,
  team_id: team.id,
});
ok(decision.deliver && decision.latest_seq === teamSecond.seq, 'newer team message does not erase earlier unread content');
setReadCursor(recipient.id, 'team', team.id, teamFirst.seq);
decision = getPushDeliveryDecision(recipient.id, {
  event_id: `team:${team.id}:team-message:${teamFirst.seq}`,
  team_id: team.id,
});
ok(!decision.deliver && decision.reason === 'already_read', 'team cursor suppresses consumed seq');

console.log('\n=== Pending replay drain is single-flight and watermark-aware ===');
const liveDm = appendDM(sender.id, recipient.id, 'live after restart');
enqueuePendingPush(recipient.id, JSON.stringify({
  type: 'dm',
  event_id: `dm:${liveDm.id}`,
  message_id: liveDm.id,
}));
let sends = 0;
let toolSessionSends = 0;
let replayPayload;
const sid = 'push-delivery-test-session';
const toolSid = 'ordinary-mcp-tool-session';
sessions[sid] = {
  server: {
    async sendLoggingMessage(message) {
      sends++;
      replayPayload = JSON.parse(message.data);
      await new Promise(resolve => setTimeout(resolve, 25));
    },
    server: { sendResourceUpdated() {} },
  },
};
sessions[toolSid] = {
  server: {
    async sendLoggingMessage() {
      toolSessionSends++;
    },
    server: { sendResourceUpdated() {} },
  },
};
agentSessions.set(recipient.id, new Set([sid, toolSid]));
sessionAgents.set(sid, recipient.id);
sessionAgents.set(toolSid, recipient.id);
activeSSE.add(sid);
activeSSE.add(toolSid);
markEventConsumer(sid);
ok(
  JSON.stringify(livePushSessionsForAgent(recipient.id)) === JSON.stringify([sid]),
  'explicit event consumer excludes an ordinary MCP SSE session',
);
const immediateDm = appendDM(sender.id, recipient.id, 'live event consumer delivery');
await notifyAgents([recipient.id], undefined, JSON.stringify({
  type: 'dm',
  event_id: `dm:${immediateDm.id}`,
  message_id: immediateDm.id,
}));
ok(sends === 1, 'live notification is sent once to the explicit event consumer');
ok(toolSessionSends === 0, 'live notification is not copied to an ordinary MCP SSE session');
sends = 0;
await Promise.all([
  drainPushesForAgent(recipient.id),
  drainPushesForAgent(recipient.id),
]);
ok(sends === 1, `concurrent drain triggers send each row once (got ${sends})`);
ok(toolSessionSends === 0, 'pending replay is not copied to an ordinary MCP SSE session');
ok(replayPayload?.replayed === true && typeof replayPayload?.queued_at === 'string', 'replayed push carries queued_at metadata');
ok(listPendingPushes(recipient.id).length === 0, 'delivered replay row is deleted');

eventConsumers.clear();
ok(
  livePushSessionsForAgent(recipient.id).length === 0,
  'known consumer disconnect does not fall back to an ordinary MCP SSE session',
);
eventConsumers.add(sid);

const legacyRecipient = createAgent('legacy-delivery-recipient');
agentSessions.set(legacyRecipient.id, new Set([toolSid]));
ok(
  JSON.stringify(livePushSessionsForAgent(legacyRecipient.id)) === JSON.stringify([toolSid]),
  'legacy clients without an explicit consumer retain the all-live-SSE fallback',
);

enqueuePendingPush(recipient.id, JSON.stringify({
  type: 'dm',
  event_id: `dm:${firstDm.id}`,
  message_id: firstDm.id,
}));
await drainPushesForAgent(recipient.id);
ok(sends === 1, 'already-read pending DM is deleted without SSE replay');
ok(listPendingPushes(recipient.id).length === 0, 'suppressed stale row is settled');

console.log('\n=== Fresh-context hold: assignment DM goes first, held pushes drain after ===');
const freshRecipient = createAgent('fresh-hold-recipient');
const freshSid = 'fresh-hold-session';
const freshOrder = [];
sessions[freshSid] = {
  server: {
    async sendLoggingMessage(message) { freshOrder.push(JSON.parse(message.data).message_id); },
    server: { sendResourceUpdated() {} },
  },
};
agentSessions.set(freshRecipient.id, new Set([freshSid]));
sessionAgents.set(freshSid, freshRecipient.id);
activeSSE.add(freshSid);
markEventConsumer(freshSid);
beginPushHold(freshRecipient.id);
const otherDm = appendDM(sender.id, freshRecipient.id, 'arrives during the clear');
await notifyAgents([freshRecipient.id], undefined, JSON.stringify({ type: 'dm', event_id: `dm:${otherDm.id}`, message_id: otherDm.id }));
await drainPushesForAgent(freshRecipient.id);
ok(freshOrder.length === 0, 'held push is neither sent live nor drained during the hold');
ok(listPendingPushes(freshRecipient.id).length === 1, 'held push is persisted');
const assignmentDm = appendDM(sender.id, freshRecipient.id, 'new assignment');
await notifyAgents([freshRecipient.id], undefined, JSON.stringify({ type: 'dm', event_id: `dm:${assignmentDm.id}`, message_id: assignmentDm.id }), { bypassHold: true });
endPushHold(freshRecipient.id);
for (let i = 0; i < 50 && freshOrder.length < 2; i++) await new Promise(r => setTimeout(r, 10));
ok(
  JSON.stringify(freshOrder) === JSON.stringify([assignmentDm.id, otherDm.id]),
  `assignment DM is delivered before the held push (got ${JSON.stringify(freshOrder)})`,
);
ok(listPendingPushes(freshRecipient.id).length === 0, 'held push is settled after the hold ends');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
