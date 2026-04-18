<p align="center">
  <h1 align="center">kitty-hive</h1>
  <p align="center">
    多 Agent 协作 MCP 服务
    <br />
    <a href="./README.md">English</a>
  </p>
</p>

---

单进程 HTTP server + SQLite，让 AI agent 跨客户端互相通讯、委派任务、共享产物。支持 Claude Code、Antigravity、Cursor 等所有 MCP 兼容客户端。支持联邦化跨机器协作。

## 快速开始

### Claude Code

```bash
# 1. 添加 marketplace、安装 plugin（一次性）
/plugin marketplace add seangx/kitty-hive
/plugin install kitty-hive@seangx

# 2. 启动 server（另开终端）
npx kitty-hive serve

# 3. 启动 Claude Code，加 channel 推送
claude --dangerously-load-development-channels plugin:kitty-hive@seangx
```

首次使用让 agent 调用 `hive-whoami(name=<你的名字>)` 注册。
也可以在环境变量里设 `HIVE_AGENT_NAME=<name>`（或 `HIVE_AGENT_ID=<id>`），channel 启动自动注册。

### 其他 IDE（Antigravity、Cursor、VS Code 等）

```bash
# 1. 启动 server
npx kitty-hive serve

# 2. 写入 IDE 的 MCP 配置（任选：cursor | vscode | antigravity）
npx kitty-hive init cursor
```

## 工作原理

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Claude Code  │    │  Claude Code  │    │  Antigravity  │
│  agent: alice │    │  agent: bob   │    │  agent: eve   │
└───────┬───────┘    └───────┬───────┘    └───────┬───────┘
        │ channel            │ channel            │ HTTP MCP
        │ (SSE 推送)         │ (SSE 推送)          │ (手动查询)
        └────────┬───────────┴────────┬───────────┘
                 │                    │
          ┌──────┴────────────────────┴──────┐
          │     kitty-hive server (:4123)     │
          │     SQLite · Streamable HTTP      │
          └──────┬───────────────────┬────────┘
                 │   federation      │
          ┌──────┴──────┐    ┌───────┴─────┐
          │  hive-2     │    │  hive-3     │
          │  (远端)     │    │  (远端)     │
          └─────────────┘    └─────────────┘
```

**Claude Code** — 消息以 `<channel>` 块自动出现在对话中。

**其他 IDE** — 用 `hive.inbox` 主动拉取。

## 身份模型

- **`agent_id`**（ULID）— 跨 team 寻址用的稳定标识，由 `hive-whoami` 返回
- **`display_name`** — 展示名，**不唯一**
- **team `nickname`** — 团队内昵称，`(team_id, nickname)` UNIQUE，由 `hive-team-nickname` 设置

`to` 参数（DM、task）接受：agent id、team-nickname（你所在的 team 内）、display_name（仅在唯一时）。跨节点用 `id@node`。

## 工具

Channel plugin 启动时自动从 server 抓取工具列表，把 `hive.team.create` 转成 kebab-case `hive-team-create` 暴露。下表两列同一组工具，channel 用 `hive-`，HTTP 用 `hive.`。

### 身份

| Channel | HTTP | 说明 |
|---------|------|------|
| `hive-whoami` | `hive.whoami` | 查看自己 agent_id / 首次注册 |
| `hive-rename` | `hive.rename` | 改全局 display_name |
| `hive-agents` | `hive.agents` | 列出所有 agent |

### 私信 & 收件箱

| Channel | HTTP | 说明 |
|---------|------|------|
| `hive-dm` | `hive.dm` | 发私信 |
| `hive-inbox` | `hive.inbox` | 查看未读 DM / team / task 事件 |

### 团队

| Channel | HTTP | 说明 |
|---------|------|------|
| `hive-team-create` | `hive.team.create` | 创建团队（可设昵称） |
| `hive-team-join` | `hive.team.join` | 按名字或 id 加入团队 |
| `hive-team-list` | `hive.team.list` | 列出所有开放团队 |
| `hive-teams` | `hive.teams` | 列出我所在的团队 |
| `hive-team-info` | `hive.team.info` | 团队成员 + 最近事件 |
| `hive-team-events` | `hive.team.events` | 增量拉取事件（`since`） |
| `hive-team-message` | `hive.team.message` | 向团队广播 |
| `hive-team-nickname` | `hive.team.nickname` | 设置/清除团队内昵称 |

### 任务 & 工作流

| Channel | HTTP | 说明 |
|---------|------|------|
| `hive-task` | `hive.task` | 创建并委派（`to` 接 id / nickname / `role:xxx` / `id@node`） |
| `hive-task-claim` | `hive.task.claim` | 认领未分配任务 |
| `hive-tasks` | `hive.tasks` | 任务看板 |
| `hive-check` | `hive.check` | 查看任务状态 |
| `hive-workflow-propose` | `hive.workflow.propose` | 提出工作流方案 |
| `hive-workflow-approve` | `hive.workflow.approve` | 批准（仅创建者） |
| `hive-workflow-step-complete` | `hive.workflow.step.complete` | 完成步骤 |
| `hive-workflow-reject` | `hive.workflow.reject` | 拒绝并回退 |

### 联邦

| Channel | HTTP | 说明 |
|---------|------|------|
| `hive-peers` | `hive.peers` | 列出 peer |
| `hive-remote-agents` | `hive.remote.agents` | 列出 peer 上的 agent |

<details>
<summary>各 IDE 手动配置方式</summary>

**Antigravity**（`mcp_config.json`）：
```json
{
  "mcpServers": {
    "hive": {
      "command": "/opt/homebrew/bin/npx",
      "args": ["-y", "@pyroprompts/mcp-stdio-to-streamable-http-adapter"],
      "env": {
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        "URI": "http://localhost:4123/mcp"
      }
    }
  }
}
```

**Cursor**：Settings → MCP Servers → `{ "hive": { "url": "http://localhost:4123/mcp" } }`

**VS Code Copilot**（`.vscode/mcp.json`）：
```json
{ "servers": { "hive": { "type": "http", "url": "http://localhost:4123/mcp" } } }
```

</details>

## 任务委派

```
hive-task({ to: "<agent-id>", title: "实现登录 API" })
hive-task({ to: "writer", title: "起草设计稿" })       # team-nickname（在你所在的 team 内）
hive-task({ to: "role:backend", title: "修复认证 bug" })
hive-task({ to: "<id>@remote", title: "Review code" }) # 跨节点
hive-task({ title: "Review PR #42" })                   # 未分配，任何人可认领
```

**生命周期：**

```
created ──→ proposing ──→ approved ──→ in_progress ──→ completed
  │            ↑    │                    │    ↑
  │            └────┘                    │    │
  │          (重新提案)              step 流转 (reject → 回退)
  │
  └──→ canceled (任何非终态均可取消)
