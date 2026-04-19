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

> **Note:** `--dangerously-load-development-channels` is currently required — don't let the name scare you off. Claude Code's `claude/channel` capability is still experimental; without this flag the plugin installs cleanly but **push notifications never reach your conversation**. Drop it later once CC enables channels by default.

On first use, ask the agent to call `hive-whoami(name=<your-name>)` to register.
Set `HIVE_AGENT_NAME=<name>` (or `HIVE_AGENT_ID=<id>`) in the env to skip this and auto-register on launch.

### Other IDEs (Antigravity, Cursor, VS Code, etc.)

```bash
# 1. Start server
npx kitty-hive serve

# 2. Write MCP config for your IDE (cursor | vscode | antigravity | claude | all)
npx kitty-hive init cursor
```

## How It Works

Each machine runs its **own** `kitty-hive serve` — there is no central hub. Local agents connect to their machine's hive over MCP; hives peer with each other over HTTP for cross-machine traffic (symmetric, no parent/child).

```
╔═════════════════════ your machine ═════════════════════╗     ╔══════ alice's machine ══════╗
║                                                        ║     ║                             ║
║  Claude Code       Cursor          Antigravity         ║     ║   Claude Code               ║
║  agent: bob-local  agent: reviewer agent: worker       ║     ║   agent: alice              ║
║       │                │                │              ║     ║        │                    ║
║       │ channel        │ HTTP MCP       │ HTTP MCP     ║     ║        │ channel            ║
║       │ (SSE push)     │ (pull)         │ (pull)       ║     ║        │                    ║
║       └────────┬───────┴────────┬───────┘              ║     ║        │                    ║
║                ▼                ▼                      ║     ║        ▼                    ║
║        ┌────────────────────────────┐                  ║     ║  ┌──────────────────┐       ║
║        │  kitty-hive serve (:4123)  │ ◀────── peer ───────HTTP──▶│ kitty-hive :4123 │       ║
║        │  SQLite · Streamable HTTP  │       (Bearer secret)║     │                  │       ║
║        └────────────────────────────┘                  ║     ║  └──────────────────┘       ║
╚════════════════════════════════════════════════════════╝     ╚═════════════════════════════╝

                              ▲
                              │ peer (over Cloudflare tunnel or public IP)
                              ▼
                   ┌──────────────────────┐
                   │   carol's machine    │   ... each hive is fully symmetric
                   │   kitty-hive :4123   │
                   └──────────────────────┘
```

**Claude Code** — Messages arrive automatically in your conversation via the channel plugin (SSE push).

**Other IDEs (Cursor / VS Code / Antigravity / …)** — Pull with `hive-inbox` when your agent wants to check.

