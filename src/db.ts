import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import type { Agent, Room, RoomEvent, RoomEventType, Task, TaskEvent, TaskEventType } from './models.js';
import { ulid, generateToken, nowISO } from './utils.js';

let db: Database.Database;

export function initDB(dbPath?: string): Database.Database {
  const resolvedPath = dbPath || join(homedir(), '.kitty-hive', 'hive.db');
  mkdirSync(join(resolvedPath, '..'), { recursive: true });

  db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('cache_size = -8192');

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id            TEXT PRIMARY KEY,
      display_name  TEXT NOT NULL,
      token         TEXT UNIQUE NOT NULL,
      tool          TEXT DEFAULT '',
      roles         TEXT DEFAULT '',
      expertise     TEXT DEFAULT '',
      status        TEXT DEFAULT 'active'
                    CHECK(status IN ('active','idle','busy','offline')),
      created_at    TEXT NOT NULL,
      last_seen     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agents_token ON agents(token);
    CREATE INDEX IF NOT EXISTS idx_agents_roles ON agents(roles);

    CREATE TABLE IF NOT EXISTS rooms (
      id              TEXT PRIMARY KEY,
      name            TEXT,
      kind            TEXT NOT NULL CHECK(kind IN ('lobby','dm','team')),
      host_agent_id   TEXT REFERENCES agents(id),
      created_at      TEXT NOT NULL,
      closed_at       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rooms_kind ON rooms(kind);

    CREATE TABLE IF NOT EXISTS room_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id         TEXT NOT NULL REFERENCES rooms(id),
      seq             INTEGER NOT NULL,
      type            TEXT NOT NULL CHECK(type IN ('join','leave','message')),
      actor_agent_id  TEXT REFERENCES agents(id),
      payload_json    TEXT DEFAULT '{}',
      ts              TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_room_events_room_seq ON room_events(room_id, seq);

    CREATE TABLE IF NOT EXISTS tasks (
      id                TEXT PRIMARY KEY,
      title             TEXT NOT NULL,
      creator_agent_id  TEXT NOT NULL REFERENCES agents(id),
      assignee_agent_id TEXT REFERENCES agents(id),
      status            TEXT NOT NULL DEFAULT 'created'
                        CHECK(status IN ('created','proposing','approved','in_progress','completed','failed','canceled')),
      workflow_json     TEXT,
      current_step      INTEGER DEFAULT 0,
      source_room_id    TEXT REFERENCES rooms(id),
      input_json        TEXT DEFAULT '{}',
      created_at        TEXT NOT NULL,
      completed_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_creator ON tasks(creator_agent_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_agent_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

    CREATE TABLE IF NOT EXISTS task_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id         TEXT NOT NULL REFERENCES tasks(id),
      seq             INTEGER NOT NULL,
      type            TEXT NOT NULL,
      actor_agent_id  TEXT REFERENCES agents(id),
      payload_json    TEXT DEFAULT '{}',
      ts              TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_events_task_seq ON task_events(task_id, seq);

    CREATE TABLE IF NOT EXISTS read_cursors (
      agent_id    TEXT NOT NULL REFERENCES agents(id),
      target_type TEXT NOT NULL CHECK(target_type IN ('room','task')),
      target_id   TEXT NOT NULL,
      last_seq    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (agent_id, target_type, target_id)
    );
  `);

  return db;
}

export function getDB(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDB() first.');
  return db;
}

// --- Agent queries ---

export function createAgent(displayName: string, tool: string, roles: string, expertise: string): Agent {
  const agent: Agent = {
    id: ulid(), display_name: displayName, token: generateToken(),
    tool, roles, expertise, status: 'active',
    created_at: nowISO(), last_seen: nowISO(),
  };
  getDB().prepare(`
    INSERT INTO agents (id, display_name, token, tool, roles, expertise, status, created_at, last_seen)
    VALUES (@id, @display_name, @token, @tool, @roles, @expertise, @status, @created_at, @last_seen)
  `).run(agent);
  return agent;
}

export function getAgentByToken(token: string): Agent | undefined {
  return getDB().prepare('SELECT * FROM agents WHERE token = ?').get(token) as Agent | undefined;
}

export function getAgentById(id: string): Agent | undefined {
  return getDB().prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent | undefined;
}

export function getAgentByName(name: string): Agent | undefined {
  return getDB().prepare('SELECT * FROM agents WHERE display_name = ?').get(name) as Agent | undefined;
}

export function findAgentByRole(role: string): Agent | undefined {
  return getDB().prepare(
    "SELECT * FROM agents WHERE roles LIKE ? AND status = 'active' ORDER BY last_seen DESC LIMIT 1"
  ).get(`%${role}%`) as Agent | undefined;
}

export function touchAgent(id: string): void {
  getDB().prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(nowISO(), id);
}

// --- Room queries ---

export function createRoom(kind: string, hostAgentId: string | null, name?: string): Room {
  const room: Room = {
    id: ulid(), name: name ?? null, kind: kind as Room['kind'],
    host_agent_id: hostAgentId, created_at: nowISO(), closed_at: null,
  };
  getDB().prepare(`
    INSERT INTO rooms (id, name, kind, host_agent_id, created_at, closed_at)
    VALUES (@id, @name, @kind, @host_agent_id, @created_at, @closed_at)
  `).run(room);
  return room;
}

export function getRoomById(id: string): Room | undefined {
  return getDB().prepare('SELECT * FROM rooms WHERE id = ?').get(id) as Room | undefined;
}

export function getLobby(): Room | undefined {
  return getDB().prepare("SELECT * FROM rooms WHERE kind = 'lobby' LIMIT 1").get() as Room | undefined;
}

export function findDMRoom(agentA: string, agentB: string): Room | undefined {
  return getDB().prepare(`
    SELECT r.* FROM rooms r
    WHERE r.kind = 'dm'
      AND EXISTS (SELECT 1 FROM room_events e WHERE e.room_id = r.id AND e.type = 'join' AND e.actor_agent_id = ?)
      AND EXISTS (SELECT 1 FROM room_events e WHERE e.room_id = r.id AND e.type = 'join' AND e.actor_agent_id = ?)
    LIMIT 1
  `).get(agentA, agentB) as Room | undefined;
}

export function listTeams(): Room[] {
  return getDB().prepare("SELECT * FROM rooms WHERE kind = 'team' AND closed_at IS NULL ORDER BY created_at DESC").all() as Room[];
}

// --- Room event queries ---

export function appendRoomEvent(roomId: string, type: RoomEventType, actorAgentId: string | null, payload: object = {}): RoomEvent {
  const d = getDB();
  const ts = nowISO();
  const payloadJson = JSON.stringify(payload);
  const insert = d.transaction(() => {
    const maxSeq = d.prepare('SELECT COALESCE(MAX(seq), 0) as max_seq FROM room_events WHERE room_id = ?').get(roomId) as { max_seq: number };
    const seq = maxSeq.max_seq + 1;
    const result = d.prepare('INSERT INTO room_events (room_id, seq, type, actor_agent_id, payload_json, ts) VALUES (?, ?, ?, ?, ?, ?)').run(roomId, seq, type, actorAgentId, payloadJson, ts);
    return { id: result.lastInsertRowid as number, seq };
  });
  const { id, seq } = insert();
  return { id, room_id: roomId, seq, type, actor_agent_id: actorAgentId, payload_json: payloadJson, ts };
}

export function getRoomEvents(roomId: string, since: number = 0, limit: number = 50): RoomEvent[] {
  return getDB().prepare('SELECT * FROM room_events WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?').all(roomId, since, limit) as RoomEvent[];
}

export function getLastRoomEventTs(roomId: string): string | null {
  const row = getDB().prepare('SELECT ts FROM room_events WHERE room_id = ? ORDER BY seq DESC LIMIT 1').get(roomId) as { ts: string } | undefined;
  return row?.ts ?? null;
}

export function getLatestRoomEvents(roomId: string, limit: number = 10): RoomEvent[] {
  return getDB().prepare('SELECT * FROM (SELECT * FROM room_events WHERE room_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC').all(roomId, limit) as RoomEvent[];
}

export function getRoomMembers(roomId: string): string[] {
  const events = getDB().prepare(
    "SELECT type, actor_agent_id FROM room_events WHERE room_id = ? AND type IN ('join', 'leave') ORDER BY seq ASC"
  ).all(roomId) as Array<{ type: string; actor_agent_id: string }>;
  const members = new Set<string>();
  for (const e of events) {
    if (e.type === 'join') members.add(e.actor_agent_id);
    if (e.type === 'leave') members.delete(e.actor_agent_id);
  }
  return [...members];
}

export function isMember(roomId: string, agentId: string): boolean {
  return getRoomMembers(roomId).includes(agentId);
}

export function getAgentRooms(agentId: string, kind?: string, activeOnly?: boolean): Room[] {
  let sql = `
    SELECT DISTINCT r.* FROM rooms r
    JOIN room_events e ON e.room_id = r.id AND e.type = 'join' AND e.actor_agent_id = ?
    WHERE NOT EXISTS (
      SELECT 1 FROM room_events e2
      WHERE e2.room_id = r.id AND e2.type = 'leave' AND e2.actor_agent_id = ? AND e2.seq > e.seq
    )
  `;
  const params: any[] = [agentId, agentId];
  if (kind) { sql += ' AND r.kind = ?'; params.push(kind); }
  if (activeOnly) { sql += ' AND r.closed_at IS NULL'; }
  return getDB().prepare(sql).all(...params) as Room[];
}

// --- Task queries ---

export function createTask(title: string, creatorId: string, assigneeId?: string, sourceRoomId?: string, input?: object): Task {
  const task: Task = {
    id: ulid(), title, creator_agent_id: creatorId,
    assignee_agent_id: assigneeId ?? null,
    status: 'created', workflow_json: null, current_step: 0,
    source_room_id: sourceRoomId ?? null,
    input_json: JSON.stringify(input ?? {}),
    created_at: nowISO(), completed_at: null,
  };
  getDB().prepare(`
    INSERT INTO tasks (id, title, creator_agent_id, assignee_agent_id, status, workflow_json, current_step, source_room_id, input_json, created_at, completed_at)
    VALUES (@id, @title, @creator_agent_id, @assignee_agent_id, @status, @workflow_json, @current_step, @source_room_id, @input_json, @created_at, @completed_at)
  `).run(task);
  return task;
}

export function getTaskById(id: string): Task | undefined {
  return getDB().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
}

export function updateTaskStatus(id: string, status: string, extras?: Record<string, any>): void {
  let sql = 'UPDATE tasks SET status = ?';
  const params: any[] = [status];
  if (extras) {
    for (const [k, v] of Object.entries(extras)) {
      sql += `, ${k} = ?`;
      params.push(v);
    }
  }
  sql += ' WHERE id = ?';
  params.push(id);
  getDB().prepare(sql).run(...params);
}

export function getAgentTasks(agentId: string, status?: string): Task[] {
  let sql = 'SELECT * FROM tasks WHERE (creator_agent_id = ? OR assignee_agent_id = ?)';
  const params: any[] = [agentId, agentId];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY created_at DESC';
  return getDB().prepare(sql).all(...params) as Task[];
}

// --- Task event queries ---

export function appendTaskEvent(taskId: string, type: TaskEventType, actorAgentId: string | null, payload: object = {}): TaskEvent {
  const d = getDB();
  const ts = nowISO();
  const payloadJson = JSON.stringify(payload);
  const insert = d.transaction(() => {
    const maxSeq = d.prepare('SELECT COALESCE(MAX(seq), 0) as max_seq FROM task_events WHERE task_id = ?').get(taskId) as { max_seq: number };
    const seq = maxSeq.max_seq + 1;
    const result = d.prepare('INSERT INTO task_events (task_id, seq, type, actor_agent_id, payload_json, ts) VALUES (?, ?, ?, ?, ?, ?)').run(taskId, seq, type, actorAgentId, payloadJson, ts);
    return { id: result.lastInsertRowid as number, seq };
  });
  const { id, seq } = insert();
  return { id, task_id: taskId, seq, type, actor_agent_id: actorAgentId, payload_json: payloadJson, ts };
}

export function getTaskEvents(taskId: string, since: number = 0, limit: number = 100): TaskEvent[] {
  return getDB().prepare('SELECT * FROM task_events WHERE task_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?').all(taskId, since, limit) as TaskEvent[];
}

// --- Read cursors ---

export function getReadCursor(agentId: string, targetType: string, targetId: string): number {
  const row = getDB().prepare(
    'SELECT last_seq FROM read_cursors WHERE agent_id = ? AND target_type = ? AND target_id = ?'
  ).get(agentId, targetType, targetId) as { last_seq: number } | undefined;
  return row?.last_seq ?? 0;
}

export function setReadCursor(agentId: string, targetType: string, targetId: string, seq: number): void {
  getDB().prepare(`
    INSERT INTO read_cursors (agent_id, target_type, target_id, last_seq) VALUES (?, ?, ?, ?)
    ON CONFLICT(agent_id, target_type, target_id) DO UPDATE SET last_seq = excluded.last_seq
  `).run(agentId, targetType, targetId, seq);
}

// --- Inbox ---

export interface UnreadSummary {
  type: 'room' | 'task';
  id: string;
  name: string | null;
  kind: string;
  unread_count: number;
  latest: Array<{ from: string; type: string; preview: string; ts: string }>;
}

export function getUnreadForAgent(agentId: string): UnreadSummary[] {
  const result: UnreadSummary[] = [];

  // Room unread
  const rooms = getAgentRooms(agentId, undefined, true);
  for (const room of rooms) {
    const cursor = getReadCursor(agentId, 'room', room.id);
    const unread = getDB().prepare(
      'SELECT * FROM room_events WHERE room_id = ? AND seq > ? AND actor_agent_id != ? ORDER BY seq ASC LIMIT 10'
    ).all(room.id, cursor, agentId) as RoomEvent[];
    if (unread.length === 0) continue;
    const totalUnread = (getDB().prepare(
      'SELECT COUNT(*) as cnt FROM room_events WHERE room_id = ? AND seq > ? AND actor_agent_id != ?'
    ).get(room.id, cursor, agentId) as { cnt: number }).cnt;
    const latest = unread.slice(-5).map(e => {
      const actor = getAgentById(e.actor_agent_id ?? '');
      let preview = '';
      try { const p = JSON.parse(e.payload_json); preview = p.content || ''; } catch {}
      return {
        from: actor?.display_name ?? 'unknown', type: e.type,
        preview,
        ts: e.ts,
      };
    });
    result.push({ type: 'room', id: room.id, name: room.name, kind: room.kind, unread_count: totalUnread, latest });
  }

  // Task unread
  const tasks = getAgentTasks(agentId);
  for (const task of tasks) {
    if (['completed', 'failed', 'canceled'].includes(task.status)) continue;
    const cursor = getReadCursor(agentId, 'task', task.id);
    const unread = getDB().prepare(
      'SELECT * FROM task_events WHERE task_id = ? AND seq > ? AND actor_agent_id != ? ORDER BY seq ASC LIMIT 10'
    ).all(task.id, cursor, agentId) as TaskEvent[];
    if (unread.length === 0) continue;
    const totalUnread = (getDB().prepare(
      'SELECT COUNT(*) as cnt FROM task_events WHERE task_id = ? AND seq > ? AND actor_agent_id != ?'
    ).get(task.id, cursor, agentId) as { cnt: number }).cnt;
    const latest = unread.slice(-5).map(e => {
      const actor = getAgentById(e.actor_agent_id ?? '');
      let preview = '';
      try { const p = JSON.parse(e.payload_json); preview = p.result || p.reason || ''; } catch {}
      return {
        from: actor?.display_name ?? 'system', type: e.type,
        preview: preview.length > 100 ? preview.slice(0, 100) + '...' : preview,
        ts: e.ts,
      };
    });
    result.push({ type: 'task', id: task.id, name: task.title, kind: task.status, unread_count: totalUnread, latest });
  }

  return result;
}

// --- Cleanup ---

export function cleanupStaleTasks(maxAgeDays: number = 7): number {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const d = getDB();
  const stale = d.prepare(
    "SELECT id FROM tasks WHERE status IN ('completed','failed','canceled') AND completed_at IS NOT NULL AND completed_at < ?"
  ).all(cutoff) as Array<{ id: string }>;
  for (const t of stale) {
    d.prepare('DELETE FROM read_cursors WHERE target_type = ? AND target_id = ?').run('task', t.id);
    d.prepare('DELETE FROM task_events WHERE task_id = ?').run(t.id);
    d.prepare('DELETE FROM tasks WHERE id = ?').run(t.id);
  }
  return stale.length;
}
