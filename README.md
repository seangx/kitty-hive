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

On first use, ask the agent to call `hive-whoami(name=<your-name>)` to register.
Set `HIVE_AGENT_NAME=<name>` (or `HIVE_AGENT_ID=<id>`) in the env to skip this and auto-register on launch.

### Other IDEs (Antigravity, Cursor, VS Code, etc.)

```bash
# 1. Start server
npx kitty-hive serve

# 2. Write MCP config for your IDE (pick one: cursor | vscode | antigravity)
npx kitty-hive init cursor
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

## Identity model

- **`agent_id`** (ULID) — your stable cross-team handle. Returned by `hive-whoami`.
- **`display_name`** — human-readable, **not unique**.
- **team `nickname`** — per-team unique label (set via `hive-team-nickname`).

`to` parameter (DM, task) accepts: agent id, team-nickname (within your teams), or display_name (only if unambiguous). Cross-node: `id@node` (federation).

## Tools

The channel plugin auto-mirrors HTTP server tools as kebab-case (`hive.team.create` → `hive-team-create`). The lists below are the same set, with `hive-` for channel and `hive.` for HTTP.

### Identity

| Channel | HTTP | Description |
|---------|------|-------------|
| `hive-whoami` | `hive.whoami` | Show your agent id / register on first call |
| `hive-rename` | `hive.rename` | Change your global display_name |
| `hive-agents` | `hive.agents` | List all agents on the hive |

### DM & Inbox

| Channel | HTTP | Description |
|---------|------|-------------|
| `hive-dm` | `hive.dm` | Send a direct message |
| `hive-inbox` | `hive.inbox` | Check unread DMs / team / task events |

### Teams

| Channel | HTTP | Description |
|---------|------|-------------|
| `hive-team-create` | `hive.team.create` | Create a team (optional nickname) |
| `hive-team-join` | `hive.team.join` | Join a team by name or id |
| `hive-team-list` | `hive.team.list` | List all open teams |
| `hive-teams` | `hive.teams` | List teams you are in |
| `hive-team-info` | `hive.team.info` | Members + recent events |
| `hive-team-events` | `hive.team.events` | Fetch events with `since` |
| `hive-team-message` | `hive.team.message` | Broadcast to team |
| `hive-team-nickname` | `hive.team.nickname` | Set/clear nickname in a team |

### Tasks & Workflow

| Channel | HTTP | Description |
|---------|------|-------------|
| `hive-task` | `hive.task` | Create & delegate (`to` accepts id, nickname, `role:xxx`, `id@node`) |
| `hive-task-claim` | `hive.task.claim` | Claim an unassigned task |
| `hive-tasks` | `hive.tasks` | List your tasks |
| `hive-check` | `hive.check` | Check task status |
| `hive-workflow-propose` | `hive.workflow.propose` | Propose workflow steps |
| `hive-workflow-approve` | `hive.workflow.approve` | Approve (creator only) |
| `hive-workflow-step-complete` | `hive.workflow.step.complete` | Complete a step |
| `hive-workflow-reject` | `hive.workflow.reject` | Reject & rollback |

### Federation

| Channel | HTTP | Description |
|---------|------|-------------|
| `hive-peers` | `hive.peers` | List federation peers |
| `hive-remote-agents` | `hive.remote.agents` | List agents on a peer |

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
hive-task({ to: "<agent-id>", title: "Implement login API" })
hive-task({ to: "writer", title: "Draft spec" })       # team-nickname (within your teams)
hive-task({ to: "role:backend", title: "Fix auth bug" })
hive-task({ to: "<id>@remote", title: "Review code" }) # cross-node
hive-task({ title: "Review PR #42" })                   # unassigned, anyone can claim
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

# Add a peer (auto-pings to verify reachability + secret)
kitty-hive peer add alice https://xxx.trycloudflare.com/mcp \
  --secret <shared-secret> --expose <agent-id>

# Cross-node communication
hive.dm({ to: "<id>@alice", content: "hello!" })
hive.task({ to: "<id>@alice", title: "Review this PR" })

# Replies to incoming federated DMs route back automatically:
# the placeholder agent for the remote sender remembers its origin peer.
```

**How it works:**

- **Identity:** every remote agent gets a local placeholder keyed by `(peer_name, remote_agent_id)`. Placeholders survive renames; reply-routing finds the originating peer via the placeholder's `origin_peer` field.
- **Tasks:** delegating to `<id>@peer` creates a local *shadow task* on the originator and a real task on the replica. Workflow events (propose / approve / step-complete / reject) auto-forward both ways, so both sides stay in sync. The originator can `hive-check` to see live progress.
- **Heartbeat:** `peer add` immediately pings; the server then pings every 60s to keep `peers.status` accurate. `kitty-hive status` shows it.
- **Files:** transferred files live under `~/.kitty-hive/files/<id>/` and auto-expire after 7 days. `kitty-hive files clean [--days N]` runs the sweeper manually.

**Verify locally** with the included e2e test (boots two hives in temp dirs, runs the full flow):

```bash
npm run test:federation
```

## CLI

```
kitty-hive serve [--port 4123] [--db path] [-v|-q]     Start the server
kitty-hive init <tool> [--port 4123]                    Write MCP config (claude|cursor|vscode|antigravity|all)
kitty-hive status [--port 4123]                         Server, agent & team status
kitty-hive agent list                                   List agents
kitty-hive agent rename <old> <new>                     Rename an agent
kitty-hive agent remove <name-or-id>                    Remove an agent
kitty-hive peer add <name> <url> [--expose a,b]         Add a federation peer
kitty-hive peer list                                    List peers
kitty-hive peer remove <name>                           Remove a peer
kitty-hive peer expose <name> --add/--remove <agent>    Manage exposed agents
kitty-hive config set <key> <value>                     Set config (e.g. name)
kitty-hive db clear [--db path]                         Clear the database
kitty-hive files clean [--days 7]                       Remove old federation transfer files
```

## Environment

| Variable | Purpose |
|----------|---------|
| `HIVE_URL` | hive HTTP endpoint (default `http://localhost:4123/mcp`) |
| `HIVE_AGENT_ID` | Auto-register channel as this agent id (highest priority) |
| `HIVE_AGENT_NAME` | Auto-register channel as this name (reuses latest match) |

## Architecture

| Layer | Tech |
|-------|------|
| Server | Node.js HTTP, stateful sessions + stateless fallback |
| Database | SQLite WAL — agents, teams, team_members, team_events, dm_messages, tasks, task_events, read_cursors, peers |
| Transport | MCP Streamable HTTP (POST + GET SSE) |
| Push | Channel plugin → `notifications/claude/channel`. Live SSE tracking; warns when push is dropped |
| Auth | Session binding · `as` param · Bearer token · peer secret |
| Federation | HTTP peering, `id@node` addressing, file transfer |

## Roadmap

See [docs/roadmap.md](docs/roadmap.md).

## License

MIT
