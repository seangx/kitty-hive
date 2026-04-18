import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import type { Agent, Team, TeamMember, TeamEvent, TeamEventType, DMMessage, Task, TaskEvent, TaskEventType } from './models.js';
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

    CREATE TABLE IF NOT EXISTS teams (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL UNIQUE,
      host_agent_id   TEXT REFERENCES agents(id),
      created_at      TEXT NOT NULL,
      closed_at       TEXT
    );

    CREATE TABLE IF NOT EXISTS team_members (
      team_id     TEXT NOT NULL REFERENCES teams(id),
      agent_id    TEXT NOT NULL REFERENCES agents(id),
      nickname    TEXT,
      joined_at   TEXT NOT NULL,
      PRIMARY KEY (team_id, agent_id),
      UNIQUE (team_id, nickname)
    );
    CREATE INDEX IF NOT EXISTS idx_team_members_agent ON team_members(agent_id);

    CREATE TABLE IF NOT EXISTS team_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id         TEXT NOT NULL REFERENCES teams(id),
      seq             INTEGER NOT NULL,
      type            TEXT NOT NULL CHECK(type IN ('join','leave','message','rename')),
      actor_agent_id  TEXT REFERENCES agents(id),
      payload_json    TEXT DEFAULT '{}',
      ts              TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_team_events_team_seq ON team_events(team_id, seq);

    CREATE TABLE IF NOT EXISTS dm_messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      seq             INTEGER NOT NULL,
      from_agent_id   TEXT NOT NULL REFERENCES agents(id),
      to_agent_id     TEXT NOT NULL REFERENCES agents(id),
      content         TEXT NOT NULL,
      ts              TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dm_to_seq ON dm_messages(to_agent_id, seq);
    CREATE INDEX IF NOT EXISTS idx_dm_from_seq ON dm_messages(from_agent_id, seq);

    CREATE TABLE IF NOT EXISTS tasks (
      id                TEXT PRIMARY KEY,
      title             TEXT NOT NULL,
      creator_agent_id  TEXT NOT NULL REFERENCES agents(id),
      assignee_agent_id TEXT REFERENCES agents(id),
      status            TEXT NOT NULL DEFAULT 'created'
                        CHECK(status IN ('created','proposing','approved','in_progress','completed','failed','canceled')),
      workflow_json     TEXT,
      current_step      INTEGER DEFAULT 0,
      source_team_id    TEXT REFERENCES teams(id),
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
      target_type TEXT NOT NULL CHECK(target_type IN ('team','task','dm')),
      target_id   TEXT NOT NULL,
      last_seq    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (agent_id, target_type, target_id)
    );

    CREATE TABLE IF NOT EXISTS peers (
      id          TEXT PRIMARY KEY,
      name        TEXT UNIQUE NOT NULL,
      url         TEXT NOT NULL,
      secret      TEXT NOT NULL,
      exposed     TEXT DEFAULT '',
      status      TEXT DEFAULT 'active' CHECK(status IN ('active','inactive')),
      created_at  TEXT NOT NULL,
      last_seen   TEXT
    );

    CREATE TABLE IF NOT EXISTS pending_invites (
      token_id           TEXT PRIMARY KEY,
      secret             TEXT NOT NULL,
      exposed_agent_id   TEXT NOT NULL,
      url                TEXT NOT NULL,
      created_at         TEXT NOT NULL,
      expires_at         TEXT NOT NULL
    );
  `);

  // Idempotent column migrations for federation fields
  function addColumnIfMissing(table: string, column: string, decl: string) {
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
  addColumnIfMissing('agents', 'origin_peer', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing('agents', 'remote_id', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing('tasks', 'originator_peer', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing('tasks', 'originator_task_id', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing('tasks', 'delegated_peer', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing('tasks', 'delegated_task_id', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing('peers', 'node_name', "TEXT NOT NULL DEFAULT ''");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agents_remote ON agents(origin_peer, remote_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_delegated ON tasks(delegated_peer, delegated_task_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_originator ON tasks(originator_peer, originator_task_id);
  `);

  return db;
}

export function getDB(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDB() first.');
  return db;
}

// --- Agent queries ---

