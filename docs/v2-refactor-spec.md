# kitty-hive v2 Refactor Spec

## 核心变更

1. **Task 独立于 Room** — task 有自己的表和事件流，不再创建 task room
2. **Room 只负责通讯** — lobby / dm / team，纯消息
3. **去掉 task room / project room** — 不再需要

## 数据模型

### agents（不变）

```sql
CREATE TABLE agents (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  token         TEXT UNIQUE NOT NULL,
  tool          TEXT DEFAULT '',
  roles         TEXT DEFAULT '',
  expertise     TEXT DEFAULT '',
  status        TEXT CHECK(status IN ('active','idle','busy','offline')),
  created_at    TEXT NOT NULL,
  last_seen     TEXT NOT NULL
);
```

### rooms（简化）

```sql
CREATE TABLE rooms (
  id              TEXT PRIMARY KEY,
  name            TEXT,
  kind            TEXT NOT NULL CHECK(kind IN ('lobby','dm','team')),
  host_agent_id   TEXT REFERENCES agents(id),
  created_at      TEXT NOT NULL,
  closed_at       TEXT
);
```

去掉 `parent_room_id`、`metadata_json`、`task`/`project` kind。

### room_events（简化）

```sql
CREATE TABLE room_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id         TEXT NOT NULL REFERENCES rooms(id),
  seq             INTEGER NOT NULL,
  type            TEXT NOT NULL CHECK(type IN ('join','leave','message')),
  actor_agent_id  TEXT REFERENCES agents(id),
  payload_json    TEXT DEFAULT '{}',
  ts              TEXT NOT NULL
);
```

只保留 join / leave / message。所有 task-* 事件移到 task_events。

### tasks（新）

```sql
CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  creator_agent_id  TEXT NOT NULL REFERENCES agents(id),
  assignee_agent_id TEXT REFERENCES agents(id),
  status            TEXT NOT NULL DEFAULT 'created'
                    CHECK(status IN ('created','proposing','approved','in_progress','completed','failed','canceled')),
  workflow_json     TEXT,          -- WorkflowStep[] JSON, null = simple task
  current_step      INTEGER DEFAULT 0,
  source_room_id    TEXT REFERENCES rooms(id),  -- 在哪个 room 发起的
  input_json        TEXT DEFAULT '{}',
  created_at        TEXT NOT NULL,
  completed_at      TEXT
);
```

### task_events（新）

```sql
CREATE TABLE task_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  seq             INTEGER NOT NULL,
  type            TEXT NOT NULL CHECK(type IN (
    'task-start','task-claim','task-update',
    'task-propose','task-approve','task-reject',
    'step-start','step-complete',
    'task-complete','task-fail','task-cancel'
  )),
  actor_agent_id  TEXT REFERENCES agents(id),
  payload_json    TEXT DEFAULT '{}',
  ts              TEXT NOT NULL
);
CREATE INDEX idx_task_events_task_seq ON task_events(task_id, seq);
```

### read_cursors（扩展）

```sql
CREATE TABLE read_cursors (
  agent_id  TEXT NOT NULL REFERENCES agents(id),
  target_type TEXT NOT NULL CHECK(target_type IN ('room','task')),
  target_id TEXT NOT NULL,
  last_seq  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, target_type, target_id)
);
```

支持 room 和 task 两种已读游标。

## Room 类型

| Kind | 说明 | 创建方式 |
|------|------|---------|
| `lobby` | 全局大厅 | 自动创建，所有 agent 自动加入 |
| `dm` | 私聊 | `hive.dm` 自动创建 |
| `team` | 协作组 | `hive.team.create` 手动创建 + `hive.team.invite` |

## Task Lifecycle

### Simple Task（无 workflow）

```
created → working → completed / failed / canceled
```

### Workflow Task

```
created → proposing → approved → in_progress (step flow) → completed
              ↑          │
              └──rejected─┘
```

## Task 与 Room 的关系

- Task 通过 `source_room_id` 记录在哪个 room 发起
- Task 事件独立存储在 `task_events`，不写入 `room_events`
- 在 room 里发起 task 时，room 里会写一条 message 通知（"xxx 发起了任务: yyy"）
- Workflow 提案时优先从 `source_room_id` 的成员选 assignee，但可以引用外部 agent

## 工具变更

### 新增

| 工具 | 说明 |
|------|------|
| `hive.team.create` | 创建 team room |
| `hive.team.join` | 自己加入一个 team |
| `hive.team.list` | 列出所有可加入的 team |

### 修改

| 工具 | 变更 |
|------|------|
| `hive.task` | 不再建 room，写入 tasks 表 |
| `hive.check` | 从 tasks + task_events 读取 |
| `hive.room.post` | 只处理 join/leave/message |
| `hive.room.info` | 去掉 task_state 字段 |
| `hive.inbox` | 同时查 room 未读和 task 未读 |

### Workflow 工具（不变）

`hive.workflow.propose` / `approve` / `step.complete` / `reject`

事件写入 `task_events` 而非 `room_events`。

## 通知

Task 事件通知走现有的 `notifyRoomMembers` 逻辑，但通知对象是 task 的参与者（creator + assignees），不是 room 成员。

新增 `notifyTaskParticipants(taskId, excludeAgentId, message)` 函数。

## 迁移

因为 MVP 阶段数据不重要，直接 `db clear` 重建。不做迁移脚本。

## 不在范围

- 并行 step
- Task 模板
- Task 依赖（task A 完成后自动触发 task B）
- Room 权限（admin/member）
