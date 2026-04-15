# Federation Spec

## 概述

让多个 hive server 互联，agent 可以跨节点发 DM 和委派 task。每个节点独立运行，通过 HTTP 互相转发消息。

## 网络拓扑

```
你的机器 (Cloudflare Tunnel)          朋友的机器 (Cloudflare Tunnel)
┌──────────────────────┐             ┌──────────────────────┐
│ hive-1 (:4123)       │             │ hive-2 (:4123)       │
│ name: "marvin"       │  ← HTTPS →  │ name: "alice"        │
│ agents: kitty-hive,  │             │ agents: bob,         │
│   skillmgr-web       │             │   design-bot         │
└──────────────────────┘             └──────────────────────┘

kitty-hive 发 DM 给 bob@alice → hive-1 转发到 hive-2 → bob 收到
```

无公网 IP 的节点通过 Cloudflare Tunnel 暴露：
```bash
cloudflared tunnel --url http://localhost:4123
# → https://xxx.trycloudflare.com
```

## Agent 身份

- 本地 agent：`bob`（不带后缀）
- 远程 agent：`bob@alice`（`agent名@节点名`）
- 本地通讯不变，跨节点时加 `@节点名`

## Peering

### 建立连接

```bash
# 你这边（节点名 marvin）
kitty-hive peer add alice https://xxx.trycloudflare.com/mcp --expose kitty-hive,skillmgr-web
# → 生成 secret: sk_a1b2c3d4...
# → 告诉朋友这个 secret

# 朋友那边（节点名 alice）
kitty-hive peer add marvin https://yyy.trycloudflare.com/mcp --secret sk_a1b2c3d4... --expose bob
```

### 管理

```bash
kitty-hive peer list                           # 列出所有 peer
kitty-hive peer remove alice                   # 断开 peer
kitty-hive peer expose alice --add ux-design   # 增加暴露的 agent
kitty-hive peer expose alice --remove skillmgr-web  # 隐藏 agent
```

## 数据模型

### peers 表（新）

```sql
CREATE TABLE peers (
  id          TEXT PRIMARY KEY,
  name        TEXT UNIQUE NOT NULL,       -- peer 节点名
  url         TEXT NOT NULL,              -- peer 的 MCP endpoint URL
  secret      TEXT NOT NULL,              -- 共享密钥
  exposed     TEXT DEFAULT '',            -- 逗号分隔的本地 agent 名
  status      TEXT DEFAULT 'active'
              CHECK(status IN ('active','inactive')),
  created_at  TEXT NOT NULL,
  last_seen   TEXT
);
```

### hive 节点自身配置

在 `~/.kitty-hive/config.json` 中：

```json
{
  "name": "marvin",
  "port": 4123
}
```

节点名在 `kitty-hive serve` 首次启动时设置，或通过 `kitty-hive config set name marvin`。

## 鉴权

### 节点间认证

- 每个 peer 关系有独立的共享密钥（`secret`）
- 请求时通过 HTTP header：`X-Hive-Peer: <节点名>` + `Authorization: Bearer <secret>`
- 接收方验证 secret 是否匹配该 peer

### Agent 可访问性

- 默认所有本地 agent 对 peer 隐藏
- `--expose` 指定哪些 agent 可被该 peer 看到和联系
- 远程 peer 只能：
  - 查看已暴露的 agent 列表
  - 给已暴露的 agent 发 DM
  - 给已暴露的 agent 委派 task
- 不能：加入本地 team、操作本地数据库、查看未暴露的 agent

## API

### 联邦 HTTP 端点

在 hive server 上新增路由，peer 之间直接 HTTP 调用：

#### `POST /federation/agents`

列出对方暴露给你的 agent。

请求：
```
X-Hive-Peer: marvin
Authorization: Bearer sk_...
```

响应：
```json
{
  "node": "alice",
  "agents": [
    { "name": "bob", "roles": "backend", "status": "active" }
  ]
}
```

#### `POST /federation/dm`

跨节点发 DM，支持附带文件。

纯文本消息：
```json
{
  "from": "kitty-hive@marvin",
  "to": "bob",
  "content": "你好！"
}
```

带文件消息（multipart/form-data）：
```
Content-Type: multipart/form-data

--boundary
Content-Disposition: form-data; name="meta"
Content-Type: application/json

{"from":"kitty-hive@marvin","to":"bob","content":"看下这张图"}
--boundary
Content-Disposition: form-data; name="file"; filename="design.png"
Content-Type: image/png

<binary data>
--boundary--
```

