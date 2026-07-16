#!/usr/bin/env node
// Unit tests for the headless server→client request policy
// (answerServerRequest / synthesizeElicitationContent in
// codex-channel-runtime).
//
// Root incident 2026-07-15: codex 0.144 update routes MCP tool approvals as
// mcpServer/elicitation/request JSON-RPC REQUESTS over the app-server WS.
// The daemon ignored all incoming requests → every approval-gated hive tool
// call blocked its turn forever → 10-min tracker timeouts → all pushes
// looked dead (user's 23 approval_mode="approve" entries in
// ~/.codex/config.toml gated nearly every hive tool).
//
// Policy under test:
//   1. hive elicitation → accept, content synthesized from requestedSchema
//   2. non-hive elicitation → decline
//   3. exec/patch approval requests → decline (headless never self-grants)
//   4. permissions request → empty grant, turn scope
//   5. unknown request → JSON-RPC error (never silence)
//   6. content synthesis: affirmative enums preferred; persist picks
//      'session' over 'always'; booleans true; defaults honored

import { answerServerRequest, synthesizeElicitationContent } from './dist/codex-channel-runtime.js';

const OWN = () => true;          // daemon started this turn
const NOT_OWN = () => false;     // pane/human turn — daemon must stay silent

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.error(`  ✗ ${msg}`); fail++; }
}

console.log('=== 1. hive elicitation → accept ===');
{
  const a = answerServerRequest('mcpServer/elicitation/request', {
    serverName: 'hive', mode: 'form', message: 'Allow hive_dm_read?',
    requestedSchema: { type: 'object', properties: { decision: { enum: ['approve', 'deny'] } } },
  }, NOT_OWN); // hive accepts regardless of ownership
  ok(a.kind === 'result', 'kind=result');
  ok(a.payload.action === 'accept', `action=accept (got ${a.payload.action})`);
  ok(a.payload.content.decision === 'approve', `content.decision=approve (got ${a.payload.content.decision})`);
}

console.log('=== 2. non-hive elicitation → decline ===');
{
  const a = answerServerRequest('mcpServer/elicitation/request', { serverName: 'context7', mode: 'form', message: 'x', turnId: 't1' }, OWN);
  ok(a.kind === 'result' && a.payload.action === 'decline' && a.payload.content === null,
    `declined with null content (got ${JSON.stringify(a.payload)})`);
}

console.log('=== 3. exec/patch approvals → decline ===');
for (const m of ['item/commandExecution/requestApproval', 'execCommandApproval', 'applyPatchApproval']) {
  const a = answerServerRequest(m, { reason: 'wants shell', command: 'rm -rf /', turnId: 't1' }, OWN);
  ok(a.kind === 'result' && a.payload.decision === 'decline', `${m} → decision=decline`);
}

console.log('=== 4. permissions request → empty turn-scoped grant ===');
{
  const a = answerServerRequest('item/permissions/requestApproval', { reason: 'fs write', turnId: 't1' }, OWN);
  ok(a.kind === 'result' && a.payload.scope === 'turn' && JSON.stringify(a.payload.permissions) === '{}',
    `empty grant (got ${JSON.stringify(a.payload)})`);
}

console.log('=== 5. unknown request → JSON-RPC error, never silence ===');
{
  const a = answerServerRequest('some/future/method', { turnId: 't1' }, OWN);
  ok(a.kind === 'error' && a.payload.code === -32601, `error -32601 (got ${JSON.stringify(a.payload)})`);
}


console.log('=== 5b. OWNERSHIP GATE: pane turns are never answered ===');
// 2026-07-16 monkeys-cli incident: a human pane attached to the daemon's
// app-server had every shell approval auto-declined out from under them.
{
  for (const m of ['item/commandExecution/requestApproval', 'execCommandApproval', 'applyPatchApproval', 'item/permissions/requestApproval']) {
    const a = answerServerRequest(m, { reason: 'user working in pane', turnId: 'pane-turn' }, NOT_OWN);
    ok(a.kind === 'ignore', `${m} on pane turn → ignore (got ${a.kind})`);
  }
  const e = answerServerRequest('mcpServer/elicitation/request', { serverName: 'context7', turnId: 'pane-turn' }, NOT_OWN);
  ok(e.kind === 'ignore', `non-hive elicitation on pane turn → ignore (got ${e.kind})`);
  const h = answerServerRequest('mcpServer/elicitation/request', { serverName: 'hive', turnId: 'pane-turn' }, NOT_OWN);
  ok(h.kind === 'result' && h.payload.action === 'accept', 'hive elicitation accepted even on pane turn (our server)');
  const u = answerServerRequest('some/future/method', { turnId: 'pane-turn' }, NOT_OWN);
  ok(u.kind === 'ignore', `unknown method on pane turn → ignore (got ${u.kind})`);
  const noTurn = answerServerRequest('item/commandExecution/requestApproval', { reason: 'no turn id' }, NOT_OWN);
  ok(noTurn.kind === 'ignore', 'missing turnId treated as not-ours (conservative)');
}

console.log('=== 6. content synthesis details ===');
{
  const c = synthesizeElicitationContent({
    type: 'object',
    properties: {
      decision: { enum: ['deny', 'approve'] },          // affirmative wins over order
      persist: { enum: ['always', 'session'] },          // session preferred over always
      confirm: { type: 'boolean' },
      note: { type: 'string', default: 'keep-me' },
      count: { type: 'integer' },
      freeform: { type: 'string' },
    },
  });
  ok(c.decision === 'approve', `enum affirmative: ${c.decision}`);
  ok(c.persist === 'session', `persist=session, NOT always (got ${c.persist})`);
  ok(c.confirm === true, `boolean → true`);
  ok(c.note === 'keep-me', `default honored`);
  ok(c.count === 0, `integer → 0`);
  ok(c.freeform === 'approve', `fallback string`);
  ok(JSON.stringify(synthesizeElicitationContent(undefined)) === '{}', 'no schema → {}');
  ok(JSON.stringify(synthesizeElicitationContent({ type: 'object' })) === '{}', 'no properties → {}');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
