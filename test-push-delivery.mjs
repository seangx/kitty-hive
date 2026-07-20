#!/usr/bin/env node

import { existsSync, unlinkSync } from 'node:fs';
import {
  activeSSE,
  agentSessions,
  drainPushesForAgent,
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
  agentSessions.clear();
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
let replayPayload;
const sid = 'push-delivery-test-session';
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
agentSessions.set(recipient.id, new Set([sid]));
activeSSE.add(sid);
await Promise.all([
  drainPushesForAgent(recipient.id),
  drainPushesForAgent(recipient.id),
]);
ok(sends === 1, `concurrent drain triggers send each row once (got ${sends})`);
ok(replayPayload?.replayed === true && typeof replayPayload?.queued_at === 'string', 'replayed push carries queued_at metadata');
ok(listPendingPushes(recipient.id).length === 0, 'delivered replay row is deleted');

enqueuePendingPush(recipient.id, JSON.stringify({
  type: 'dm',
  event_id: `dm:${firstDm.id}`,
  message_id: firstDm.id,
}));
await drainPushesForAgent(recipient.id);
ok(sends === 1, 'already-read pending DM is deleted without SSE replay');
ok(listPendingPushes(recipient.id).length === 0, 'suppressed stale row is settled');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
