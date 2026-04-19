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

> **注意：** 目前**必须**带 `--dangerously-load-development-channels`，别被名字吓到删掉。Claude Code 的 `claude/channel` 能力还在 experimental，不加这个 flag，plugin 能装上但**收不到任何推送**。将来 CC 正式开放 channel 后可以去掉。

首次使用让 agent 调用 `hive-whoami(name=<你的名字>)` 注册。
也可以在环境变量里设 `HIVE_AGENT_NAME=<name>`（或 `HIVE_AGENT_ID=<id>`），channel 启动自动注册。

### 其他 IDE（Antigravity、Cursor、VS Code 等）

```bash
# 1. 启动 server
npx kitty-hive serve

# 2. 写入 IDE 的 MCP 配置（cursor | vscode | antigravity | claude | all）
npx kitty-hive init cursor
```

## 工作原理

每台机器各自跑一个 `kitty-hive serve` —— **没有中心节点**。本地 agent 通过 MCP 连到自己这台 hive；hive 之间通过 HTTP 对等联邦（完全对称，没有主从）。

```
╔═════════════════════ 你的机器 ═════════════════════════╗     ╔══════ alice 的机器 ══════════╗
║                                                        ║     ║                              ║
║  Claude Code       Cursor          Antigravity         ║     ║   Claude Code                ║
║  agent: bob-local  agent: reviewer agent: worker       ║     ║   agent: alice               ║
║       │                │                │              ║     ║        │                     ║
║       │ channel        │ HTTP MCP       │ HTTP MCP     ║     ║        │ channel             ║
║       │ (SSE 推送)     │ (拉取)         │ (拉取)       ║     ║        │                     ║
║       └────────┬───────┴────────┬───────┘              ║     ║        │                     ║
║                ▼                ▼                      ║     ║        ▼                     ║
║        ┌────────────────────────────┐                  ║     ║  ┌──────────────────┐        ║
║        │  kitty-hive serve (:4123)  │ ◀──── peer ───────HTTP─▶│ kitty-hive :4123 │        ║
║        │  SQLite · Streamable HTTP  │     (Bearer 密钥) ║     ║  │                  │        ║
║        └────────────────────────────┘                  ║     ║  └──────────────────┘        ║
╚════════════════════════════════════════════════════════╝     ╚══════════════════════════════╝

                              ▲
                              │ peer（走 Cloudflare tunnel 或公网 IP）
                              ▼
                   ┌──────────────────────┐
                   │    carol 的机器      │  ……每个 hive 完全对等
                   │   kitty-hive :4123   │
                   └──────────────────────┘
```

**Claude Code** — 消息以 `<channel>` 块自动出现在对话中（SSE 推送）。

**其他 IDE（Cursor / VS Code / Antigravity / …）** — agent 主动 `hive-inbox` 拉取。