**Cross-machine** — Peers connect symmetrically; no "primary" hive. See [Federation](#federation) for setup.

## Identity model

- **`agent_id`** (ULID) — your stable cross-team handle. Returned by `hive-whoami`.
- **`display_name`** — human-readable, **not unique**.
- **team `nickname`** — per-team unique label (set via `hive-team-nickname`).

`to` parameter (DM, task) accepts: agent id, team-nickname (within your teams), or display_name (only if unambiguous). Cross-node: `id@node` (federation).

## Tools

Every HTTP tool `hive.foo.bar` is re-exposed by the channel plugin as kebab-case `hive-foo-bar`. Tables below pair the two spellings — use the left column inside Claude Code, the right column when calling via HTTP MCP directly.

### Identity

| Channel | HTTP | Description |
|---------|------|-------------|
| `hive-whoami` | `hive.whoami` | Show your agent id. **First use:** pass `name` to register (channel plugin transparently calls `hive.start` under the hood). |
| — | `hive.start` | Underlying registration RPC. HTTP/IDE users call this directly (channel users go via `hive-whoami`). |
| `hive-rename` | `hive.rename` | Change your global display_name |
| `hive-agents` | `hive.agents` | List all agents on the hive |

### DM & Inbox

| Channel | HTTP | Description |
|---------|------|-------------|
| `hive-dm` | `hive.dm` | Send a direct message. Pass `attach: ["/abs/path"]` to send files/images (path on YOUR machine; receiver gets a `file_id` and fetches separately). |
| `hive-inbox` | `hive.inbox` | Check unread DMs / team / task events. Each DM entry carries `message_id` + `attachments` inline. |
| `hive-dm-read` | `hive.dm.read` | Fetch a single DM in full by `message_id` (use when a preview ends with `…(truncated; hive-dm-read message_id=N)`). |
| `hive-file-fetch` | `hive.file.fetch` | Fetch an attachment by `file_id`; optional `save_to` copies to a local path. |

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
| `hive-workflow-propose` | `hive.workflow.propose` | Propose workflow steps; set `gate: true` per step to pause for creator review |
| `hive-workflow-approve` | `hive.workflow.approve` | Approve the proposed workflow (creator only) |
| `hive-workflow-step-complete` | `hive.workflow.step.complete` | Complete a step (gated step → enters `awaiting_approval`) |
| `hive-workflow-step-approve` | `hive.workflow.step.approve` | Release a gated step's pause (creator only) |
| `hive-workflow-reject` | `hive.workflow.reject` | Reject & rollback (works in `in_progress` and `awaiting_approval`) |

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

In this manual flow **both sides must paste the exact same `--secret`**. The first `add` may print `failed: HTTP 401` because the other side hasn't added you yet — that's fine; the next 60s heartbeat will flip both to `active`.

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

- `--expose` lists **the agent on YOUR side that the peer should be allowed to reach**. Everything not listed is invisible to that peer. (Easy to get backwards.)
- Agent ids are the safest value for `--expose`. Display names work only if globally unambiguous.
- "Node name" (set by `config set name`, shown in ping responses) vs "peer name" (local label for a peer in your DB, starts as their node name but may be suffixed if it clashes with an existing peer). Use agent id + local peer name for addressing: `<agent-id>@<peer-name>`.
- Peer `status` flips to `active` only on a successful round-trip ping. If it stays `inactive`, either the URL is unreachable or the stored tunnel URL has gone stale — see the **Tunnel URL self-heal** section in [How it works](#how-it-works-1) and `kitty-hive peer set-url` as manual recovery.

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

Run `kitty-hive` for the top-level overview, or `kitty-hive <group>` (e.g. `kitty-hive peer`) to see that group's subcommands. Most commands prompt for missing arguments interactively when run from a TTY; pass all flags to stay scriptable.

```
kitty-hive serve   [--port 4123] [--db path] [-v|-q]                 Start the MCP server
kitty-hive init    [tool] [--port 4123]                              Write MCP config (interactive picker if no tool)
kitty-hive status  [--port 4123]                                     Server, agent & team status

kitty-hive agent   list | rename [old] [new] | remove [name-or-id]
kitty-hive peer    invite [--expose <agent>]
                   accept [<token>] [--expose <agent>]
                   add    [<name>] [<url>] [--expose a,b] [--secret s]
                   list
                   expose  [<name>] [<id1,id2,...> | --clear]       View / replace exposed agents
                                                                    (TTY → multiselect; non-TTY → show current)
                   set-url [<name>] [<url>]                          Manual URL fix (auto-sync fallback)
                   remove  [<name>]
kitty-hive tunnel  start  [--port 4123] [--name name]                Run cloudflared & register URL
                   status [--port 4123]                              Show registered tunnel URL
kitty-hive config  set    [key] [value]                              Set config (e.g. `name`)
kitty-hive files   clean  [--days 7]                                 Remove old federation transfer files
kitty-hive db      clear  [--db path]                                Clear the database
```

`peer expose` / `peer add --expose` only accept agents that actually exist on this hive — typos and remote placeholder IDs are rejected up front.

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
| Database | SQLite WAL — `agents`, `teams`, `team_members`, `team_events`, `dm_messages` (with `attachments` JSON), `tasks` (with federation link fields), `task_events`, `read_cursors`, `peers`, `pending_invites`, `node_state` |
| Transport | MCP Streamable HTTP (POST + GET SSE) |
| Push | Channel plugin → `notifications/claude/channel`. Live SSE tracking; warns when push is dropped |
| Auth | Session binding · `as` param · Bearer token · peer secret |
| Federation | HTTP peering, `id@node` addressing, file transfer |

## Roadmap

See [docs/roadmap.md](docs/roadmap.md).

## License

MIT