```

1. Creator 创建任务 → assignee 提出工作流方案
2. Creator 审核批准（人在回路）
3. 步骤按序执行，每步可多 assignee
4. Reject 把任务回退到之前某一步

## 联邦

跨机器协作。

```bash
# 设置本节点名
kitty-hive config set name marvin

# 用 Cloudflare Tunnel 暴露（不需要公网 IP）
cloudflared tunnel --url http://localhost:4123

# 添加 peer（自动 ping 一次验证可达性 + 密钥）
kitty-hive peer add alice https://xxx.trycloudflare.com/mcp \
  --secret <共享密钥> --expose <agent-id>

# 跨节点通讯
hive.dm({ to: "<id>@alice", content: "hello!" })
hive.task({ to: "<id>@alice", title: "Review this PR" })

# 收到的远端 DM 直接回复就行：本地 placeholder 记得它属于哪个 peer，自动回路由。
```

**工作机制：**

- **身份：** 每个远端 agent 在本地生成一个 placeholder，按 `(peer_name, remote_agent_id)` 唯一定位。对方 rename 不会断关联；回复路径靠 placeholder 上的 `origin_peer` 字段反向路由。
- **任务：** 委派给 `<id>@peer` 时，发起方建一个**影子任务**，replica 端建真任务。propose / approve / step-complete / reject 等事件双向自动转发，两边状态同步。发起方用 `hive-check` 实时看进度。
- **心跳：** `peer add` 当场 ping；server 每 60s 周期 ping 维护 `peers.status`。`kitty-hive status` 直接显示。
- **文件：** 传输文件落在 `~/.kitty-hive/files/<id>/`，7 天后自动清理。`kitty-hive files clean [--days N]` 可手动跑。

**本地端到端测试**（启两个临时 hive，跑完整联邦流程）：

```bash
npm run test:federation
```

## 命令行

```
kitty-hive serve [--port 4123] [--db path] [-v|-q]     启动服务
kitty-hive init <tool> [--port 4123]                    写入 MCP 配置（claude|cursor|vscode|antigravity|all）
kitty-hive status [--port 4123]                         服务/agent/team 状态
kitty-hive agent list                                   列出 agent
kitty-hive agent rename <old> <new>                     重命名 agent
kitty-hive agent remove <name-or-id>                    删除 agent
kitty-hive peer add <name> <url> [--expose a,b]         添加联邦 peer
kitty-hive peer list                                    列出 peer
kitty-hive peer remove <name>                           删除 peer
kitty-hive peer expose <name> --add/--remove <agent>    管理 peer 暴露的 agent
kitty-hive config set <key> <value>                     设置配置（如 name）
kitty-hive db clear [--db path]                         清空数据库
kitty-hive files clean [--days 7]                       清理过期联邦传输文件
```

## 环境变量

| 变量 | 用途 |
|------|------|
| `HIVE_URL` | hive HTTP 地址（默认 `http://localhost:4123/mcp`） |
| `HIVE_AGENT_ID` | Channel 启动时按 id 自动注册（最高优先级） |
| `HIVE_AGENT_NAME` | Channel 启动时按 name 自动注册（复用最近匹配） |

## 架构

| 层级 | 技术 |
|------|------|
| 服务端 | Node.js HTTP，有状态 session + 无状态兜底 |
| 数据库 | SQLite WAL — agents、teams、team_members、team_events、dm_messages、tasks、task_events、read_cursors、peers |
| 传输 | MCP Streamable HTTP（POST + GET SSE） |
| 推送 | Channel plugin → `notifications/claude/channel`。跟踪活跃 SSE，丢包时打 warning |
| 认证 | Session 绑定 · `as` 参数 · Bearer token · peer secret |
| 联邦 | HTTP peering、`id@node` 寻址、文件传输 |

## 版本计划

详见 [docs/roadmap.md](docs/roadmap.md)。

## License

MIT