**跨机器** — peer 是对称的，没有"主 hive"。配置见 [联邦](#联邦)。

## 身份模型

- **`agent_id`**（ULID）— 跨 team 寻址用的稳定标识，由 `hive-whoami` 返回
- **`display_name`** — 展示名，**不唯一**
- **team `nickname`** — 团队内昵称，`(team_id, nickname)` UNIQUE，由 `hive-team-nickname` 设置

`to` 参数（DM、task）接受：agent id、team-nickname（你所在的 team 内）、display_name（仅在唯一时）。跨节点用 `id@node`。

## 工具

每个 HTTP 工具 `hive.foo.bar` 都被 channel plugin 镜像成 kebab-case `hive-foo-bar`。下表两列同一组工具，在 Claude Code 里用左列（channel），直接调 HTTP MCP 用右列。

### 身份

| Channel | HTTP | 说明 |
|---------|------|------|
| `hive-whoami` | `hive.whoami` | 查看自己 agent_id。**首次使用：** 传 `name` 注册（channel plugin 会透明地代理到 `hive.start`） |
| — | `hive.start` | 底层注册 RPC。HTTP/IDE 用户直接调用（channel 用户走 `hive-whoami`） |
| `hive-rename` | `hive.rename` | 改全局 display_name |
| `hive-agents` | `hive.agents` | 列出所有 agent |

### 私信 & 收件箱

| Channel | HTTP | 说明 |
|---------|------|------|
| `hive-dm` | `hive.dm` | 发私信。传 `attach: ["/abs/path"]` 发文件/图片（路径是**你**这台机器的；对方拿到 `file_id` 另取） |
| `hive-inbox` | `hive.inbox` | 查看未读 DM / team / task 事件。每条 DM 带 `message_id` + `attachments` |
| `hive-dm-read` | `hive.dm.read` | 按 `message_id` 拉单条 DM 全文（preview 结尾 `…(truncated; hive-dm-read message_id=N)` 时用） |
| `hive-file-fetch` | `hive.file.fetch` | 按 `file_id` 取附件；`save_to` 可复制到指定位置 |

### 团队

| Channel | HTTP | 说明 |
|---------|------|------|
| `hive-team-create` | `hive.team.create` | 创建团队（可设昵称） |
| `hive-team-join` | `hive.team.join` | 按名字或 id 加入团队 |
| `hive-team-list` | `hive.team.list` | 列出 hive 上所有团队 |
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

让两台（或多台）机器上的 hive 互通，agent 可跨机器 DM、委派任务。

### 两台机器配置 walkthrough（invite/accept —— 推荐）

假设有 **mac**（本地）和 **win**（另一台），两边都跑了 `kitty-hive serve` 并已注册 agent。

**1. 各自起节点名**
```bash
# mac
kitty-hive config set name marvin
# win
kitty-hive config set name win-laptop
```

**2. 让对方能访问到你**。两个选项：

<details open>
<summary><b>方式 A（推荐）：让 kitty-hive 自动管 cloudflared</b></summary>

每台机器另开一个终端：
```bash
kitty-hive tunnel start
# → 🌀 Starting cloudflared…
#   ✓ Tunnel URL: https://xxx-yyy-zzz.trycloudflare.com
#     → registered with hive at http://localhost:4123
#   (Ctrl+C 停。hive 不受影响。)
```

`tunnel start` 是独立进程，负责：
- spawn `cloudflared tunnel --url http://localhost:4123`
- 解析 URL
- 注册到本地 hive（仅 loopback 的 admin 端点）
- URL 变化时自动推给所有 peer（重启自愈）

需要 `cloudflared` 在 PATH 里（`brew install cloudflared` / `choco install cloudflared` / [releases](https://github.com/cloudflare/cloudflared/releases)）。

之后 `peer invite` / `peer accept` 自动用 tunnel URL，不用传 `--url`。

</details>

<details>
<summary>方式 B：自己跑 cloudflared</summary>

```bash
cloudflared tunnel --url http://localhost:4123
# → https://xxx-yyy-zzz.trycloudflare.com
```
然后给 `peer invite` / `peer accept` 传 `--url https://xxx.trycloudflare.com/mcp`。

</details>

内网/VPN 跳过 tunnel，直接 `http://<host>:4123/mcp` 即可。

**3. 在 mac 生成 invite**
```bash
kitty-hive peer invite --expose <mac-agent-id>
# （自动用 tunnel URL；没 tunnel 加 --url）
# → 输出一个 token：
#   hive://eyJ2IjoxLCJuIjoibWFydmluIi...
```

**4. 在 win 上 accept**
```bash
kitty-hive peer accept 'hive://eyJ2IjoxLCJuIjoibWFydmluIi...' \
  --expose <win-agent-id>
# （自动用 win 的 tunnel URL；要覆盖加 --url）
# 输出：
#   ✓ Decoded invite from "marvin"
#   ✓ Added marvin as local peer
#   ✓ Calling handshake on https://mac-tunnel.../mcp… ok (they added you as "win-laptop")
#   ✓ Pinging marvin… ok (node="marvin")
#   🎉 Peer "marvin" connected.
```

完事 —— 双向 peer 已建立。不用手动复制密钥，不用第二次 `peer add`。

**5. 验证**
```bash
kitty-hive status
# 🤝 Peers 表里 STATUS=active、NODE=<对方节点名> 即成功
```

<details>
<summary>手动两步法（invite/accept 回不到对面时备选）</summary>

如果接收方没法 HTTP 回连发起方（特殊防火墙等），用 `peer add` + 共享密钥手动加：

```bash
# mac
kitty-hive peer add win https://win-tunnel.trycloudflare.com/mcp \
  --secret <共享密钥> --expose <mac-agent-id>

# win
kitty-hive peer add marvin https://mac-tunnel.trycloudflare.com/mcp \
  --secret <共享密钥> --expose <win-agent-id>
```

这个手动流程里**双方必须粘贴一模一样的 `--secret`**。第一次 add 时另一边还没加你的 peer 记录，会显示 `failed: HTTP 401` —— 没事，下一次 60s 心跳两边都会转 `active`。

</details>

### 在 agent 里用

```js
hive-remote-agents({ peer: "win" })
// → win 暴露的 agent 列表（缓存 5 分钟；传 fresh:true 强制刷新）

hive-dm({ to: "<alice-id>@win", content: "hello from mac" })
hive-task({ to: "<alice-id>@win", title: "Review my PR" })
hive-check({ task_id: "<影子任务-id>" })   // 实时同步对面进度
```

回复对方发来的 DM **不需要再带 `@peer`**——本地 placeholder 记得自己来自哪个 peer，直接 `hive-dm({ to: "<placeholder-id>", ... })` 自动反向路由。

### 避坑

- `--expose` 填的是**你这边、允许被对方联系的 agent**；不在列表里的对方完全看不到。**方向容易搞反。**
- 用 agent id 做 `--expose` 最稳；display_name 只在全局唯一时才能用。
- "节点名"（本机 `config set name` 设的、ping 响应里带的）和 "peer 名"（你本地 peer 记录的标签，初始跟对方节点名一样，但冲突时会自动加后缀）是两回事。跨机器寻址用 agent id + 本地 peer 名：`<agent-id>@<peer-name>`。
- peer `status` 只有 ping 成功往返才转 `active`。一直 `inactive` 多半是对方 URL 不可达，或者存的 tunnel URL 过期 —— 看下面 **Tunnel URL 自愈** 和 `kitty-hive peer set-url` 手动应急。

### 工作机制

- **身份：** 每个远端 agent 在本地生成一个 placeholder，按 `(peer_name, remote_agent_id)` 唯一定位。对方 rename 不会断关联；回复路径靠 placeholder 上的 `origin_peer` 字段反向路由。
- **任务：** 委派给 `<id>@peer` 时，发起方建一个**影子任务**，replica 端建真任务。propose / approve / step-complete / reject 等事件双向自动转发，两边状态同步。发起方用 `hive-check` 实时看进度。
- **心跳：** `peer add` 当场 ping；server 每 60s 周期 ping 维护 `peers.status`。`kitty-hive status` 直接显示。
- **Tunnel URL 自愈：** `tunnel start` 拿到新 URL（cloudflared 重启）时，POST 到 hive 的 `/admin/tunnel-url`，hive 再广播 `/federation/update-url` 给所有 peer。心跳 ping 响应也带 `public_url`，下一轮 ping 也能自动更正。
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
kitty-hive peer invite --expose <my-agent> [--url url]      生成 invite token（推荐）
kitty-hive peer accept <token> --expose <my-agent> [--url url]  接受 invite，自动握手
kitty-hive peer add <name> <url> [--expose a,b] [--secret s]  手动加 peer
kitty-hive peer list                                    列出 peer
kitty-hive peer remove <name>                           删除 peer
kitty-hive peer expose <name> --add/--remove <agent>    管理 peer 暴露的 agent
kitty-hive peer set-url <name> <url>                    手动更新 peer 的 URL（自动同步漏掉时应急）
kitty-hive config set <key> <value>                     设置配置（如 name）
kitty-hive db clear [--db path]                         清空数据库
kitty-hive files clean [--days 7]                       清理过期联邦传输文件
kitty-hive tunnel start [--port 4123]                   启动 cloudflared，自动注册 URL 给 hive
kitty-hive tunnel status [--port 4123]                  查看当前注册的 tunnel URL
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
| 数据库 | SQLite WAL — `agents`、`teams`、`team_members`、`team_events`、`dm_messages`（含 `attachments` JSON）、`tasks`（含联邦字段）、`task_events`、`read_cursors`、`peers`、`pending_invites`、`node_state` |
| 传输 | MCP Streamable HTTP（POST + GET SSE） |
| 推送 | Channel plugin → `notifications/claude/channel`。跟踪活跃 SSE，丢包时打 warning |
| 认证 | Session 绑定 · `as` 参数 · Bearer token · peer secret |
| 联邦 | HTTP peering、`id@node` 寻址、文件传输 |

## 版本计划

详见 [docs/roadmap.md](docs/roadmap.md)。

## License

MIT
