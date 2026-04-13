#!/usr/bin/env node
// End-to-end test for kitty-hive MCP server (stateful mode)

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
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: this.name, version: '1.0' },
    });
    await fetch(BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Mcp-Session-Id': this.sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
  }

  async callTool(name, args = {}) {
    const result = await this._post('tools/call', { name, arguments: args });
    const text = result.content[0].text;
    if (result.isError) throw new Error(text);
    return JSON.parse(text);
  }
}

async function run() {
  console.log('====== 1. Initialize stateful sessions ======');
  const alice = new HiveClient('alice');
  const bob = new HiveClient('bob');
  await alice.init();
  await bob.init();
  console.log(`  Alice session: ${alice.sessionId}`);
  console.log(`  Bob session:   ${bob.sessionId}`);
  console.log(`  Sessions are different: ${alice.sessionId !== bob.sessionId}`);

  console.log('\n====== 2. Register agents (session auto-bound) ======');
  const a = await alice.callTool('hive.start', { name: 'Alice', roles: 'ux,frontend' });
  console.log(`  Alice: ${a.agent_id}`);
  const b = await bob.callTool('hive.start', { name: 'Bob', roles: 'backend' });
  console.log(`  Bob:   ${b.agent_id}`);

  console.log('\n====== 3. Alice DMs Bob (no `as` needed — session bound) ======');
  const dm = await alice.callTool('hive.dm', { to: 'Bob', content: '你好 Bob！' });
  console.log(`  room_id=${dm.room_id}  event_id=${dm.event_id}`);

  console.log('\n====== 4. Alice creates task → role:backend ======');
  const task = await alice.callTool('hive.task', { to: 'role:backend', title: '实现登录 API' });
  console.log(`  task_id=${task.task_id}  state=${task.state}  assignee=${task.assignee?.display_name}`);

  console.log('\n====== 5. Bob updates and completes task (no `as` needed) ======');
  await bob.callTool('hive.room.post', {
    room_id: task.room_id, type: 'task-update', task_id: task.task_id, content: '正在写',
  });
  await bob.callTool('hive.room.post', {
    room_id: task.room_id, type: 'task-complete', task_id: task.task_id, content: '搞定了',
  });
  const check = await alice.callTool('hive.check', { task_id: task.task_id });
  console.log(`  final state: ${check.state}`);

  console.log('\n====== 6. Bob lists rooms (session-based auth) ======');
  const rooms = await bob.callTool('hive.room.list', {});
  console.log(`  room count: ${rooms.rooms.length}`);
  for (const r of rooms.rooms) console.log(`    ${r.kind}: ${r.name}`);

  console.log('\n====== 7. Session persistence — Alice reuses session ======');
  const rooms2 = await alice.callTool('hive.room.list', {});
  console.log(`  Alice rooms: ${rooms2.rooms.length}`);

  console.log('\n======================================');
  const pass = check.state === 'completed'
    && task.assignee?.display_name === 'Bob'
    && rooms.rooms.length >= 2
    && alice.sessionId !== bob.sessionId;

  console.log(pass ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED');
  if (!pass) process.exit(1);
}

run().catch(err => { console.error('❌ ERROR:', err.message); process.exit(1); });