export function createAgent(displayName: string, tool: string, roles: string, expertise: string, originPeer: string = '', remoteId: string = ''): Agent {
  const agent: Agent = {
    id: ulid(), display_name: displayName, token: generateToken(),
    tool, roles, expertise, status: 'active',
    created_at: nowISO(), last_seen: nowISO(),
    origin_peer: originPeer, remote_id: remoteId,
  };
  getDB().prepare(`
    INSERT INTO agents (id, display_name, token, tool, roles, expertise, status, created_at, last_seen, origin_peer, remote_id)
    VALUES (@id, @display_name, @token, @tool, @roles, @expertise, @status, @created_at, @last_seen, @origin_peer, @remote_id)
  `).run(agent);
  return agent;
}

// Find or create a placeholder agent representing a remote peer's agent.
// Looked up by (origin_peer, remote_id) — stable across rename/restart.
export function ensureRemoteAgentByRemoteId(remoteId: string, peerName: string, displayName: string): Agent {
  const existing = getDB().prepare(
    'SELECT * FROM agents WHERE origin_peer = ? AND remote_id = ?'
  ).get(peerName, remoteId) as Agent | undefined;
  if (existing) {
    if (existing.display_name !== displayName) {
      getDB().prepare('UPDATE agents SET display_name = ?, last_seen = ? WHERE id = ?').run(displayName, nowISO(), existing.id);
      existing.display_name = displayName;
    } else {
      touchAgent(existing.id);
    }
    return existing;
  }
  return createAgent(displayName, 'remote', `peer:${peerName}`, '', peerName, remoteId);
}

export function getAgentByToken(token: string): Agent | undefined {
  return getDB().prepare('SELECT * FROM agents WHERE token = ?').get(token) as Agent | undefined;
}

export function getAgentById(id: string): Agent | undefined {
  return getDB().prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent | undefined;
}

export function getAgentsByName(name: string): Agent[] {
  return getDB().prepare('SELECT * FROM agents WHERE display_name = ?').all(name) as Agent[];
}

export function listAllAgents(activeOnly: boolean = false): Agent[] {
  const sql = activeOnly
    ? "SELECT * FROM agents WHERE status = 'active' ORDER BY last_seen DESC"
    : 'SELECT * FROM agents ORDER BY last_seen DESC';
  return getDB().prepare(sql).all() as Agent[];
}

export function findAgentByRole(role: string): Agent | undefined {
  return getDB().prepare(
    "SELECT * FROM agents WHERE roles LIKE ? AND status = 'active' ORDER BY last_seen DESC LIMIT 1"
  ).get(`%${role}%`) as Agent | undefined;
}

export function touchAgent(id: string): void {
  getDB().prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(nowISO(), id);
}

export function renameAgent(id: string, newName: string): void {
  getDB().prepare('UPDATE agents SET display_name = ? WHERE id = ?').run(newName, id);
}

// --- Address resolution ---
// Resolves "id_or_nickname" to an agent.
// 1) If it matches an agent id directly, use that.
// 2) Otherwise, search nicknames of teams the caller is in.
// 3) Falls back to global display_name (only if exactly 1 match).
// Returns: { agent, source } where source = 'id' | 'team-nickname' | 'display-name' | 'ambiguous' | 'not-found'
export interface ResolvedAgent {
  agent?: Agent;
  source: 'id' | 'team-nickname' | 'display-name';
}

export function resolveAddressee(callerAgentId: string, target: string): ResolvedAgent | { error: string } {
  // 1) direct id
  const byId = getAgentById(target);
  if (byId) return { agent: byId, source: 'id' };

  // 2) nickname in caller's teams
  const nickMatches = getDB().prepare(`
    SELECT DISTINCT a.* FROM agents a
    JOIN team_members tm ON tm.agent_id = a.id
    WHERE tm.nickname = ?
      AND tm.team_id IN (SELECT team_id FROM team_members WHERE agent_id = ?)
  `).all(target, callerAgentId) as Agent[];
  if (nickMatches.length === 1) return { agent: nickMatches[0], source: 'team-nickname' };
  if (nickMatches.length > 1) return { error: `Nickname "${target}" matches multiple agents in your teams. Use agent id instead.` };

  // 3) global display_name
  const nameMatches = getAgentsByName(target);
  if (nameMatches.length === 1) return { agent: nameMatches[0], source: 'display-name' };
  if (nameMatches.length > 1) return { error: `Display name "${target}" matches multiple agents. Use agent id instead.` };

  return { error: `No agent found matching "${target}".` };
}

