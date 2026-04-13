import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import type { Agent, Room, RoomEvent, EventType } from './models.js';
import { ulid, generateToken, nowISO } from './utils.js';

let db: Database.Database;

export function initDB(dbPath?: string): Database.Database {
  const resolvedPath = dbPath || join(homedir(), '.kitty-hive', 'hive.db');
  mkdirSync(join(resolvedPath, '..'), { recursive: true });

  db = new Database(resolvedPath);

  // WAL mode for concurrent reads
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('cache_size = -8192'); // 8MB

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
    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);

    CREATE TABLE IF NOT EXISTS rooms (
      id              TEXT PRIMARY KEY,
      name            TEXT,
      kind            TEXT NOT NULL
                      CHECK(kind IN ('dm','team','task','project','lobby')),
      host_agent_id   TEXT REFERENCES agents(id),
      parent_room_id  TEXT REFERENCES rooms(id),
      metadata_json   TEXT DEFAULT '{}',
      created_at      TEXT NOT NULL,
      closed_at       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rooms_kind ON rooms(kind);
    CREATE INDEX IF NOT EXISTS idx_rooms_host ON rooms(host_agent_id);
    CREATE INDEX IF NOT EXISTS idx_rooms_parent ON rooms(parent_room_id);

    CREATE TABLE IF NOT EXISTS room_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id         TEXT NOT NULL REFERENCES rooms(id),
      seq             INTEGER NOT NULL,
      type            TEXT NOT NULL,
      actor_agent_id  TEXT REFERENCES agents(id),
      payload_json    TEXT DEFAULT '{}',
      ts              TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_room_seq ON room_events(room_id, seq);
    CREATE INDEX IF NOT EXISTS idx_events_room_type ON room_events(room_id, type);
    CREATE INDEX IF NOT EXISTS idx_events_actor ON room_events(actor_agent_id);

    CREATE TABLE IF NOT EXISTS read_cursors (
      agent_id  TEXT NOT NULL REFERENCES agents(id),
      room_id   TEXT NOT NULL REFERENCES rooms(id),
      last_seq  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (agent_id, room_id)
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
    id: ulid(),
    display_name: displayName,
    token: generateToken(),
    tool,
    roles,
    expertise,
    status: 'active',
    created_at: nowISO(),
    last_seen: nowISO(),
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

export function createRoom(kind: string, hostAgentId: string | null, name?: string, parentRoomId?: string, metadata?: object): Room {
  const room: Room = {
    id: ulid(),
    name: name ?? null,
    kind: kind as Room['kind'],
    host_agent_id: hostAgentId,
    parent_room_id: parentRoomId ?? null,
    metadata_json: JSON.stringify(metadata ?? {}),
    created_at: nowISO(),
    closed_at: null,
  };
  getDB().prepare(`
    INSERT INTO rooms (id, name, kind, host_agent_id, parent_room_id, metadata_json, created_at, closed_at)
    VALUES (@id, @name, @kind, @host_agent_id, @parent_room_id, @metadata_json, @created_at, @closed_at)
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
      AND EXISTS (
        SELECT 1 FROM room_events e WHERE e.room_id = r.id AND e.type = 'join' AND e.actor_agent_id = ?
      )
      AND EXISTS (
        SELECT 1 FROM room_events e WHERE e.room_id = r.id AND e.type = 'join' AND e.actor_agent_id = ?
      )
    LIMIT 1
  `).get(agentA, agentB) as Room | undefined;
}

// --- Event queries ---

export function appendEvent(roomId: string, type: EventType, actorAgentId: string | null, payload: object = {}): RoomEvent {
  const d = getDB();
  const maxSeq = d.prepare('SELECT COALESCE(MAX(seq), 0) as max_seq FROM room_events WHERE room_id = ?').get(roomId) as { max_seq: number };
  const seq = maxSeq.max_seq + 1;
  const ts = nowISO();
  const payloadJson = JSON.stringify(payload);

  const result = d.prepare(`
    INSERT INTO room_events (room_id, seq, type, actor_agent_id, payload_json, ts)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(roomId, seq, type, actorAgentId, payloadJson, ts);

  return {
    id: result.lastInsertRowid as number,
    room_id: roomId,
    seq,
    type,
    actor_agent_id: actorAgentId,
    payload_json: payloadJson,
    ts,
  };
}

export function getEvents(roomId: string, since: number = 0, limit: number = 50): RoomEvent[] {
  return getDB().prepare(
    'SELECT * FROM room_events WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
  ).all(roomId, since, limit) as RoomEvent[];
}

export function getTaskEvents(taskId: string): RoomEvent[] {
  return getDB().prepare(
    "SELECT * FROM room_events WHERE payload_json LIKE ? AND type LIKE 'task-%' ORDER BY seq ASC"
  ).all(`%"task_id":"${taskId}"%`) as RoomEvent[];
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
      WHERE e2.room_id = r.id AND e2.type = 'leave' AND e2.actor_agent_id = ?
        AND e2.seq > e.seq
    )
  `;
  const params: any[] = [agentId, agentId];

  if (kind) {
    sql += ' AND r.kind = ?';
    params.push(kind);
  }
  if (activeOnly) {
    sql += ' AND r.closed_at IS NULL';
  }

  return getDB().prepare(sql).all(...params) as Room[];
}

// --- Read cursors ---

export function getReadCursor(agentId: string, roomId: string): number {
  const row = getDB().prepare(
    'SELECT last_seq FROM read_cursors WHERE agent_id = ? AND room_id = ?'
  ).get(agentId, roomId) as { last_seq: number } | undefined;
  return row?.last_seq ?? 0;
}

export function setReadCursor(agentId: string, roomId: string, seq: number): void {
  getDB().prepare(`
    INSERT INTO read_cursors (agent_id, room_id, last_seq) VALUES (?, ?, ?)
    ON CONFLICT(agent_id, room_id) DO UPDATE SET last_seq = excluded.last_seq
  `).run(agentId, roomId, seq);
}

export interface UnreadSummary {
  room_id: string;
  room_name: string | null;
  room_kind: string;
  unread_count: number;
  latest: Array<{ from: string; type: string; preview: string; ts: string }>;
}

export function getUnreadForAgent(agentId: string): UnreadSummary[] {
  const rooms = getAgentRooms(agentId, undefined, true);
  const result: UnreadSummary[] = [];

  for (const room of rooms) {
    const cursor = getReadCursor(agentId, room.id);
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
      try {
        const p = JSON.parse(e.payload_json);
        preview = p.content || p.title || '';
      } catch { /* ignore */ }
      return {
        from: actor?.display_name ?? 'unknown',
        type: e.type,
        preview: preview.length > 100 ? preview.slice(0, 100) + '... [truncated, use hive.room.events to see full message]' : preview,
        ts: e.ts,
      };
    });

    result.push({
      room_id: room.id,
      room_name: room.name,
      room_kind: room.kind,
      unread_count: totalUnread,
      latest,
    });
  }

  return result;
}

// --- Cleanup ---

export function cleanupStaleRooms(maxAgeDays: number = 7): number {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const d = getDB();

  // Find task rooms where the last task event is terminal and older than cutoff
  const staleRooms = d.prepare(`
    SELECT r.id FROM rooms r
    WHERE r.kind = 'task' AND r.closed_at IS NULL
      AND EXISTS (
        SELECT 1 FROM room_events e
        WHERE e.room_id = r.id AND e.type IN ('task-complete', 'task-fail', 'task-cancel')
          AND e.ts < ?
      )
  `).all(cutoff) as Array<{ id: string }>;

  for (const room of staleRooms) {
    d.prepare('DELETE FROM read_cursors WHERE room_id = ?').run(room.id);
    d.prepare('DELETE FROM room_events WHERE room_id = ?').run(room.id);
    d.prepare('DELETE FROM rooms WHERE id = ?').run(room.id);
  }

  return staleRooms.length;
}
