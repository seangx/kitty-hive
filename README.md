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

Connect two (or more) hive servers across machines so agents can DM and delegate tasks across them.

### Two-machine walkthrough (invite/accept — recommended)

Suppose you have **mac** (locally) and **win** (a second machine). Both have `kitty-hive serve` running and at least one registered agent.

**1. Name each node**
```bash
# mac
kitty-hive config set name marvin
# win
kitty-hive config set name win-laptop
```

**2. Make each side reachable.** Easiest with no public IP — Cloudflare Tunnel.
You have two options:

<details open>
<summary><b>Option A (recommended): let kitty-hive manage cloudflared</b></summary>

Open a separate terminal on each machine:
```bash
kitty-hive tunnel start
# → 🌀 Starting cloudflared…
#   ✓ Tunnel URL: https://xxx-yyy-zzz.trycloudflare.com
#     → registered with hive at http://localhost:4123
#   (Ctrl+C to stop. The hive will keep running.)
```

`tunnel start` is a separate process that:
- spawns `cloudflared tunnel --url http://localhost:4123`
- parses the URL out of cloudflared's output
- registers it with the local hive (loopback-only admin endpoint)
- pushes URL changes to all peers automatically (so reboots/restarts self-heal)

Requires `cloudflared` on PATH (`brew install cloudflared` / `choco install cloudflared` / [releases](https://github.com/cloudflare/cloudflared/releases)).

After this, `peer invite` and `peer accept` will pick up the tunnel URL automatically — you can skip `--url`.

</details>

<details>
<summary>Option B: run cloudflared yourself</summary>

```bash
cloudflared tunnel --url http://localhost:4123
# → https://xxx-yyy-zzz.trycloudflare.com
```
Then pass `--url https://xxx.trycloudflare.com/mcp` to `peer invite` / `peer accept`.

</details>

On a LAN/VPN you can skip the tunnel entirely and use `http://<host>:4123/mcp`.

**3. Generate an invite on mac**
```bash
kitty-hive peer invite --expose <mac-agent-id>
# (auto-uses tunnel URL if `tunnel start` is running; otherwise pass --url)
# → prints a single token like:
#   hive://eyJ2IjoxLCJuIjoibWFydmluIi...
```

**4. Accept on win**
```bash
kitty-hive peer accept 'hive://eyJ2IjoxLCJuIjoibWFydmluIi...' \
  --expose <win-agent-id>
# (auto-uses win's tunnel URL; pass --url to override)
# Output:
#   ✓ Decoded invite from "marvin"
#   ✓ Added marvin as local peer
#   ✓ Calling handshake on https://mac-tunnel.../mcp… ok (they added you as "win-laptop")
#   ✓ Pinging marvin… ok (node="marvin")
#   🎉 Peer "marvin" connected.
```

That's it — both sides are peered. No manual secret copying, no second `peer add`.

**5. Verify**
```bash
kitty-hive status
# 🤝 Peers table should show STATUS=active and NODE=<remote-node-name>
```

<details>
<summary>Manual two-step alternative (if invite/accept can't reach back)</summary>

If the invitee can't HTTP back to the inviter (firewalled tunnel, etc.), use plain `peer add` on both sides with the same `--secret`:

```bash
# mac
kitty-hive peer add win https://win-tunnel.trycloudflare.com/mcp \
  --secret <shared-secret> --expose <mac-agent-id>

# win
kitty-hive peer add marvin https://mac-tunnel.trycloudflare.com/mcp \
  --secret <shared-secret> --expose <win-agent-id>
```

The first `add` may print `failed: HTTP 401` because the other side hasn't added you yet — that's fine; the next 60s heartbeat will flip both to `active`.

</details>

### Using it from your agent

```js
hive-remote-agents({ peer: "win" })
// → list of agents win has exposed (cached 5 min; pass fresh:true to bypass)

hive-dm({ to: "<alice-id>@win", content: "hello from mac" })
hive-task({ to: "<alice-id>@win", title: "Review my PR" })
hive-check({ task_id: "<shadow-task-id>" })   // live progress synced from win
```

Replying to an incoming federated DM **does not** need `@peer` — your local placeholder for the remote sender remembers its origin, so plain `hive-dm({ to: "<placeholder-id>", ... })` routes back automatically.

### Pitfalls

- `--expose` lists **the agent the *peer* should be allowed to reach** (i.e. agents on YOUR side). Anything not listed is invisible to that peer.
- Both sides must use the exact same `--secret`.
- `--expose` accepts agent ids or unambiguous display names; ids are safer.
- Peer status only flips to `active` on a successful round-trip ping. If it stays `inactive`, check the URL is reachable from the other side and the secret matches.

### How it works

- **Identity:** every remote agent gets a local placeholder keyed by `(peer_name, remote_agent_id)`. Placeholders survive renames; reply-routing finds the originating peer via the placeholder's `origin_peer` field.
- **Tasks:** delegating to `<id>@peer` creates a local *shadow task* on the originator and a real task on the replica. Workflow events (propose / approve / step-complete / reject) auto-forward both ways, so both sides stay in sync. The originator can `hive-check` to see live progress.
- **Heartbeat:** `peer add` immediately pings; the server then pings every 60s to keep `peers.status` accurate. `kitty-hive status` shows it.
- **Tunnel URL self-heal:** when `tunnel start` gets a new URL (cloudflared restart), it pushes to the hive via `/admin/tunnel-url`, which broadcasts to all peers via `/federation/update-url`. Heartbeat ping responses also carry `public_url` so peers self-correct on the next ping cycle.
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
kitty-hive peer invite --expose <my-agent> [--url url]      Create an invite token (recommended)
kitty-hive peer accept <token> --expose <my-agent> [--url url]  Accept an invite token (auto-handshake)
kitty-hive peer add <name> <url> [--expose a,b] [--secret s]  Add a peer manually
kitty-hive peer list                                    List peers
kitty-hive peer remove <name>                           Remove a peer
kitty-hive peer expose <name> --add/--remove <agent>    Manage exposed agents
kitty-hive config set <key> <value>                     Set config (e.g. name)
kitty-hive db clear [--db path]                         Clear the database
kitty-hive files clean [--days 7]                       Remove old federation transfer files
kitty-hive tunnel start [--port 4123]                   Run cloudflared & register URL with the hive
kitty-hive tunnel status [--port 4123]                  Show currently registered tunnel URL
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
