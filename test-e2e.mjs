#!/usr/bin/env node
// End-to-end test for kitty-hive v2 (stateful mode)

const BASE = 'http://localhost:4100/mcp';
let idCounter = 0;

class HiveClient {
  constructor(name) { this.name = name; this.sessionId = null; }

  async _post(method, params = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const res = await fetch(BASE, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++idCounter, method, params }),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const text = await res.text();
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) {
        const data = JSON.parse(line.slice(5));
        if (data.error) throw new Error(JSON.stringify(data.error));
        return data.result;
      }
    }
    const data = JSON.parse(text);
    if (data.error) throw new Error(JSON.stringify(data.error));
    return data.result;
  }

  async init() {
    await this._post('initialize', {
      protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: this.name, version: '1.0' },
    });
    await fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Mcp-Session-Id': this.sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
  }

  async callTool(name, args = {}) {
    const result = await this._post('tools/call', { name, arguments: args });
    const text = result.content[0].text;
    if (result.isError) throw new Error(text);
    try { return JSON.parse(text); } catch { return text; }
  }
}

function assert(cond, msg) {
  if (!cond) { console.error(`  FAIL: ${msg}`); process.exit(1); }
  console.log(`  OK: ${msg}`);
}

async function run() {
  console.log('=== 1. Init sessions ===');
  const alice = new HiveClient('alice');
  const bob = new HiveClient('bob');
  await alice.init();
  await bob.init();

  console.log('\n=== 2. Register agents ===');
  const a = await alice.callTool('hive.start', { name: 'Alice', roles: 'ux,frontend' });
  const b = await bob.callTool('hive.start', { name: 'Bob', roles: 'backend' });
  assert(a.agent_id && b.agent_id, 'agents registered');

  console.log('\n=== 3. DM ===');
  const dm = await alice.callTool('hive.dm', { to: 'Bob', content: 'Hello Bob!' });
  assert(dm.room_id && dm.event_id, 'DM sent');

  console.log('\n=== 4. Create task ===');
  const task = await alice.callTool('hive.task', { to: 'role:backend', title: 'Fix auth bug' });
  assert(task.task_id, 'task created');
  assert(task.status === 'proposing', `task status = ${task.status}`);
  assert(task.assignee?.display_name === 'Bob', `assignee = ${task.assignee?.display_name}`);

  console.log('\n=== 5. Check task ===');
  const check = await alice.callTool('hive.check', { task_id: task.task_id });
  assert(check.status === 'proposing', `check status = ${check.status}`);

  console.log('\n=== 6. Team ===');
  const team = await alice.callTool('hive.team.create', { name: 'Frontend Team' });
  assert(team.room_id, 'team created');
  const join = await bob.callTool('hive.team.join', { room_id: team.room_id });
  assert(join.room_id === team.room_id, 'Bob joined team');
  const teams = await alice.callTool('hive.team.list');
  assert(teams.teams.length >= 1, `${teams.teams.length} teams`);

  console.log('\n=== 7. Room list ===');
  const rooms = await bob.callTool('hive.room.list', {});
  assert(rooms.rooms.length >= 2, `Bob has ${rooms.rooms.length} rooms`);

  console.log('\n=== 8. Inbox ===');
  const inbox = await bob.callTool('hive.inbox', {});
  // May or may not have unread depending on timing
  assert(Array.isArray(inbox), 'inbox returned array');

  console.log('\n==============================');
  console.log('ALL TESTS PASSED');
}

run().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