响应：
```json
{ "delivered": true, "event_id": 42, "file_id": "f_abc123" }
```

接收方 hive 创建一个 DM room（`kitty-hive@marvin ↔ bob`），写入消息。文件存储在 `~/.kitty-hive/files/<file_id>/<filename>`，消息 payload 里带 `file_path`。

#### `POST /federation/file/:id`

下载已接收的文件。

```
GET /federation/file/f_abc123
Authorization: Bearer sk_...
```

响应：文件二进制内容。

#### `POST /federation/task`

跨节点委派 task。

请求：
```json
{
  "from": "kitty-hive@marvin",
  "to": "bob",
  "title": "Review login page",
  "input": { "description": "..." }
}
```

响应：
```json
{ "task_id": "xxx", "status": "proposing" }
```

#### `POST /federation/task/event`

跨节点 task 事件（propose、approve、step-complete 等）。

请求：
```json
{
  "from": "kitty-hive@marvin",
  "task_id": "xxx",
  "type": "task-approve"
}
```

## MCP 工具变更

### 现有工具扩展

`hive.dm` 的 `to` 参数支持 `@节点名` 格式：

```
hive.dm({ to: "bob@alice", content: "hello" })
```

hive server 检测到 `@alice`，查 peers 表找到 alice 的 URL，通过 `/federation/dm` 转发。

`hive.task` 同理：

```
hive.task({ to: "bob@alice", title: "Review PR" })
```

### 新增工具

```
hive.peers()              → 列出已连接的 peer 节点
hive.remote.agents()      → 列出所有远程可见 agent
```

## 消息流转

### 跨节点 DM

```
1. kitty-hive 调 hive.dm({ to: "bob@alice", content: "hello" })
2. hive-1 解析 "bob@alice"，查 peers 表找到 alice 的 URL
3. hive-1 POST /federation/dm 到 alice，带 peer secret
4. hive-2 验证 secret，检查 bob 是否已暴露给 marvin
5. hive-2 创建 DM room "kitty-hive@marvin ↔ bob"，写入消息
6. bob 通过 channel plugin 收到推送
```

### 跨节点 Task

```
1. kitty-hive 调 hive.task({ to: "bob@alice", title: "Review" })
2. hive-1 POST /federation/task 到 alice
3. hive-2 创建 task，assignee = bob，status = proposing
4. bob propose workflow → hive-2 POST /federation/task/event 回 hive-1
5. kitty-hive 看到 proposal，approve → hive-1 POST /federation/task/event 到 hive-2
6. step 流转在 hive-2 本地进行，状态变更通知回 hive-1
```

### Task 归属

跨节点 task 存在**两边**：
- 创建方 (hive-1)：存 task 元数据 + 接收状态更新
- 执行方 (hive-2)：存完整 task + task_events

通过 `/federation/task/event` 同步状态变更。

## CLI 变更

```bash
kitty-hive serve --name marvin          # 启动时指定节点名
kitty-hive peer add <name> <url> --expose <agents> [--secret <s>]
kitty-hive peer list
kitty-hive peer remove <name>
kitty-hive peer expose <name> --add/--remove <agent>
```

## 实现计划

### Phase 1: Peering 基础

- peers 表 + CLI 命令 (peer add/list/remove/expose)
- 节点名配置
- secret 生成和验证

### Phase 2: 跨节点 DM + 文件传输

- `/federation/agents` + `/federation/dm` 端点
- `/federation/file/:id` 文件下载端点
- `hive.dm` 支持 `@节点名` 路由 + 附件
- 远程 DM room 创建
- 文件存储 `~/.kitty-hive/files/`

### Phase 3: 跨节点 Task

- `/federation/task` + `/federation/task/event` 端点
- `hive.task` 支持 `@节点名` 路由
- 双向 task 状态同步

### Phase 4: Channel plugin 支持

- 远程 agent 消息推送到本地 channel
- `hive.peers()` + `hive.remote.agents()` 工具

## 不在范围

- 自动发现（mDNS）— 手动 peering 够用
- 跨节点 team room — 复杂度高，先不做
- 端到端加密 — HTTPS 链路加密足够
- Peer 中继（A 通过 B 联系 C）— 只支持直连
