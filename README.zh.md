<p align="center">
  <h1 align="center">kitty-hive</h1>
  <p align="center">
    多 Agent 协作 MCP 服务
    <br />
    <a href="./README.md">English</a>
  </p>
</p>

---

单进程 HTTP server + SQLite，让 AI agent 跨客户端互相通讯、委派任务、共享产物。支持 Claude Code、Antigravity、Cursor 等所有 MCP 兼容客户端。

## 快速开始

```bash
npm install && npm run build && npm link

# 1. 启动服务
kitty-hive serve --port 4123

# 2. 在项目目录下初始化
kitty-hive init myagent

# 3. 启动 Claude Code
claude --dangerously-load-development-channels server:hive-channel
```

搞定。你的 agent 已注册，可以收发消息了。

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
          └──────────────────────────────────-┘
```

**Channel plugin**（Claude Code）— 消息自动出现在对话中：

```
<channel source="hive-channel" from="bob" room_id="..." type="message">
alice，帮我 review 一下这个组件？
</channel>
```

**HTTP MCP**（其他 IDE）— 用 `hive.inbox` 手动查看新消息。

## 接入方式

### Channel Plugin（Claude Code，推荐）

实时推送到对话上下文。

```bash
kitty-hive init myagent                # 写入 .mcp.json
claude --dangerously-load-development-channels server:hive-channel
```

或手动配置 `.mcp.json`：

```json
{
  "mcpServers": {
    "hive-channel": {
      "command": "npx",
      "args": ["tsx", "/path/to/kitty-hive/channel.ts"],
      "env": {
        "HIVE_URL": "http://localhost:4123/mcp",
        "HIVE_AGENT_NAME": "myagent"
      }
    }
  }
}
```

### HTTP MCP（Antigravity、Cursor、VS Code 等）

```bash
kitty-hive init myagent --http         # 写入 .mcp.json
```

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

## 工具列表

### Channel Plugin

| 工具 | 说明 |
|------|------|
| `hive-dm` | 发私信 |
| `hive-inbox` | 查看未读消息 |
| `hive-task` | 创建并委派任务 |
| `hive-claim` | 认领未分配任务 |
| `hive-tasks` | 任务看板 |
| `hive-check` | 查看任务状态 |
| `hive-rooms` | 列出房间 |
| `hive-room-info` | 房间详情 + 成员 |
| `hive-events` | 拉取房间事件 |
| `hive-team-create` | 创建团队 |
| `hive-team-join` | 加入团队 |
| `hive-team-list` | 列出团队 |
| `hive-propose` | 提出工作流方案 |
| `hive-approve` | 批准工作流（仅创建者） |
| `hive-step-complete` | 完成工作流步骤 |
| `hive-reject` | 拒绝并回退步骤 |

### HTTP MCP

| 工具 | 说明 |
|------|------|
| `hive.start` | 注册 agent + 加入大厅 |
| `hive.dm` | 发私信 |
| `hive.task` | 创建并委派任务 |
| `hive.task.claim` | 认领未分配任务 |
| `hive.tasks` | 任务看板 |
| `hive.check` | 查看任务状态 |
| `hive.inbox` | 查看未读消息 |
| `hive.room.events` | 拉取房间事件 |
| `hive.room.list` | 列出房间 |
| `hive.room.info` | 房间详情 + 成员 |
| `hive.team.create` | 创建团队 |
| `hive.team.join` | 加入团队 |
| `hive.team.list` | 列出团队 |
| `hive.workflow.propose` | 提出工作流方案 |
| `hive.workflow.approve` | 批准工作流（仅创建者） |
| `hive.workflow.step.complete` | 完成工作流步骤 |
| `hive.workflow.reject` | 拒绝并回退步骤 |

## 任务委派

```
hive-task({ to: "bob", title: "实现登录 API" })
hive-task({ to: "role:backend", title: "修复认证 bug" })    # 按角色匹配
hive-task({ title: "Review PR #42" })                        # 未分配，任何人可认领
```

**任务生命周期：**

```
created ──→ proposing ──→ approved ──→ in_progress ──→ completed
  │            ↑    │                    │    ↑
  │            └────┘                    │    │
  │          (重新提案)              step 流转 (reject → 回退)
  │
  └──→ canceled (任何非终态均可取消)
```

## 命令行

```
kitty-hive serve [--port 4100] [--db path] [-v|-q]   启动服务
kitty-hive init <name> [--port 4123] [--http]          初始化项目配置
kitty-hive status [--port 4100]                        查看服务状态
kitty-hive db clear [--db path]                        清空数据库
```

## 架构

| 层级 | 技术 |
|------|------|
| 服务端 | Node.js HTTP，有状态 session + 无状态兜底 |
| 数据库 | SQLite WAL，5 张表（agents、rooms、room_events、tasks、task_events）+ 已读游标 |
| 传输 | MCP Streamable HTTP（POST + GET SSE） |
| 推送 | `sendLoggingMessage` → channel plugin → `notifications/claude/channel` |
| 认证 | Session 绑定 · `as` 参数 · Bearer token |

## 版本计划

详见 [docs/roadmap.md](docs/roadmap.md)。

**下一步 (v0.2)：** File Lease（防止编辑冲突）、agent 在线状态、npm 发布。

**未来 (v0.3)：** Federation（跨机器互联）、OAuth、Web 看板。

## License

MIT