// --- Team queries ---

export function createTeam(name: string, hostAgentId: string | null): Team {
  const team: Team = {
    id: ulid(), name,
    host_agent_id: hostAgentId,
    created_at: nowISO(), closed_at: null,
  };
  getDB().prepare(`
    INSERT INTO teams (id, name, host_agent_id, created_at, closed_at)
    VALUES (@id, @name, @host_agent_id, @created_at, @closed_at)
  `).run(team);
  return team;
}

export function getTeamById(id: string): Team | undefined {
  return getDB().prepare('SELECT * FROM teams WHERE id = ?').get(id) as Team | undefined;
}

export function getTeamByName(name: string): Team | undefined {
  return getDB().prepare('SELECT * FROM teams WHERE name = ?').get(name) as Team | undefined;
}

export function listTeams(activeOnly: boolean = true): Team[] {
  const sql = activeOnly
    ? 'SELECT * FROM teams WHERE closed_at IS NULL ORDER BY created_at DESC'
    : 'SELECT * FROM teams ORDER BY created_at DESC';
  return getDB().prepare(sql).all() as Team[];
}

export function getAgentTeams(agentId: string, activeOnly: boolean = true): Team[] {
  const sql = activeOnly
    ? `SELECT t.* FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.agent_id = ? AND t.closed_at IS NULL ORDER BY tm.joined_at DESC`
    : `SELECT t.* FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.agent_id = ? ORDER BY tm.joined_at DESC`;
  return getDB().prepare(sql).all(agentId) as Team[];
}

// --- Team membership ---

export function addTeamMember(teamId: string, agentId: string, nickname: string | null = null): TeamMember {
  const member: TeamMember = { team_id: teamId, agent_id: agentId, nickname, joined_at: nowISO() };
  getDB().prepare(`
    INSERT INTO team_members (team_id, agent_id, nickname, joined_at)
    VALUES (@team_id, @agent_id, @nickname, @joined_at)
    ON CONFLICT(team_id, agent_id) DO NOTHING
  `).run(member);
  return member;
}

export function removeTeamMember(teamId: string, agentId: string): void {
  getDB().prepare('DELETE FROM team_members WHERE team_id = ? AND agent_id = ?').run(teamId, agentId);
}

export function isTeamMember(teamId: string, agentId: string): boolean {
  const row = getDB().prepare('SELECT 1 FROM team_members WHERE team_id = ? AND agent_id = ?').get(teamId, agentId);
  return !!row;
}

export function getTeamMembers(teamId: string): TeamMember[] {
  return getDB().prepare('SELECT * FROM team_members WHERE team_id = ?').all(teamId) as TeamMember[];
}

export function getTeamMemberAgentIds(teamId: string): string[] {
  return (getDB().prepare('SELECT agent_id FROM team_members WHERE team_id = ?').all(teamId) as Array<{ agent_id: string }>).map(r => r.agent_id);
}

export function setTeamNickname(teamId: string, agentId: string, nickname: string | null): void {
  getDB().prepare('UPDATE team_members SET nickname = ? WHERE team_id = ? AND agent_id = ?').run(nickname, teamId, agentId);
}

export function getTeamMember(teamId: string, agentId: string): TeamMember | undefined {
  return getDB().prepare('SELECT * FROM team_members WHERE team_id = ? AND agent_id = ?').get(teamId, agentId) as TeamMember | undefined;
}

// Display name for an agent in a team context (nickname || display_name)
export function getTeamDisplayName(teamId: string, agentId: string): string {
  const member = getTeamMember(teamId, agentId);
  if (member?.nickname) return member.nickname;
  const agent = getAgentById(agentId);
  return agent?.display_name ?? 'unknown';
}

// --- Team event queries ---

