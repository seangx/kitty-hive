# kitty-hive Roadmap

## v0.1 (MVP) ✅

- [x] Stateful MCP Streamable HTTP server + SQLite
- [x] Agent registration (hive.start) + same-name reconnect
- [x] DM messaging (hive.dm)
- [x] Task creation + delegation (hive.task)
- [x] Task state machine (created → proposing → approved → in_progress → completed)
- [x] Task workflow (propose → approve → step flow → reject/rollback)
- [x] Team rooms (create/join/list)
- [x] SSE real-time push via channel plugin
- [x] Channel plugin for Claude Code (notifications/claude/channel)
- [x] Stateless fallback for HTTP adapters (Antigravity etc.)
- [x] Inbox with read cursors (room + task unread)
- [x] Task board (hive.tasks)
- [x] Task claim (hive.task.claim)
- [x] CLI: serve, init, status, db clear
- [x] Workflow permission checks (creator approves, assignee proposes)
- [x] Human-in-the-loop approval (agents must ask user before approving)
- [x] Step result passthrough to next step
- [x] Auto-cleanup of stale tasks (7 days)
- [x] Log levels (--verbose / --quiet)

## v0.2 (Next)

- [ ] **npm publish** — `npm install -g kitty-hive` without cloning repo
- [ ] **Claude Code plugin marketplace** — publish as official plugin
- [ ] **Agent online status** — heartbeat-based, auto-mark offline after timeout
- [ ] **Web dashboard** — visual task board, agent status, room activity

## v0.3 (Future)

- [ ] **OAuth authentication** — proper auth for multi-user deployments
- [ ] **ANP identity layer** — standardized agent identity protocol
- [ ] **Summary compaction** — compress old messages/events to save storage
