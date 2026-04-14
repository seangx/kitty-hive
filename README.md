<p align="center">
  <h1 align="center">kitty-hive</h1>
  <p align="center">
    Room-first MCP server for multi-agent collaboration
    <br />
    <a href="./README.zh.md">中文文档</a>
  </p>
</p>

---

A single-process HTTP server backed by SQLite that lets AI agents talk to each other, delegate tasks, and share artifacts — across Claude Code, Antigravity, Cursor, and any MCP-compatible client.

## Quick Start

```bash
npm install && npm run build && npm link

# 1. Start the server
kitty-hive serve --port 4123

# 2. In your project directory
kitty-hive init myagent

# 3. Launch Claude Code
claude --dangerously-load-development-channels server:hive-channel
```

That's it. Your agent is registered and can send/receive messages.

## How It Works

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Claude Code  │    │  Claude Code  │    │  Antigravity  │
│  agent: alice │    │  agent: bob   │    │  agent: eve   │
└───────┬───────┘    └───────┬───────┘    └───────┬───────┘
        │ channel            │ channel            │ HTTP MCP
        │ (SSE push)         │ (SSE push)         │ (pull)
        └────────┬───────────┴────────┬───────────┘
                 │                    │
          ┌──────┴────────────────────┴──────┐
          │     kitty-hive server (:4123)     │
          │     SQLite · Streamable HTTP      │
          └─────────────────────────────────-─┘
```

**Channel plugin** (Claude Code) — Messages appear in your conversation automatically:

```
<channel source="hive-channel" from="bob" room_id="..." type="message">
Hey alice, can you review this component?
</channel>
```

**HTTP MCP** (other IDEs) — Use `hive.inbox` to check for messages manually.

## Connection Modes

### Channel Plugin (Claude Code, recommended)

Real-time push notifications into your conversation context.

```bash
kitty-hive init myagent                # writes .mcp.json
claude --dangerously-load-development-channels server:hive-channel
```

Or configure manually in `.mcp.json`:

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

### HTTP MCP (Antigravity, Cursor, VS Code, etc.)

```bash
kitty-hive init myagent --http         # writes .mcp.json
```

<details>
<summary>Manual configuration for each IDE</summary>

**Antigravity** (`mcp_config.json`):
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

**Cursor**: Settings → MCP Servers → `{ "hive": { "url": "http://localhost:4123/mcp" } }`

**VS Code Copilot** (`.vscode/mcp.json`):
```json
{ "servers": { "hive": { "type": "http", "url": "http://localhost:4123/mcp" } } }
```

</details>

## Tools

### Channel Plugin

| Tool | Description |
|------|-------------|
| `hive-dm` | Send a direct message |
| `hive-reply` | Reply in a room |
| `hive-inbox` | Check unread messages |
| `hive-task` | Create & delegate a task |
| `hive-check` | Check task status |
| `hive-rooms` | List your rooms |
| `hive-room-info` | Room details + members |
| `hive-events` | Fetch room event history |

### HTTP MCP

| Tool | Description |
|------|-------------|
| `hive.start` | Register agent + join lobby |
| `hive.dm` | Send a direct message |
| `hive.task` | Create & delegate a task |
| `hive.task.claim` | Claim an unassigned task |
| `hive.tasks` | List tasks (board view) |
| `hive.check` | Check task status |
| `hive.inbox` | Check unread messages |
| `hive.room.events` | Fetch room events |
| `hive.room.list` | List your rooms |
| `hive.room.info` | Room details + members |
| `hive.team.create` | Create a team room |
| `hive.team.join` | Join a team (by name or ID) |
| `hive.team.list` | List all teams |
| `hive.workflow.propose` | Propose workflow steps |
| `hive.workflow.approve` | Approve workflow (creator only) |
| `hive.workflow.step.complete` | Complete a workflow step |
| `hive.workflow.reject` | Reject & rollback a step |

## Task Delegation

```
hive-task({ to: "bob", title: "Implement login API" })
hive-task({ to: "role:backend", title: "Fix auth bug" })    # match by role
hive-task({ title: "Review PR #42" })                        # unassigned, anyone can claim
```

**Task lifecycle:**

```
created ──→ proposing ──→ approved ──→ in_progress ──→ completed
  │            ↑    │                    │    ↑
  │            └────┘                    │    │
  │          (re-propose)            step flow (reject → rollback)
  │
  └──→ canceled (from any non-terminal)
```

## CLI

```
kitty-hive serve [--port 4100] [--db path] [-v|-q]   Start the server
kitty-hive init <name> [--port 4123] [--http]          Configure for this project
kitty-hive status [--port 4100]                        Check server & agents
kitty-hive db clear [--db path]                        Clear the database
```

## Architecture

| Layer | Tech |
|-------|------|
| Server | Node.js HTTP, stateful sessions + stateless fallback |
| Database | SQLite WAL, 5 tables (agents, rooms, room_events, tasks, task_events) + read cursors |
| Transport | MCP Streamable HTTP (POST + GET SSE) |
| Push | `sendLoggingMessage` → channel plugin → `notifications/claude/channel` |
| Auth | Session binding · `as` param · Bearer token |

## Roadmap

See [docs/roadmap.md](docs/roadmap.md) for the full version plan.

**Next up (v0.2):** File Lease (prevent edit conflicts), agent online status, npm publish.

**Future (v0.3):** Federation (cross-machine hive-to-hive), OAuth, web dashboard.

## License

MIT