export function appendTeamEvent(teamId: string, type: TeamEventType, actorAgentId: string | null, payload: object = {}): TeamEvent {
  const d = getDB();
  const ts = nowISO();
  const payloadJson = JSON.stringify(payload);
  const insert = d.transaction(() => {
    const maxSeq = d.prepare('SELECT COALESCE(MAX(seq), 0) as max_seq FROM team_events WHERE team_id = ?').get(teamId) as { max_seq: number };
    const seq = maxSeq.max_seq + 1;
    const result = d.prepare('INSERT INTO team_events (team_id, seq, type, actor_agent_id, payload_json, ts) VALUES (?, ?, ?, ?, ?, ?)').run(teamId, seq, type, actorAgentId, payloadJson, ts);
    return { id: result.lastInsertRowid as number, seq };
  });
  const { id, seq } = insert();
  return { id, team_id: teamId, seq, type, actor_agent_id: actorAgentId, payload_json: payloadJson, ts };
}

export function getTeamEvents(teamId: string, since: number = 0, limit: number = 50): TeamEvent[] {
  return getDB().prepare('SELECT * FROM team_events WHERE team_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?').all(teamId, since, limit) as TeamEvent[];
}

export function getLatestTeamEvents(teamId: string, limit: number = 10): TeamEvent[] {
  return getDB().prepare('SELECT * FROM (SELECT * FROM team_events WHERE team_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC').all(teamId, limit) as TeamEvent[];
}

// --- DM queries ---

export function appendDM(fromAgentId: string, toAgentId: string, content: string): DMMessage {
  const d = getDB();
  const ts = nowISO();
  const insert = d.transaction(() => {
    const maxSeq = d.prepare('SELECT COALESCE(MAX(seq), 0) as max_seq FROM dm_messages WHERE to_agent_id = ?').get(toAgentId) as { max_seq: number };
    const seq = maxSeq.max_seq + 1;
    const result = d.prepare('INSERT INTO dm_messages (seq, from_agent_id, to_agent_id, content, ts) VALUES (?, ?, ?, ?, ?)').run(seq, fromAgentId, toAgentId, content, ts);
    return { id: result.lastInsertRowid as number, seq };
  });
  const { id, seq } = insert();
  return { id, seq, from_agent_id: fromAgentId, to_agent_id: toAgentId, content, ts };
}

export function getMaxIncomingDMId(toAgentId: string, fromAgentId: string): number {
  const row = getDB().prepare(
    'SELECT MAX(id) AS max_id FROM dm_messages WHERE to_agent_id = ? AND from_agent_id = ?'
  ).get(toAgentId, fromAgentId) as { max_id: number | null } | undefined;
  return row?.max_id ?? 0;
}

export function getDMConversation(agentA: string, agentB: string, since: number = 0, limit: number = 50): DMMessage[] {
  return getDB().prepare(`
    SELECT * FROM dm_messages
    WHERE ((from_agent_id = ? AND to_agent_id = ?) OR (from_agent_id = ? AND to_agent_id = ?))
      AND id > ?
    ORDER BY id ASC LIMIT ?
  `).all(agentA, agentB, agentB, agentA, since, limit) as DMMessage[];
}

// --- Task queries ---

export interface CreateTaskOptions {
  assigneeId?: string;
  sourceTeamId?: string;
  input?: object;
  originatorPeer?: string;
  originatorTaskId?: string;
  delegatedPeer?: string;
  delegatedTaskId?: string;
}

export function createTask(title: string, creatorId: string, opts: CreateTaskOptions = {}): Task {
  const task: Task = {
    id: ulid(), title, creator_agent_id: creatorId,
    assignee_agent_id: opts.assigneeId ?? null,
    status: 'created', workflow_json: null, current_step: 0,
    source_team_id: opts.sourceTeamId ?? null,
    input_json: JSON.stringify(opts.input ?? {}),
    created_at: nowISO(), completed_at: null,
    originator_peer: opts.originatorPeer ?? '',
    originator_task_id: opts.originatorTaskId ?? '',
    delegated_peer: opts.delegatedPeer ?? '',
    delegated_task_id: opts.delegatedTaskId ?? '',
  };
  getDB().prepare(`
    INSERT INTO tasks (id, title, creator_agent_id, assignee_agent_id, status, workflow_json, current_step, source_team_id, input_json, created_at, completed_at, originator_peer, originator_task_id, delegated_peer, delegated_task_id)
    VALUES (@id, @title, @creator_agent_id, @assignee_agent_id, @status, @workflow_json, @current_step, @source_team_id, @input_json, @created_at, @completed_at, @originator_peer, @originator_task_id, @delegated_peer, @delegated_task_id)
  `).run(task);
  return task;
}

