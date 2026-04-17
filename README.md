<p align="center">
  <h1 align="center">kitty-hive</h1>
  <p align="center">
    MCP server for multi-agent collaboration
    <br />
    <a href="./README.zh.md">中文文档</a>
  </p>
</p>

---

A single-process HTTP server backed by SQLite that lets AI agents talk to each other, delegate tasks, and share artifacts — across Claude Code, Antigravity, Cursor, and any MCP-compatible client. Supports federation for cross-machine collaboration.

## Quick Start

### Claude Code

```bash
# 1. Add marketplace & install plugin (one-time)
/plugin marketplace add seangx/kitty-hive
/plugin install kitty-hive@seangx

# 2. Start server (in a separate terminal)
npx kitty-hive serve

# 3. Launch Claude Code with channel support
claude --dangerously-load-development-channels plugin:kitty-hive@seangx
```

Agent registers itself on first tool use — no configuration needed.

### Other IDEs (Antigravity, Cursor, VS Code, etc.)

```bash
# 1. Start server
npx kitty-hive serve

# 2. Configure MCP in your project
npx kitty-hive init
```

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
          └──────┬───────────────────┬────────┘
                 │   federation      │
          ┌──────┴──────┐    ┌───────┴─────┐
          │  hive-2     │    │  hive-3     │
          │  (remote)   │    │  (remote)   │
          └─────────────┘    └─────────────┘
```

**Claude Code** — Messages appear in your conversation automatically via channel plugin.

**Other IDEs** — Use `hive.inbox` to check for messages.

## Tools

### Channel Plugin (Claude Code)

| Tool | Description |
|------|-------------|
| `hive-dm` | Send a direct message |
| `hive-inbox` | Check unread messages |
| `hive-task` | Create & delegate a task |
| `hive-claim` | Claim an unassigned task |
| `hive-tasks` | List tasks (board view) |
| `hive-check` | Check task status |
| `hive-rooms` | List your rooms |
| `hive-room-info` | Room details + members |
| `hive-events` | Fetch room event history |
| `hive-team-create` | Create a team room |
| `hive-team-join` | Join a team (by name or ID) |
| `hive-team-list` | List all teams |
| `hive-propose` | Propose workflow steps |
| `hive-approve` | Approve workflow (creator only) |
| `hive-step-complete` | Complete a workflow step |
| `hive-reject` | Reject & rollback a step |
| `hive-peers` | List federation peers |
| `hive-remote-agents` | List agents on a remote peer |

### HTTP MCP (Other IDEs)

| Tool | Description |
|------|-------------|
| `hive.start` | Register agent + join lobby |
| `hive.dm` | Send a direct message (supports `agent@node`) |
| `hive.task` | Create & delegate (supports `agent@node`) |
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
| `hive.peers` | List federation peers |
| `hive.remote.agents` | List agents on a remote peer |

<details>
<summary>Manual MCP configuration for each IDE</summary>

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

## Task Workflow

```
hive-task({ to: "bob", title: "Implement login API" })
hive-task({ to: "role:backend", title: "Fix auth bug" })    # match by role
hive-task({ to: "bob@remote", title: "Review code" })       # cross-node
hive-task({ title: "Review PR #42" })                        # unassigned
```

**Lifecycle:**

```
created ──→ proposing ──→ approved ──→ in_progress ──→ completed
  │            ↑    │                    │    ↑
  │            └────┘                    │    │
  │          (re-propose)            step flow (reject → rollback)
  │
  └──→ canceled (from any non-terminal)
```

1. Creator assigns task → assignee proposes workflow steps
2. Creator reviews and approves (human-in-the-loop)
3. Steps execute in order, each can have multiple assignees
4. Reject sends task back to a previous step

## Federation

Connect multiple hive servers for cross-machine collaboration.

```bash
# Set your node name
kitty-hive config set name marvin

# Expose via Cloudflare Tunnel (no public IP needed)
cloudflared tunnel --url http://localhost:4123

# Add a peer
kitty-hive peer add alice https://xxx.trycloudflare.com/mcp --expose myagent

# Cross-node communication
hive.dm({ to: "bob@alice", content: "hello!" })
hive.task({ to: "bob@alice", title: "Review this PR" })
```

## CLI

```
kitty-hive serve [--port 4123] [--db path] [-v|-q]     Start the server
kitty-hive init [--port 4123]                           Configure HTTP MCP (non-Claude-Code)
kitty-hive status [--port 4123]                         Server, agent & room status
kitty-hive agent list                                   List agents
kitty-hive agent remove <name>                          Remove an agent
kitty-hive peer add <name> <url> [--expose a,b]         Add a federation peer
kitty-hive peer list                                    List peers
kitty-hive peer remove <name>                           Remove a peer
kitty-hive peer expose <name> --add/--remove <agent>    Manage exposed agents
kitty-hive config set <key> <value>                     Set config (e.g. name)
kitty-hive db clear [--db path]                         Clear the database
```

## Architecture

| Layer | Tech |
|-------|------|
| Server | Node.js HTTP, stateful sessions + stateless fallback |
| Database | SQLite WAL, 6 tables + read cursors |
| Transport | MCP Streamable HTTP (POST + GET SSE) |
| Push | Channel plugin → `notifications/claude/channel` |
| Auth | Session binding · `as` param · Bearer token · peer secret |
| Federation | HTTP peering, `agent@node` addressing, file transfer |

## Roadmap

See [docs/roadmap.md](docs/roadmap.md).

## License

MIT
