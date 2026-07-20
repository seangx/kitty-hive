#!/usr/bin/env node

import {
  OpenCodeClient,
  buildOpenCodePrompt,
  eventDedupKey,
} from './dist/opencode-channel-runtime.js';

let pass = 0;
let fail = 0;
function ok(condition, message) {
  if (condition) { console.log(`  ✓ ${message}`); pass++; }
  else { console.error(`  ✗ ${message}`); fail++; }
}

console.log('\n=== Prompt contract ===');
const dm = {
  type: 'dm', event_id: 'dm:42', message_id: 42,
  from: 'sender', received_at: '2026-07-18T00:00:00.000Z',
};
const prompt = buildOpenCodePrompt(dm, { id: 'agent-1', name: 'worker' });
ok(prompt.includes('hive_dm_read({ message_id: 42'), 'DM prompt requires full-content fetch');
ok(prompt.includes('event_id: evid:dm:42'), 'prompt carries stable event marker');
ok(prompt.includes('received: 2026-07-18T00:00:00.000Z'), 'prompt carries arrival timestamp');
const replayPrompt = buildOpenCodePrompt({
  type: 'dm', event_id: 'dm:43', message_id: 43, replayed: true,
  queued_at: '2026-07-18T00:00:00.000Z', received_at: '2026-07-20T00:00:00.000Z',
}, { id: 'agent-1', name: 'worker' });
ok(replayPrompt.includes('replayed: true') && replayPrompt.includes('stale_delivery: true'), 'replayed OpenCode event is explicitly marked stale');
ok(eventDedupKey({ message_id: 9 }) === 'dm:9', 'message id fallback is stable');
const intro = buildOpenCodePrompt({ type: 'daemon-intro', event_id: 'intro-1' }, { id: 'agent-1', name: 'worker' });
ok(intro.includes('FIRST ACTION: call hive_start') && intro.includes('wait for the first event'), 'new session receives a standalone identity brief');
ok(!intro.includes('hive_inbox'), 'identity brief is not disguised as an inbox event');
const rebind = buildOpenCodePrompt({ type: 'daemon-rebind', event_id: 'rebind-1' }, { id: 'agent-1', name: 'worker' });
ok(rebind.includes('daemon restarted') && rebind.includes('hive_start'), 'resumed session receives a rebind brief');
const rules = buildOpenCodePrompt({ type: 'team-rules-update', team_id: 'team-1' }, { id: 'agent-1', name: 'worker' });
ok(rules.includes('hive_team_info({ team_id: "team-1"'), 'team rules update refreshes team info');

console.log('\n=== Async injection, authentication, and serialization ===');
const calls = [];
let statusCalls = 0;
const fakeFetch = async (url, init = {}) => {
  const u = new URL(url);
  calls.push({ path: u.pathname + u.search, init });
  const auth = new Headers(init.headers).get('Authorization');
  if (auth !== `Basic ${Buffer.from('opencode:secret').toString('base64')}`) {
    return new Response('unauthorized', { status: 401 });
  }
  if (u.pathname === '/session/status') {
    statusCalls++;
    const state = statusCalls === 1 ? {} : statusCalls === 2 ? { ses_test: { type: 'busy' } } : {};
    return Response.json(state);
  }
  if (u.pathname === '/session/ses_test/message' && u.searchParams.get('limit') === '100') {
    return Response.json([]);
  }
  if (u.pathname === '/session/ses_test/prompt_async') {
    const body = JSON.parse(String(init.body));
    ok(!Object.prototype.hasOwnProperty.call(body, 'messageID'), 'never sends caller-defined messageID (OpenCode 1.18 loop regression)');
    ok(body.parts?.[0]?.text === prompt, 'sends the exact event prompt');
    return new Response(null, { status: 204 });
  }
  throw new Error(`unexpected fake URL: ${u}`);
};
const client = new OpenCodeClient('http://127.0.0.1:4999/', 'opencode', 'secret', fakeFetch);
const outcome = await client.inject('ses_test', 'evid:dm:42', prompt, 5_000);
ok(outcome.kind === 'completed', `async turn observed busy→idle (got ${outcome.kind})`);
ok(calls.some(call => call.path === '/session/ses_test/prompt_async'), 'uses prompt_async endpoint');

console.log('\n=== Session-history idempotency ===');
let duplicatePromptPosts = 0;
const duplicateFetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.pathname === '/session/status') return Response.json({});
  if (u.pathname === '/session/ses_test/message') {
    return Response.json([{
      info: { role: 'user' },
      parts: [{ type: 'text', text: 'event_id: evid:dm:42' }],
    }]);
  }
  if (u.pathname.endsWith('/prompt_async')) {
    duplicatePromptPosts++;
    return new Response(null, { status: 204 });
  }
  throw new Error(`unexpected duplicate URL: ${u}`);
};
const duplicateClient = new OpenCodeClient('http://test', 'opencode', 'secret', duplicateFetch);
const duplicate = await duplicateClient.inject('ses_test', 'evid:dm:42', prompt, 2_000);
ok(duplicate.kind === 'skipped_duplicate', `existing event marker skips replay (got ${duplicate.kind})`);
ok(duplicatePromptPosts === 0, 'duplicate does not issue prompt_async');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