export function setTaskDelegation(taskId: string, delegatedPeer: string, delegatedTaskId: string): void {
  getDB().prepare('UPDATE tasks SET delegated_peer = ?, delegated_task_id = ? WHERE id = ?').run(delegatedPeer, delegatedTaskId, taskId);
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
  type: 'team' | 'task' | 'dm';
  id: string;
  name: string | null;
  kind: string;
  unread_count: number;
  latest: Array<{ from: string; type: string; preview: string; ts: string }>;
}

export function getUnreadForAgent(agentId: string): UnreadSummary[] {
  const result: UnreadSummary[] = [];
  const d = getDB();

  // Team unread
  const teams = getAgentTeams(agentId, true);
  for (const team of teams) {
    const cursor = getReadCursor(agentId, 'team', team.id);
    const unread = d.prepare(
      'SELECT * FROM team_events WHERE team_id = ? AND seq > ? AND actor_agent_id != ? ORDER BY seq ASC LIMIT 10'
    ).all(team.id, cursor, agentId) as TeamEvent[];
    if (unread.length === 0) continue;
    const totalUnread = (d.prepare(
      'SELECT COUNT(*) as cnt FROM team_events WHERE team_id = ? AND seq > ? AND actor_agent_id != ?'
    ).get(team.id, cursor, agentId) as { cnt: number }).cnt;
    const latest = unread.slice(-5).map(e => ({
      from: e.actor_agent_id ? getTeamDisplayName(team.id, e.actor_agent_id) : 'system',
      type: e.type,
      preview: previewFromPayload(e.payload_json),
      ts: e.ts,
    }));
    result.push({ type: 'team', id: team.id, name: team.name, kind: 'team', unread_count: totalUnread, latest });
  }

  // DM unread (per-sender cursor: target_id = sender_agent_id)
  const senders = d.prepare(
    'SELECT DISTINCT from_agent_id FROM dm_messages WHERE to_agent_id = ?'
  ).all(agentId) as Array<{ from_agent_id: string }>;
  for (const { from_agent_id: senderId } of senders) {
    const cursor = getReadCursor(agentId, 'dm', senderId);
    const msgs = d.prepare(
      'SELECT * FROM dm_messages WHERE to_agent_id = ? AND from_agent_id = ? AND id > ? ORDER BY id ASC'
    ).all(agentId, senderId, cursor) as DMMessage[];
    if (msgs.length === 0) continue;
    const sender = getAgentById(senderId);
    const latest = msgs.slice(-5).map(m => ({
      from: sender?.display_name ?? 'unknown',
      type: 'dm',
      preview: m.content.length > 200 ? m.content.slice(0, 200) + ' [summary]' : m.content,
      ts: m.ts,
    }));
    result.push({ type: 'dm', id: senderId, name: sender?.display_name ?? null, kind: 'dm', unread_count: msgs.length, latest });
  }

  // Task unread
  const tasks = getAgentTasks(agentId);
  for (const task of tasks) {
    if (['completed', 'failed', 'canceled'].includes(task.status)) continue;
    const cursor = getReadCursor(agentId, 'task', task.id);
    const unread = d.prepare(
      'SELECT * FROM task_events WHERE task_id = ? AND seq > ? AND actor_agent_id != ? ORDER BY seq ASC LIMIT 10'
    ).all(task.id, cursor, agentId) as TaskEvent[];
    if (unread.length === 0) continue;
    const totalUnread = (d.prepare(
      'SELECT COUNT(*) as cnt FROM task_events WHERE task_id = ? AND seq > ? AND actor_agent_id != ?'
    ).get(task.id, cursor, agentId) as { cnt: number }).cnt;
    const latest = unread.slice(-5).map(e => {
      const actor = e.actor_agent_id ? getAgentById(e.actor_agent_id) : null;
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

function previewFromPayload(payloadJson: string): string {
  try {
    const p = JSON.parse(payloadJson);
    const text = p.content || p.message || p.preview || '';
    return text.length > 200 ? text.slice(0, 200) + ' [summary]' : text;
  } catch {
    return '';
  }
}

// --- Peers ---

export interface Peer {
  id: string;
  name: string;
  url: string;
  secret: string;
  exposed: string;
  status: string;
  created_at: string;
  last_seen: string | null;
  node_name: string;     // peer's self-reported node name (from /federation/ping)
}

export function addPeer(name: string, url: string, secret: string, exposed: string = ''): Peer {
  const peer: Peer = {
    id: ulid(), name, url, secret, exposed, status: 'active',
    created_at: nowISO(), last_seen: null, node_name: '',
  };
  getDB().prepare(`
    INSERT INTO peers (id, name, url, secret, exposed, status, created_at, last_seen, node_name)
    VALUES (@id, @name, @url, @secret, @exposed, @status, @created_at, @last_seen, @node_name)
  `).run(peer);
  return peer;
}

export function getPeerByName(name: string): Peer | undefined {
  return getDB().prepare('SELECT * FROM peers WHERE name = ?').get(name) as Peer | undefined;
}

export function getPeerBySecret(secret: string): Peer | undefined {
  // Status is informational (reachability); auth is by secret match only.
  return getDB().prepare('SELECT * FROM peers WHERE secret = ?').get(secret) as Peer | undefined;
}

export function listPeers(): Peer[] {
  return getDB().prepare('SELECT * FROM peers ORDER BY created_at DESC').all() as Peer[];
}

export function removePeer(name: string): boolean {
  const result = getDB().prepare('DELETE FROM peers WHERE name = ?').run(name);
  return result.changes > 0;
}

export function updatePeerExposed(name: string, exposed: string): void {
  getDB().prepare('UPDATE peers SET exposed = ? WHERE name = ?').run(exposed, name);
}

export function touchPeer(name: string): void {
  getDB().prepare('UPDATE peers SET last_seen = ? WHERE name = ?').run(nowISO(), name);
}

export function setPeerStatus(name: string, status: 'active' | 'inactive'): void {
  getDB().prepare('UPDATE peers SET status = ? WHERE name = ?').run(status, name);
}

export function setPeerNodeName(name: string, nodeName: string): void {
  getDB().prepare('UPDATE peers SET node_name = ? WHERE name = ?').run(nodeName, name);
}

// --- Pending invites (for peer invite/accept handshake) ---

export interface PendingInvite {
  token_id: string;
  secret: string;
  exposed_agent_id: string;
  url: string;
  created_at: string;
  expires_at: string;
}

export function createPendingInvite(secret: string, exposedAgentId: string, url: string, ttlMs = 24 * 60 * 60 * 1000): PendingInvite {
  const tokenId = 't_' + ulid().slice(-12);
  const now = new Date();
  const invite: PendingInvite = {
    token_id: tokenId, secret, exposed_agent_id: exposedAgentId, url,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttlMs).toISOString(),
  };
  getDB().prepare(`
    INSERT INTO pending_invites (token_id, secret, exposed_agent_id, url, created_at, expires_at)
    VALUES (@token_id, @secret, @exposed_agent_id, @url, @created_at, @expires_at)
  `).run(invite);
  return invite;
}

export function getPendingInvite(tokenId: string): PendingInvite | undefined {
  return getDB().prepare('SELECT * FROM pending_invites WHERE token_id = ?').get(tokenId) as PendingInvite | undefined;
}

export function deletePendingInvite(tokenId: string): void {
  getDB().prepare('DELETE FROM pending_invites WHERE token_id = ?').run(tokenId);
}

export function cleanupExpiredInvites(): number {
  const result = getDB().prepare('DELETE FROM pending_invites WHERE expires_at < ?').run(nowISO());
  return result.changes;
}

export function isPeerExposed(peerName: string, agentName: string): boolean {
  const peer = getPeerByName(peerName);
  if (!peer || !peer.exposed) return false;
  const exposed = peer.exposed.split(',').map(s => s.trim());
  return exposed.includes(agentName);
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
