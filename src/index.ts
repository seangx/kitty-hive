#!/usr/bin/env node

import { startServer, setLogLevel } from './server.js';
import { initDB, addPeer, listPeers, removePeer, updatePeerExposed, getPeerByName, setPeerNodeName, setPeerStatus, touchPeer, setPeerUrl, createPendingInvite, deletePendingInvite, cleanupExpiredInvites, getNodeState, getDMLog, getAgentById, listAllAgents, getTeamEvents, getTeamByName, getTeamById, getTaskById, getTaskEvents } from './db.js';
import { pingPeer } from './federation-heartbeat.js';
import { TunnelManager, findCloudflared } from './tunnel.js';
import { generateToken } from './utils.js';
import {
  askText, askSelect, askMultiselect, askConfirm,
  pickLocalAgent, pickLocalAgents, pickPeer, isLocalAgent, isInteractive,
} from './interactive.js';
import { writeFileSync, existsSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname } from 'node:os';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);
const command = args[0];

function parseFlags(startIdx: number) {
  let port = 4123;
  let dbPath: string | undefined;
  for (let i = startIdx; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--db' && args[i + 1]) {
      dbPath = args[i + 1];
      i++;
    }
  }
  return { port, dbPath };
}

// --- Commands ---

async function cmdServe() {
  const { port, dbPath } = parseFlags(1);
  if (args.includes('--verbose') || args.includes('-v')) setLogLevel('debug');
  if (args.includes('--quiet') || args.includes('-q')) setLogLevel('warn');
  await startServer(port, dbPath);
}

const INIT_TOOLS = ['claude', 'cursor', 'vscode'] as const;
type InitTool = typeof INIT_TOOLS[number];
const ALL_INIT_TARGETS = ['claude', 'cursor', 'vscode', 'antigravity'] as const;

function findNpx(): string {
  const probe = process.platform === 'win32' ? 'where npx' : 'command -v npx';
  try {
    const out = execSync(probe, { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
    return out || 'npx';
  } catch { return 'npx'; }
}

function readJson(path: string): any {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

function writeJson(path: string, data: any) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

function writeForTool(tool: InitTool, port: number): string {
  const url = `http://localhost:${port}/mcp`;
  const cwd = process.cwd();

  if (tool === 'claude') {
    const p = join(cwd, '.mcp.json');
    const data = readJson(p);
    if (!data.mcpServers) data.mcpServers = {};
    data.mcpServers['hive'] = { url };
    delete data.mcpServers['hive-channel'];
    writeJson(p, data);
    return p;
  }

  if (tool === 'cursor') {
    const p = join(cwd, '.cursor', 'mcp.json');
    const data = readJson(p);
    if (!data.mcpServers) data.mcpServers = {};
    data.mcpServers['hive'] = { url };
    writeJson(p, data);
    return p;
  }

  if (tool === 'vscode') {
    const p = join(cwd, '.vscode', 'mcp.json');
    const data = readJson(p);
    if (!data.servers) data.servers = {};
    data.servers['hive'] = { type: 'http', url };
    writeJson(p, data);
    return p;
  }

  throw new Error(`Unknown tool: ${tool}`);
}

function antigravitySnippet(port: number): string {
  // Antigravity has no public on-disk config path — users edit via
  // "..." → MCP Store → Manage MCP Servers → View raw config.
  // It also doesn't speak streamable HTTP directly, so we route through a stdio→HTTP adapter.
  const url = `http://localhost:${port}/mcp`;
  // Pre-seed PATH so the GUI app can find npx even when launched without a shell.
  const pathDirs = process.platform === 'win32'
    ? [
        process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : 'C:\\Windows\\System32',
        process.env.APPDATA ? join(process.env.APPDATA, 'npm') : '',
      ].filter(Boolean)
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  return JSON.stringify({
    mcpServers: {
      hive: {
        command: findNpx(),
        args: ['-y', '@pyroprompts/mcp-stdio-to-streamable-http-adapter'],
        env: {
          PATH: pathDirs.join(delimiter),
          URI: url,
        },
      },
    },
  }, null, 2);
}

function showInitUsage() {
  console.log('🐝 kitty-hive init — write MCP config for an IDE\n');
  console.log('Usage:');
  console.log('  kitty-hive init <tool> [--port 4123]\n');
  console.log('Tools:');
  console.log('  claude        .mcp.json          (Claude Code — prefer the plugin instead)');
  console.log('  cursor        .cursor/mcp.json');
  console.log('  vscode        .vscode/mcp.json   (VS Code Copilot)');
  console.log('  antigravity   prints snippet to paste via MCP Store UI');
  console.log('  all           run all of the above');
}

async function cmdInit() {
  const known = (ALL_INIT_TARGETS as readonly string[]);
  let tool = args[1] && !args[1].startsWith('-') ? args[1] : '';

  let port = 4123;
  for (let i = 2; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
      port = parseInt(args[i + 1], 10) || 4123; i++;
    }
  }

  if (!tool) {
    if (!isInteractive()) {
      showInitUsage();
      process.exit(1);
    }
    tool = await askSelect<string>({
      message: 'Which tool should we configure?',
      options: [
        { value: 'claude', label: 'Claude Code', hint: '.mcp.json (prefer the plugin if installed)' },
        { value: 'cursor', label: 'Cursor', hint: '.cursor/mcp.json' },
        { value: 'vscode', label: 'VS Code Copilot', hint: '.vscode/mcp.json' },
        { value: 'antigravity', label: 'Antigravity', hint: 'snippet — paste via MCP Store UI' },
        { value: 'all', label: 'All of the above' },
      ],
    });
  }

  let targets: typeof ALL_INIT_TARGETS[number][];
  if (tool === 'all') {
    targets = [...ALL_INIT_TARGETS];
  } else if (known.includes(tool)) {
    targets = [tool as typeof ALL_INIT_TARGETS[number]];
  } else {
    console.log(`Unknown tool: "${tool}"`);
    showInitUsage();
    process.exit(1);
  }

  console.log(`🐝 Configuring hive → http://localhost:${port}/mcp\n`);
  for (const t of targets) {
    if (t === 'antigravity') {
      console.log(`  antigravity  (no on-disk path — paste this snippet)`);
      console.log(`               Open: "..." → MCP Store → Manage MCP Servers → View raw config`);
      console.log(`               Merge "hive" into mcpServers:\n`);
      const snippet = antigravitySnippet(port).split('\n').map(l => '    ' + l).join('\n');
      console.log(snippet);
      console.log('');
    } else {
      const path = writeForTool(t as InitTool, port);
      console.log(`  ${t.padEnd(12)} ${path}`);
    }
  }
  console.log(`\n  Agent registers via hive_start when first used.`);
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diff = Math.max(0, Date.now() - then);
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function visualWidth(s: string): number {
  let w = 0;
  for (const c of s) {
    const cp = c.codePointAt(0)!;
    const wide =
      (cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0x303E) ||
      (cp >= 0x3041 && cp <= 0x33FF) || (cp >= 0x3400 && cp <= 0x4DBF) ||
      (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0xA000 && cp <= 0xA4CF) ||
      (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFE30 && cp <= 0xFE4F) || (cp >= 0xFF00 && cp <= 0xFF60) ||
      (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x20000 && cp <= 0x3FFFD);
    w += wide ? 2 : 1;
  }
  return w;
}

function padCell(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - visualWidth(s)));
}

function renderTable(headers: string[], rows: string[][], indent = ''): string {
  const widths = headers.map((h, i) =>
    Math.max(visualWidth(h), ...rows.map(r => visualWidth(r[i] ?? '')))
  );
  const fmt = (cells: string[]) =>
    indent + cells.map((c, i) => padCell(c ?? '', widths[i])).join('  ').trimEnd();
  const sep = indent + widths.map(w => '─'.repeat(w)).join('  ');
  return [fmt(headers), sep, ...rows.map(fmt)].join('\n');
}

function agentRows(db: ReturnType<typeof initDB>, agents: any[]): string[][] {
  const teamStmt = db.prepare(`
    SELECT t.name, tm.nickname FROM teams t
    JOIN team_members tm ON tm.team_id = t.id
    WHERE tm.agent_id = ? AND t.closed_at IS NULL
    ORDER BY t.name
  `);
  return agents.map(a => {
    const memberTeams = teamStmt.all(a.id) as any[];
    const teamLabels = memberTeams.map(t => t.nickname ? `${t.name}:${t.nickname}` : t.name).join(', ') || '-';
    return [
      a.id,
      a.display_name,
      a.tool || '-',
      a.status,
      a.roles || '-',
      teamLabels,
      relativeTime(a.last_seen),
    ];
  });
}

const AGENT_HEADERS = ['ID', 'NAME', 'TOOL', 'STATUS', 'ROLES', 'TEAMS', 'LAST SEEN'];

async function cmdStatus() {
  const { port, dbPath } = parseFlags(1);
  const url = `http://localhost:${port}/mcp`;
  const nodeName = getNodeConfig().name || hostname().split('.')[0];

  try {
    await fetch(url, { method: 'GET' });
    console.log(`🐝 Server: http://localhost:${port}/mcp (online)`);
  } catch {
    console.log(`❌ Server: http://localhost:${port}/mcp (offline)`);
    process.exit(1);
  }
  console.log(`   Node: ${nodeName}`);
  const tunnelUrl = await getTunnelUrlFromHive(port);
  if (tunnelUrl) console.log(`   Tunnel: ${tunnelUrl}`);

  try {
    const db = initDB(dbPath);
    const agents = db.prepare("SELECT id, display_name, tool, roles, status, last_seen FROM agents WHERE origin_peer = '' ORDER BY last_seen DESC").all() as any[];
    const remotes = db.prepare("SELECT id, display_name, tool, roles, status, last_seen, origin_peer FROM agents WHERE origin_peer != '' ORDER BY last_seen DESC").all() as any[];
    const teams = db.prepare("SELECT id, name FROM teams WHERE closed_at IS NULL ORDER BY name").all() as any[];
    const tasks = db.prepare("SELECT count(*) as cnt FROM tasks WHERE status NOT IN ('completed','failed','canceled')").get() as { cnt: number };
    const peers = listPeers();

    console.log(`📊 Database: ${dbPath || '~/.kitty-hive/hive.db'}`);
    console.log(`   ${agents.length} local agents · ${remotes.length} remote · ${teams.length} teams · ${tasks.cnt} active tasks · ${peers.length} peers`);

    if (agents.length > 0) {
      console.log(`\n👥 Agents`);
      console.log(renderTable(AGENT_HEADERS, agentRows(db, agents), '   '));
    }

    if (teams.length > 0) {
      console.log(`\n🏠 Teams`);
      const rows = teams.map(t => {
        const cnt = (db.prepare('SELECT COUNT(*) as cnt FROM team_members WHERE team_id = ?').get(t.id) as { cnt: number }).cnt;
        return [t.name, String(cnt)];
      });
      console.log(renderTable(['NAME', 'MEMBERS'], rows, '   '));
    }

    if (peers.length > 0) {
      console.log(`\n🤝 Peers`);
      const rows = peers.map(p => [
        p.name, p.node_name || '-', p.status, p.exposed || '-', relativeTime(p.last_seen),
      ]);
      console.log(renderTable(['NAME', 'NODE', 'STATUS', 'EXPOSED', 'LAST SEEN'], rows, '   '));

      if (remotes.length > 0) {
        console.log(`\n🌐 Remote agents (placeholders)`);
        const rrows = remotes.map(a => [
          a.id, a.display_name, a.origin_peer, a.status, relativeTime(a.last_seen),
        ]);
        console.log(renderTable(['ID', 'NAME', 'PEER', 'STATUS', 'LAST SEEN'], rrows, '   '));
      }
    }
  } catch {
    console.log(`\n⚠️  Cannot read database`);
  }
}

async function cmdDbClear() {
  const { dbPath } = parseFlags(1);
  const resolvedPath = dbPath || join(homedir(), '.kitty-hive', 'hive.db');

  if (!existsSync(resolvedPath)) {
    console.log('Database does not exist.');
    process.exit(0);
  }

  const ok = await askConfirm({
    message: `Delete ${resolvedPath}?`,
    initialValue: false,
  });
  if (!ok) {
    console.log('Cancelled.');
    process.exit(0);
  }

  for (const suffix of ['', '-wal', '-shm']) {
    const p = resolvedPath + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
  console.log('✅ Database cleared.');
}

async function cmdAgentRemove() {
  const { dbPath } = parseFlags(1);
  // Flags: --key <K>            look up by external_key (idempotent: missing = exit 0)
  //        --yes                skip confirmation (scripts)
  //        --transfer-to <a>    transfer hosted teams to this agent before deleting
  //        --cascade            explicitly accept that hosted teams (and all their members' history) will be wiped
  let target = '';
  let externalKey = '';
  let assumeYes = false;
  let transferTo = '';
  let cascade = false;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--key' && args[i + 1]) { externalKey = args[i + 1]; i++; }
    else if (args[i] === '--yes' || args[i] === '-y') { assumeYes = true; }
    else if (args[i] === '--transfer-to' && args[i + 1]) { transferTo = args[i + 1]; i++; }
    else if (args[i] === '--cascade') { cascade = true; }
    else if (args[i] === '--port' || args[i] === '-p' || args[i] === '--db') { i++; }
    else if (!args[i].startsWith('-') && !target) target = args[i];
  }
  const db = initDB(dbPath);

  let agent: { id: string; display_name: string } | undefined;

  if (externalKey) {
    // Idempotent path for orchestrators (kitty/tmux/...). Missing = success.
    const row = db.prepare('SELECT id, display_name FROM agents WHERE external_key = ?').get(externalKey) as any;
    if (!row) {
      console.log(`No agent with external_key="${externalKey}" — nothing to do.`);
      process.exit(0);
    }
    agent = row;
  } else if (target) {
    // ID is unique → try ID first; only fall back to display_name match if no ID hit.
    // This avoids a collision where someone registered an agent whose display_name
    // is literally another agent's ID.
    const byId = db.prepare('SELECT id, display_name FROM agents WHERE id = ?').get(target) as any;
    if (byId) {
      agent = byId;
    } else {
      const matches = db.prepare('SELECT id, display_name FROM agents WHERE display_name = ?').all(target) as any[];
      if (matches.length === 0) {
        console.log(`Agent "${target}" not found.`);
        process.exit(1);
      }
      if (matches.length > 1) {
        console.log(`"${target}" matches ${matches.length} agents. Use id to disambiguate.`);
        for (const m of matches) console.log(`  ${m.id}  ${m.display_name}`);
        process.exit(1);
      }
      agent = matches[0];
    }
  } else {
    if (!isInteractive()) {
      console.log('Usage: kitty-hive agent remove <name-or-id>  |  --key <key>  [--yes] [--transfer-to <agent>] [--cascade]');
      process.exit(1);
    }
    const id = await pickLocalAgent(db, 'Remove which agent?');
    agent = db.prepare('SELECT id, display_name FROM agents WHERE id = ?').get(id) as any;
  }
  if (!agent) { console.log('Not found.'); process.exit(1); }
  const name = agent.display_name;

  // --- Hosted-team pre-check ---
  const dbMod = await import('./db.js');
  const hostedTeams = dbMod.listTeamsHostedBy(agent.id);
  type HostedRow = { team: typeof hostedTeams[number]; memberCount: number; otherMemberCount: number };
  const hostedRows: HostedRow[] = hostedTeams.map(t => {
    const members = dbMod.getTeamMembers(t.id);
    return {
      team: t,
      memberCount: members.length,
      otherMemberCount: members.filter(m => m.agent_id !== agent!.id).length,
    };
  });

  if (hostedRows.length > 0) {
    console.log(`\n⚠ Agent "${name}" hosts ${hostedRows.length} team(s):`);
    for (const r of hostedRows) {
      console.log(`  • ${r.team.name}  (${r.team.id})  — ${r.memberCount} member(s), ${r.otherMemberCount} other`);
    }
    console.log('');
  }

  // Decision is only required when at least one hosted team has *other* members.
  // A team where the leaving agent is the sole member is safe to cascade-delete silently
  // (no other history is destroyed), but we still confirm overall removal below.
  let transferAgent: { id: string; display_name: string } | undefined;
  const needsHostDecision = hostedRows.some(r => r.otherMemberCount > 0);
  if (needsHostDecision) {
    if (transferTo) {
      const t = db.prepare('SELECT id, display_name FROM agents WHERE id = ? OR display_name = ?').get(transferTo, transferTo) as any;
      if (!t) {
        console.error(`--transfer-to: agent "${transferTo}" not found.`);
        process.exit(1);
      }
      transferAgent = t;
    } else if (!cascade && !assumeYes && isInteractive()) {
      // Repeat the team listing inside the prompt itself — the warning lines
      // printed earlier may be scrolled off-screen by clack's render area.
      const teamLines = hostedRows.map(r => {
        const marker = r.otherMemberCount > 0 ? '⚠' : ' ';
        return `  ${marker} ${r.team.name}  (${r.memberCount} member${r.memberCount === 1 ? '' : 's'}${r.otherMemberCount > 0 ? `, ${r.otherMemberCount} other` : ''})`;
      }).join('\n');
      const promptMsg = `Agent "${name}" hosts ${hostedRows.length} team(s):\n${teamLines}\n\nHow should they be handled?`;
      const choice = await askSelect<'transfer' | 'cascade' | 'abort'>({
        message: promptMsg,
        options: [
          { value: 'transfer', label: 'Transfer host to another local agent', hint: 'keeps team history & members' },
          { value: 'cascade', label: 'Delete teams (and all their members + history)', hint: 'destructive, irreversible' },
          { value: 'abort', label: 'Cancel — do nothing' },
        ],
        initialValue: 'transfer',
      });
      if (choice === 'abort') { console.log('Cancelled.'); process.exit(0); }
      if (choice === 'transfer') {
        const id = await pickLocalAgent(db, 'Transfer host to which agent?');
        if (id === agent.id) { console.error('Cannot transfer to self.'); process.exit(1); }
        transferAgent = db.prepare('SELECT id, display_name FROM agents WHERE id = ?').get(id) as any;
      } else {
        cascade = true;
      }
    } else if (!cascade) {
      console.error('Hosted teams detected. Pass --transfer-to <agent> to keep them, or --cascade to delete them with their members + history.');
      process.exit(1);
    }
  }

  if (transferAgent && transferAgent.id === agent.id) {
    console.error('Cannot transfer hosted teams to the agent being removed.');
    process.exit(1);
  }

  if (!assumeYes) {
    const summary = transferAgent
      ? `Remove agent "${name}" (${agent.id}); transfer ${hostedRows.length} hosted team(s) to "${transferAgent.display_name}".`
      : hostedRows.length > 0
        ? `Remove agent "${name}" AND cascade-delete ${hostedRows.length} hosted team(s) with all members + history?`
        : `Remove agent "${name}" (${agent.id}) and all related data?`;
    const ok = await askConfirm({ message: summary, initialValue: false });
    if (!ok) { console.log('Cancelled.'); process.exit(0); }
  }

  // --- Apply transfer first (so we don't cascade-delete those teams below) ---
  if (transferAgent) {
    const sessionsMod = await import('./sessions.js');
    for (const r of hostedRows) {
      // Make sure new host is a member; if not, add them.
      if (!dbMod.isTeamMember(r.team.id, transferAgent.id)) {
        dbMod.addTeamMember(r.team.id, transferAgent.id);
      }
      dbMod.transferTeamHost(r.team.id, transferAgent.id);
      dbMod.appendTeamEvent(r.team.id, 'host-transfer', null, {
        from_agent_id: agent.id,
        from_display_name: name,
        to_agent_id: transferAgent.id,
        to_display_name: transferAgent.display_name,
        reason: 'agent-remove',
      });
      try {
        await sessionsMod.notifyTeamMembers(r.team.id, undefined, JSON.stringify({
          type: 'team-host-transfer',
          team_id: r.team.id,
          team_name: r.team.name,
          from: name,
          to: transferAgent.display_name,
        }));
      } catch { /* push best-effort */ }
    }
    console.log(`↪ Transferred ${hostedRows.length} hosted team(s) to "${transferAgent.display_name}".`);
  }

  // Delete in dependency order to satisfy foreign keys
  db.prepare('DELETE FROM read_cursors WHERE agent_id = ?').run(agent.id);
  // Tasks
  db.prepare(`DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE creator_agent_id = ?)`).run(agent.id);
  db.prepare('DELETE FROM task_events WHERE actor_agent_id = ?').run(agent.id);
  db.prepare('DELETE FROM tasks WHERE creator_agent_id = ?').run(agent.id);
  db.prepare('UPDATE tasks SET assignee_agent_id = NULL WHERE assignee_agent_id = ?').run(agent.id);
  // DMs
  db.prepare('DELETE FROM dm_messages WHERE from_agent_id = ? OR to_agent_id = ?').run(agent.id, agent.id);
  // Team membership + events
  db.prepare('DELETE FROM team_members WHERE agent_id = ?').run(agent.id);
  db.prepare('DELETE FROM team_events WHERE actor_agent_id = ?').run(agent.id);
  // Teams hosted by this agent (only those left — transferred ones now have a different host)
  db.prepare(`DELETE FROM team_events WHERE team_id IN (SELECT id FROM teams WHERE host_agent_id = ?)`).run(agent.id);
  db.prepare(`DELETE FROM team_members WHERE team_id IN (SELECT id FROM teams WHERE host_agent_id = ?)`).run(agent.id);
  db.prepare(`DELETE FROM read_cursors WHERE target_id IN (SELECT id FROM teams WHERE host_agent_id = ?)`).run(agent.id);
  db.prepare('DELETE FROM teams WHERE host_agent_id = ?').run(agent.id);
  db.prepare('DELETE FROM agents WHERE id = ?').run(agent.id);

  console.log(`✅ Removed agent "${name}".`);
}

async function cmdAgentRegister() {
  // Idempotent upsert by external_key. Designed for `spawn('kitty-hive',
  // ['agent', 'register', ...])` from session managers / orchestrators.
  // On success prints the agent_id (one line, no decoration) to stdout
  // so callers can pipe it; everything else goes to stderr.
  const { dbPath } = parseFlags(1);
  let externalKey = '';
  let displayName = '';
  let roles = '';
  let tool = '';
  let agentIdOverride = '';
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--key' && args[i + 1]) { externalKey = args[i + 1]; i++; }
    else if (args[i] === '--display-name' && args[i + 1]) { displayName = args[i + 1]; i++; }
    else if (args[i] === '--name' && args[i + 1]) { displayName = args[i + 1]; i++; }
    else if (args[i] === '--roles' && args[i + 1]) { roles = args[i + 1]; i++; }
    else if (args[i] === '--tool' && args[i + 1]) { tool = args[i + 1]; i++; }
    else if (args[i] === '--id' && args[i + 1]) { agentIdOverride = args[i + 1]; i++; }
  }
  if (!externalKey && !agentIdOverride && !displayName) {
    console.error('Usage: kitty-hive agent register --key <K> --display-name <N> [--roles R] [--tool T]');
    console.error('  All three of --key/--id/--display-name optional, but at least one required.');
    process.exit(1);
  }

  initDB(dbPath);
  const { handleStart } = await import('./tools/start.js');
  try {
    const result = handleStart({
      key: externalKey || undefined,
      id: agentIdOverride || undefined,
      name: displayName || undefined,
      roles: roles || undefined,
      tool: tool || undefined,
    });
    // Stdout: one line, just the agent_id (script-friendly)
    console.log(result.agent_id);
    // Stderr: human context
    console.error(`✅ ${result.display_name} (${result.agent_id})${externalKey ? ` key=${externalKey}` : ''}`);
  } catch (err: any) {
    console.error(`Failed: ${err.message ?? err}`);
    process.exit(1);
  }
}

async function cmdAgentRename() {
  const { dbPath } = parseFlags(1);
  const oldName = args[2];
  let newName: string | undefined = args[3];
  const db = initDB(dbPath);

  let agentId: string;
  let oldDisplay: string;
  if (!oldName) {
    if (!isInteractive()) {
      console.log('Usage: kitty-hive agent rename <old-name-or-id> <new-name>');
      process.exit(1);
    }
    agentId = await pickLocalAgent(db, 'Rename which agent?');
    oldDisplay = (db.prepare('SELECT display_name FROM agents WHERE id = ?').get(agentId) as any).display_name;
  } else {
    // ID-first to avoid collision with display_name that equals some agent's ID.
    const byId = db.prepare('SELECT id, display_name FROM agents WHERE id = ?').get(oldName) as any;
    if (byId) {
      agentId = byId.id;
      oldDisplay = byId.display_name;
    } else {
      const matches = db.prepare('SELECT id, display_name FROM agents WHERE display_name = ?').all(oldName) as any[];
      if (matches.length === 0) {
        console.log(`Agent "${oldName}" not found.`);
        process.exit(1);
      }
      if (matches.length > 1) {
        console.log(`"${oldName}" matches ${matches.length} agents. Use agent id to disambiguate.`);
        process.exit(1);
      }
      agentId = matches[0].id;
      oldDisplay = matches[0].display_name;
    }
  }

  if (!newName) {
    if (!isInteractive()) {
      console.log('Usage: kitty-hive agent rename <old-name-or-id> <new-name>');
      process.exit(1);
    }
    newName = await askText({
      message: `New name for "${oldDisplay}"`,
      placeholder: oldDisplay,
      validate: (v) => ((v ?? '').trim().length === 0 ? 'Name cannot be empty' : undefined),
    });
  }

  db.prepare('UPDATE agents SET display_name = ? WHERE id = ?').run(newName, agentId);
  console.log(`✅ Renamed "${oldDisplay}" → "${newName}".`);
}

async function cmdAgentList() {
  const { dbPath } = parseFlags(1);
  const db = initDB(dbPath);
  const agents = db.prepare('SELECT id, display_name, tool, roles, status, last_seen FROM agents ORDER BY last_seen DESC').all() as any[];
  if (agents.length === 0) {
    console.log('No agents registered.');
    return;
  }
  console.log(renderTable(AGENT_HEADERS, agentRows(db, agents)));
}

// --- Team commands (CLI-only; agents use hive-team-* MCP tools instead) ---

async function cmdTeamList() {
  const { dbPath } = parseFlags(1);
  initDB(dbPath);
  const dbMod = await import('./db.js');
  const teams = dbMod.listTeams(false);
  if (teams.length === 0) { console.log('No teams.'); return; }
  for (const t of teams) {
    const host = t.host_agent_id ? (getAgentById(t.host_agent_id)?.display_name ?? t.host_agent_id.slice(-12)) : '(none)';
    const memberCount = dbMod.countTeamMembers(t.id);
    const status = t.closed_at ? 'closed' : 'active';
    console.log(`${t.id}  ${t.name}  host=${host}  members=${memberCount}  ${status}`);
  }
}

async function cmdTeamTransfer() {
  const { dbPath } = parseFlags(1);
  let teamArg = '';
  let toArg = '';
  let assumeYes = false;
  let addMember = false;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--to' && args[i + 1]) { toArg = args[i + 1]; i++; }
    else if (args[i] === '--yes' || args[i] === '-y') { assumeYes = true; }
    else if (args[i] === '--add-member') { addMember = true; }
    else if (args[i] === '--port' || args[i] === '-p' || args[i] === '--db') { i++; }
    else if (!args[i].startsWith('-') && !teamArg) teamArg = args[i];
  }
  const db = initDB(dbPath);
  const dbMod = await import('./db.js');

  // --- Resolve team ---
  let team: { id: string; name: string; host_agent_id: string | null } | undefined;
  if (teamArg) {
    team = dbMod.getTeamById(teamArg) || dbMod.getTeamByName(teamArg);
    if (!team) { console.error(`Team "${teamArg}" not found.`); process.exit(1); }
  } else {
    if (!isInteractive()) {
      console.error('Usage: kitty-hive team transfer <team> --to <agent> [--add-member] [--yes]');
      process.exit(1);
    }
    const teams = dbMod.listTeams(false);
    if (teams.length === 0) { console.log('No teams to transfer.'); process.exit(0); }
    const teamId = await askSelect<string>({
      message: 'Transfer which team?',
      options: teams.map(t => ({
        value: t.id,
        label: t.name,
        hint: `host=${t.host_agent_id ? (getAgentById(t.host_agent_id)?.display_name ?? t.host_agent_id.slice(-12)) : '(none)'} · ${dbMod.countTeamMembers(t.id)} member(s)`,
      })),
    });
    team = teams.find(t => t.id === teamId)!;
  }

  const currentHostName = team.host_agent_id ? (getAgentById(team.host_agent_id)?.display_name ?? team.host_agent_id.slice(-12)) : '(none)';
  console.log(`\nTeam: ${team.name}  (${team.id})\nCurrent host: ${currentHostName}\n`);

  // --- Resolve new host ---
  let newHost: { id: string; display_name: string } | undefined;
  if (toArg) {
    // ID-first: ID is unique, only fall back to display_name lookup on no ID hit.
    const byId = db.prepare("SELECT id, display_name FROM agents WHERE id = ? AND origin_peer = ''").get(toArg) as any;
    if (byId) {
      newHost = byId;
    } else {
      const matches = db.prepare("SELECT id, display_name FROM agents WHERE display_name = ? AND origin_peer = ''").all(toArg) as any[];
      if (matches.length === 0) { console.error(`--to: local agent "${toArg}" not found.`); process.exit(1); }
      if (matches.length > 1) {
        console.error(`--to "${toArg}" matches ${matches.length} agents. Use id to disambiguate.`);
        process.exit(1);
      }
      newHost = matches[0];
    }
  } else {
    if (!isInteractive()) {
      console.error('Missing --to <agent>.');
      process.exit(1);
    }
    const id = await pickLocalAgent(db, 'New host?');
    newHost = db.prepare('SELECT id, display_name FROM agents WHERE id = ?').get(id) as any;
  }
  if (!newHost) { console.error('New host not found.'); process.exit(1); }
  if (newHost.id === team.host_agent_id) {
    console.log(`"${newHost.display_name}" is already the host. Nothing to do.`);
    process.exit(0);
  }

  // --- Membership check ---
  if (!dbMod.isTeamMember(team.id, newHost.id)) {
    if (!addMember && !assumeYes && isInteractive()) {
      const ok = await askConfirm({
        message: `"${newHost.display_name}" is not a member of "${team.name}". Add them as a member?`,
        initialValue: true,
      });
      if (!ok) { console.log('Cancelled.'); process.exit(0); }
      addMember = true;
    } else if (!addMember) {
      console.error(`"${newHost.display_name}" is not a member of "${team.name}". Re-run with --add-member to auto-join them, or have them join first.`);
      process.exit(1);
    }
    dbMod.addTeamMember(team.id, newHost.id);
  }

  if (!assumeYes) {
    const ok = await askConfirm({
      message: `Transfer host of "${team.name}" from ${currentHostName} → ${newHost.display_name}?`,
      initialValue: true,
    });
    if (!ok) { console.log('Cancelled.'); process.exit(0); }
  }

  dbMod.transferTeamHost(team.id, newHost.id);
  dbMod.appendTeamEvent(team.id, 'host-transfer', null, {
    from_agent_id: team.host_agent_id,
    from_display_name: currentHostName,
    to_agent_id: newHost.id,
    to_display_name: newHost.display_name,
    reason: 'team-transfer',
  });
  try {
    const sessionsMod = await import('./sessions.js');
    await sessionsMod.notifyTeamMembers(team.id, undefined, JSON.stringify({
      type: 'team-host-transfer',
      team_id: team.id,
      team_name: team.name,
      from: currentHostName,
      to: newHost.display_name,
    }));
  } catch { /* push best-effort */ }

  console.log(`✅ Host of "${team.name}" → ${newHost.display_name}.`);
}

// --- Node config ---

function getConfigPath(): string {
  return join(homedir(), '.kitty-hive', 'config.json');
}

function getNodeConfig(): { name?: string } {
  const p = getConfigPath();
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
}

function setNodeConfig(config: Record<string, any>): void {
  const p = getConfigPath();
  mkdirSync(join(p, '..'), { recursive: true });
  const existing = getNodeConfig();
  writeFileSync(p, JSON.stringify({ ...existing, ...config }, null, 2) + '\n');
}

function getNodeName(): string {
  return getNodeConfig().name || hostname().split('.')[0];
}

// --- Peer commands ---

async function cmdPeerAdd() {
  const { dbPath } = parseFlags(1);
  // kitty-hive peer add <name> <url> [--expose a,b] [--secret s]
  let peerName = '';
  let peerUrl = '';
  let exposed = '';
  let secret = '';

  let positional = 0;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--expose' && args[i + 1]) { exposed = args[i + 1]; i++; }
    else if (args[i] === '--secret' && args[i + 1]) { secret = args[i + 1]; i++; }
    else if (args[i] === '--port' || args[i] === '-p' || args[i] === '--db') { i++; }
    else if (!args[i].startsWith('-')) {
      if (positional === 0) peerName = args[i];
      else if (positional === 1) peerUrl = args[i];
      positional++;
    }
  }

  const db = initDB(dbPath);

  if (!peerName || !peerUrl) {
    if (!isInteractive()) {
      console.log('Usage: kitty-hive peer add <name> <url> [--expose agent1,agent2] [--secret s]');
      process.exit(1);
    }
    if (!peerName) {
      peerName = await askText({
        message: 'Peer name (a label for this peer on your side)',
        validate: (v) => {
          const t = (v ?? '').trim();
          if (!t) return 'Name cannot be empty';
          if (getPeerByName(t)) return `Peer "${t}" already exists`;
          return undefined;
        },
      });
    }
    if (!peerUrl) {
      peerUrl = await askText({
        message: 'Peer URL (e.g. https://xxx.trycloudflare.com/mcp)',
        validate: (v) => (!/^https?:\/\//.test((v ?? '').trim()) ? 'URL must start with http:// or https://' : undefined),
      });
    }
  }

  if (getPeerByName(peerName)) {
    console.log(`Peer "${peerName}" already exists. Remove it first.`);
    process.exit(1);
  }

  // Interactive: pick exposed agents from local list (skips the bug where you
  // could pass non-existent IDs).
  if (!exposed && isInteractive()) {
    const picked = await pickLocalAgents(db, 'Which local agents should this peer be allowed to reach?');
    exposed = picked.join(',');
  }

  if (!secret && isInteractive()) {
    const provideSecret = await askConfirm({
      message: 'Use an existing secret? (No = generate one for you)',
      initialValue: false,
    });
    if (provideSecret) {
      secret = await askText({
        message: 'Paste shared secret',
        validate: (v) => ((v ?? '').trim().length < 8 ? 'Secret looks too short' : undefined),
      });
    }
  }
  if (!secret) {
    secret = 'sk_' + generateToken().slice(0, 32);
  }

  const peer = addPeer(peerName, peerUrl, secret, exposed);
  console.log(`🤝 Peer added: ${peerName}`);
  console.log(`   URL: ${peerUrl}`);
  console.log(`   Secret: ${secret}`);
  console.log(`   Exposed agents: ${exposed || 'none (use `peer expose` later)'}`);

  // Verify reachability via /federation/ping
  process.stdout.write(`   Pinging…`);
  const result = await pingPeer(peerName, peerUrl, secret, 5000);
  if (result.ok) {
    if (result.node) setPeerNodeName(peerName, result.node);
    setPeerStatus(peerName, 'active');
    touchPeer(peerName);
    console.log(` ok (node="${result.node}")`);
  } else {
    setPeerStatus(peerName, 'inactive');
    console.log(` failed: ${result.error}`);
    console.log(`   (peer record kept; will retry on next heartbeat once server is reachable)`);
  }
  console.log(`\n   Give this secret to the peer so they can connect back.`);
}

async function cmdPeerList() {
  const { dbPath } = parseFlags(1);
  initDB(dbPath);
  const peers = listPeers();
  if (peers.length === 0) {
    console.log('No peers configured.');
    return;
  }
  const rows = peers.map(p => [
    p.name,
    p.node_name || '-',
    p.status,
    p.url,
    p.exposed || '-',
    relativeTime(p.last_seen),
  ]);
  console.log(renderTable(['NAME', 'NODE', 'STATUS', 'URL', 'EXPOSED', 'LAST SEEN'], rows));
}

async function cmdPeerRemove() {
  const { dbPath } = parseFlags(1);
  let name = args[2];
  initDB(dbPath);

  if (!name) {
    if (!isInteractive()) {
      console.log('Usage: kitty-hive peer remove <name>');
      process.exit(1);
    }
    name = await pickPeer('Remove which peer?');
    const ok = await askConfirm({
      message: `Remove peer "${name}"?`,
      initialValue: false,
    });
    if (!ok) {
      console.log('Cancelled.');
      process.exit(0);
    }
  }

  if (removePeer(name)) {
    console.log(`✅ Peer "${name}" removed.`);
  } else {
    console.log(`Peer "${name}" not found.`);
    process.exit(1);
  }
}

// --- Tunnel ---

async function pushTunnelUrl(port: number, url: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/admin/tunnel-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`hive admin replied ${res.status}: ${err}`);
  }
}

async function getTunnelUrlFromHive(port: number, timeoutMs = 1500): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/admin/tunnel-url`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return '';
    const body = await res.json() as { url?: string };
    return body.url || '';
  } catch { clearTimeout(timer); return ''; }
}

async function ensureNodeName(): Promise<string> {
  const explicit = getNodeConfig().name;
  if (explicit) return explicit;
  const defaultName = hostname().split('.')[0];
  if (!isInteractive()) {
    // Non-interactive (e.g. systemd) — silently use hostname
    return defaultName;
  }
  console.log(`\n📛 No node name set. Peers will see you under this name.`);
  const answer = (await askText({
    message: 'Node name',
    placeholder: defaultName,
    initialValue: defaultName,
  })).trim() || defaultName;
  setNodeConfig({ name: answer });
  console.log(`   → saved (kitty-hive config set name ${answer})\n`);
  return answer;
}

async function cmdTunnelStart() {
  let port = 4123;
  let nameOverride = '';
  for (let i = 2; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) { port = parseInt(args[i + 1], 10) || 4123; i++; }
    else if (args[i] === '--name' && args[i + 1]) { nameOverride = args[i + 1]; i++; }
  }

  if (nameOverride) {
    setNodeConfig({ name: nameOverride });
    console.log(`📛 Node name: ${nameOverride}`);
  } else {
    const name = await ensureNodeName();
    console.log(`📛 Node name: ${name}`);
  }

  const bin = findCloudflared();
  if (!bin) {
    console.log('❌ cloudflared not found.');
    console.log('   Install:');
    console.log('     macOS:    brew install cloudflared');
    console.log('     Windows:  choco install cloudflared');
    console.log('     Linux:    https://github.com/cloudflare/cloudflared/releases');
    process.exit(1);
  }
  console.log(`🌀 Starting cloudflared (binary: ${bin})…`);
  console.log(`   Forwarding to http://localhost:${port}`);

  let firstUrl = true;
  let everConnected = false;
  const tm = new TunnelManager({
    port,
    binary: bin,
    onUrl: async (url) => {
      const tag = firstUrl ? '✓' : '↻';
      firstUrl = false;
      console.log(`   ${tag} Tunnel URL: ${url}`);
      try {
        await pushTunnelUrl(port, url);
        console.log(`     → registered with hive at http://localhost:${port}`);
      } catch (err) {
        console.log(`     ⚠ failed to register with hive: ${(err as any).message}`);
        console.log(`       (is \`kitty-hive serve --port ${port}\` running?)`);
      }
    },
    onConnected: (count) => {
      everConnected = true;
      const ts = new Date().toTimeString().slice(0, 8);
      console.log(`   ${ts}  ✓ tunnel connected (active connections: ${count})`);
    },
    onLost: () => {
      const ts = new Date().toTimeString().slice(0, 8);
      console.log(`   ${ts}  ⚠ tunnel LOST — all connections dropped${everConnected ? ' (cloudflared will retry)' : ''}`);
    },
    onError: (msg) => console.log(`   ⚠ ${msg}`),
  });

  const shutdown = async () => {
    console.log('\n🛑 stopping tunnel…');
    tm.stop();
    try { await pushTunnelUrl(port, ''); } catch { /* hive may already be down */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  tm.start();
  console.log(`   (Ctrl+C to stop. The hive will keep running.)`);
}

async function cmdTunnelStatus() {
  let port = 4123;
  for (let i = 2; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) { port = parseInt(args[i + 1], 10) || 4123; i++; }
  }
  const url = await getTunnelUrlFromHive(port);
  if (url) {
    console.log(`🌀 Tunnel: ${url}`);
  } else {
    console.log(`💤 No tunnel registered with hive on port ${port}.`);
    console.log(`   Start one with: kitty-hive tunnel start --port ${port}`);
  }
}

// --- Invite token ---

interface InvitePayload {
  v: 1;
  n: string;   // sender's node name
  u: string;   // sender's hive URL (with /mcp)
  s: string;   // shared secret
  e: string;   // sender's exposed agent_id
  t: string;   // pending invite token id
}

function encodeInvite(p: InvitePayload): string {
  return 'hive://' + Buffer.from(JSON.stringify(p)).toString('base64url');
}

function decodeInvite(token: string): InvitePayload {
  let raw = token.trim();
  if (raw.startsWith('hive://')) raw = raw.slice('hive://'.length);
  const json = Buffer.from(raw, 'base64url').toString();
  const p = JSON.parse(json);
  if (p.v !== 1) throw new Error('Unsupported invite version');
  if (!p.n || !p.u || !p.s || !p.e || !p.t) throw new Error('Invite missing required fields');
  return p;
}

async function cmdPeerInvite() {
  const { dbPath } = parseFlags(1);
  let exposed = '';
  let url = '';
  let port = 4123;
  for (let i = 2; i < args.length; i++) {
    if ((args[i] === '--as' || args[i] === '--expose') && args[i + 1]) { exposed = args[i + 1]; i++; }
    else if (args[i] === '--url' && args[i + 1]) { url = args[i + 1]; i++; }
    else if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) { port = parseInt(args[i + 1], 10) || 4123; i++; }
  }

  const db = initDB(dbPath);
  cleanupExpiredInvites();

  if (!exposed) {
    if (!isInteractive()) {
      console.log('Usage: kitty-hive peer invite --expose <my-agent-id>');
      console.log('  --expose  YOUR local agent that the peer should be allowed to reach');
      console.log('');
      console.log('  Cross-machine? Run `kitty-hive tunnel start` first; the URL will be picked up');
      console.log('  automatically. (Advanced: --url <https://.../mcp> overrides.)');
      process.exit(1);
    }
    exposed = await pickLocalAgent(db, 'Which local agent should the invitee be allowed to reach?');
  } else if (!isLocalAgent(db, exposed)) {
    console.log(`❌ Agent "${exposed}" is not a local agent (must be one registered on this hive).`);
    process.exit(1);
  }

  // Resolve URL: explicit --url > tunnel URL stored by `kitty-hive tunnel start`.
  // Refuse if neither — invites are only meaningful across machines.
  const stored = getNodeState('public_url');
  if (!url && !stored) {
    console.log(`❌ No tunnel URL available — invites are only useful for cross-machine federation.`);
    console.log(`   Start a tunnel in another terminal first:`);
    console.log(`     kitty-hive tunnel start`);
    console.log(`   (Local agents on the same hive don't need invites; address each other by id directly.)`);
    process.exit(1);
  }
  let publicUrl = url || stored!;
  if (!/\/mcp\/?$/.test(publicUrl)) publicUrl = publicUrl.replace(/\/+$/, '') + '/mcp';

  const secret = 'sk_' + generateToken().slice(0, 32);
  const invite = createPendingInvite(secret, exposed, publicUrl);
  const nodeName = getNodeConfig().name || hostname().split('.')[0];
  const token = encodeInvite({ v: 1, n: nodeName, u: publicUrl, s: secret, e: exposed, t: invite.token_id });

  console.log(`🤝 Invite created (expires in 24h)`);
  console.log(`   Your URL: ${publicUrl}`);
  console.log(`   Exposed agent: ${exposed}`);
  console.log(`   Secret: ${secret}\n`);
  console.log(`   Send this token to your peer:\n`);
  console.log(`   ${token}\n`);
  console.log(`   On the OTHER machine, run:`);
  console.log(`     kitty-hive peer accept '${token}' --expose <their-agent-id>`);
  console.log(`   (they should also have \`kitty-hive tunnel start\` running for cross-machine setups.)`);
}

async function cmdPeerAccept() {
  const { dbPath } = parseFlags(1);
  let token = '';
  let myExposed = '';
  let myUrl = '';
  let port = 4123;
  for (let i = 2; i < args.length; i++) {
    if ((args[i] === '--as' || args[i] === '--expose') && args[i + 1]) { myExposed = args[i + 1]; i++; }
    else if (args[i] === '--url' && args[i + 1]) { myUrl = args[i + 1]; i++; }
    else if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) { port = parseInt(args[i + 1], 10) || 4123; i++; }
    else if (!args[i].startsWith('-') && !token) token = args[i];
  }

  const db = initDB(dbPath);

  if (!token) {
    if (!isInteractive()) {
      console.log('Usage: kitty-hive peer accept <token> --expose <my-agent-id>');
      console.log('  (Token must be provided as a positional argument or interactively.)');
      process.exit(1);
    }
    token = await askText({
      message: 'Paste invite token (starts with hive://)',
      validate: (v) => (!(v ?? '').trim().startsWith('hive://') ? 'Token must start with hive://' : undefined),
    });
  }

  let invite: InvitePayload;
  try { invite = decodeInvite(token); }
  catch (err) { console.log(`Invalid invite: ${(err as any).message}`); process.exit(1); }

  if (!myExposed) {
    if (!isInteractive()) {
      console.log('Usage: kitty-hive peer accept <token> --expose <my-agent-id>');
      console.log('  --expose  YOUR local agent that the inviter should be allowed to reach');
      process.exit(1);
    }
    myExposed = await pickLocalAgent(db, 'Which local agent should the inviter be allowed to reach?');
  } else if (!isLocalAgent(db, myExposed)) {
    console.log(`❌ Agent "${myExposed}" is not a local agent on this hive.`);
    process.exit(1);
  }
  console.log(`✓ Decoded invite from "${invite.n}"`);
  console.log(`  Their URL: ${invite.u}`);
  console.log(`  Their exposed agent: ${invite.e}\n`);

  // Add their hive as a local peer.
  // exposed = OUR local agent that THEY can reach (= myExposed), not their agent.
  let peerName = invite.n;
  if (getPeerByName(peerName)) {
    peerName = `${invite.n}-${Date.now().toString(36).slice(-4)}`;
    console.log(`  (peer name "${invite.n}" taken; using "${peerName}")`);
  }
  addPeer(peerName, invite.u, invite.s, myExposed);
  setPeerNodeName(peerName, invite.n);
  console.log(`✓ Added ${peerName} as local peer`);

  // Decide our URL: explicit --url > tunnel URL > localhost
  let ourUrl = myUrl || getNodeState('public_url') || `http://localhost:${port}/mcp`;
  if (!/\/mcp\/?$/.test(ourUrl)) ourUrl = ourUrl.replace(/\/+$/, '') + '/mcp';

  // Cross-machine sanity check: their URL is public but ours is localhost → won't work
  const isLocal = (u: string) => /\/\/(localhost|127\.0\.0\.1|\[?::1\]?)(:|\/)/.test(u);
  if (!isLocal(invite.u) && isLocal(ourUrl)) {
    console.log(`\n❌ Inviter is on another machine but you have no tunnel URL.`);
    console.log(`   Run \`kitty-hive tunnel start\` in another terminal, then re-run this command.\n`);
    process.exit(1);
  }
  const ourNode = getNodeConfig().name || hostname().split('.')[0];

  // Handshake back: tell their hive how to reach us
  process.stdout.write(`✓ Calling handshake on ${invite.u}…`);
  const handshakeUrl = invite.u.replace(/\/mcp\/?$/, '/federation/handshake');
  try {
    const res = await fetch(handshakeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token_id: invite.t, secret: invite.s,
        name: ourNode, url: ourUrl, exposed: myExposed,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      console.log(` failed: ${(err as any).error || res.statusText}`);
      console.log(`  Local peer record was added; their side may not auto-add you.`);
      console.log(`  They can add you manually with:`);
      console.log(`    kitty-hive peer add ${ourNode} ${ourUrl} --secret ${invite.s} --expose ${myExposed}`);
      process.exit(1);
    }
    const result = await res.json() as { peer_name: string; node: string };
    console.log(` ok (they added you as "${result.peer_name}")`);
  } catch (err) {
    console.log(` failed: ${(err as any).message}`);
    console.log(`  Local peer record was added; their side may not auto-add you.`);
    process.exit(1);
  }

  // Verify reachability via ping
  process.stdout.write(`✓ Pinging ${peerName}…`);
  const ping = await pingPeer(peerName, invite.u, invite.s, 5000);
  if (ping.ok) {
    setPeerStatus(peerName, 'active');
    touchPeer(peerName);
    console.log(` ok (node="${ping.node}")`);
  } else {
    console.log(` failed: ${ping.error} (will retry on next heartbeat)`);
  }

  console.log(`\n🎉 Peer "${peerName}" connected. Try:`);
  console.log(`  hive-remote-agents({ peer: "${peerName}" })`);
}

async function cmdPeerSetUrl() {
  const { dbPath } = parseFlags(1);
  let peerName = args[2];
  let newUrl = args[3];
  initDB(dbPath);

  if (!peerName) {
    if (!isInteractive()) {
      console.log('Usage: kitty-hive peer set-url <peer-name> <new-url>');
      console.log('  Use this when a peer\'s tunnel URL changes and the auto-sync didn\'t reach you');
      process.exit(1);
    }
    peerName = await pickPeer('Which peer\'s URL needs updating?');
  }
  const peer = getPeerByName(peerName);
  if (!peer) {
    console.log(`Peer "${peerName}" not found.`);
    process.exit(1);
  }

  if (!newUrl) {
    if (!isInteractive()) {
      console.log('Usage: kitty-hive peer set-url <peer-name> <new-url>');
      process.exit(1);
    }
    newUrl = await askText({
      message: `New URL for "${peerName}"`,
      placeholder: peer.url,
      initialValue: peer.url,
      validate: (v) => (!/^https?:\/\//i.test((v ?? '').trim()) ? 'URL must start with http:// or https://' : undefined),
    });
  }
  if (!/^https?:\/\//i.test(newUrl)) {
    console.log(`URL must start with http:// or https:// — got "${newUrl}"`);
    process.exit(1);
  }
  if (!/\/mcp\/?$/.test(newUrl)) newUrl = newUrl.replace(/\/+$/, '') + '/mcp';

  const oldUrl = peer.url;
  setPeerUrl(peerName, newUrl);
  console.log(`✓ Updated peer "${peerName}" URL`);
  console.log(`    old: ${oldUrl}`);
  console.log(`    new: ${newUrl}`);

  // Verify with a ping
  process.stdout.write(`✓ Pinging…`);
  const r = await pingPeer(peerName, newUrl, peer.secret, 5000);
  if (r.ok) {
    setPeerStatus(peerName, 'active');
    touchPeer(peerName);
    console.log(` ok (node="${r.node}")`);
  } else {
    setPeerStatus(peerName, 'inactive');
    console.log(` failed: ${r.error}`);
    console.log(`  (URL still saved; will be retried by heartbeat)`);
  }
}

async function cmdPeerExpose() {
  const { dbPath } = parseFlags(1);
  // Usage:
  //   peer expose <name>                  TTY → multiselect; non-TTY → show current
  //   peer expose <name> id1,id2,id3      Replace exposure list (script-friendly)
  //   peer expose <name> --clear          Empty the exposure list
  let peerName = '';
  let replacement: string | null = null;
  let clear = false;

  let positional = 0;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--clear') { clear = true; }
    else if (args[i] === '--port' || args[i] === '-p' || args[i] === '--db') { i++; }
    else if (!args[i].startsWith('-')) {
      if (positional === 0) peerName = args[i];
      else if (positional === 1) replacement = args[i];
      positional++;
    }
  }

  const db = initDB(dbPath);

  if (!peerName) {
    if (!isInteractive()) {
      console.log('Usage: kitty-hive peer expose <peer> [<id1,id2,...>]');
      console.log('         kitty-hive peer expose <peer> --clear');
      console.log('  No second argument: show current exposure (or interactive picker in a TTY).');
      process.exit(1);
    }
    peerName = await pickPeer('Manage exposed agents for which peer?');
  }
  const peer = getPeerByName(peerName);
  if (!peer) {
    console.log(`Peer "${peerName}" not found.`);
    process.exit(1);
  }

  const current = peer.exposed ? peer.exposed.split(',').map(s => s.trim()).filter(Boolean) : [];

  // --- View path: no second arg, no --clear, non-TTY ---
  if (replacement === null && !clear && !isInteractive()) {
    if (current.length === 0) {
      console.log(`Peer "${peerName}" exposes no local agents.`);
      return;
    }
    const named = current.map(id => {
      const row = db.prepare('SELECT display_name FROM agents WHERE id = ?').get(id) as { display_name?: string } | undefined;
      return row?.display_name ? `  ${row.display_name}  (${id})` : `  ${id}  (unknown — agent may have been removed)`;
    });
    console.log(`Peer "${peerName}" exposes ${current.length} local agent(s):`);
    console.log(named.join('\n'));
    return;
  }

  // --- Edit paths ---
  let next: string[];

  if (clear) {
    next = [];
  } else if (replacement !== null) {
    // Positional replacement — replace the whole list.
    const parsed = replacement.split(',').map(s => s.trim()).filter(Boolean);
    next = [];
    for (const a of parsed) {
      if (!isLocalAgent(db, a)) {
        console.log(`❌ "${a}" is not a local agent on this hive — skipping. (Remote placeholder agents can't be exposed.)`);
        continue;
      }
      if (!next.includes(a)) next.push(a);
    }
  } else {
    // No args + TTY → interactive multiselect (current pre-checked).
    next = await pickLocalAgents(
      db,
      `Local agents to expose to "${peerName}" (Space to toggle, Enter to confirm)`,
      current,
    );
  }

  updatePeerExposed(peerName, next.join(','));
  console.log(`✅ Peer "${peerName}" exposed agents: ${next.join(', ') || 'none'}`);
}

async function cmdFilesClean() {
  let maxAgeDays = 7;
  for (let i = 2; i < args.length; i++) {
    if ((args[i] === '--days' || args[i] === '-d') && args[i + 1]) {
      maxAgeDays = parseInt(args[i + 1], 10) || 7; i++;
    }
  }
  const { cleanupOldFiles } = await import('./federation-http.js');
  const result = cleanupOldFiles(maxAgeDays);
  console.log(`✅ Removed ${result.removed} federation file(s) older than ${maxAgeDays} day(s); kept ${result.kept}.`);
}

const CONFIG_KEYS = ['name'] as const;

async function cmdConfigSet() {
  // kitty-hive config set name marvin
  let key = args[2];
  let value = args[3];

  if (!key) {
    if (!isInteractive()) {
      console.log('Usage: kitty-hive config set <key> <value>');
      console.log(`  Known keys: ${CONFIG_KEYS.join(', ')}`);
      process.exit(1);
    }
    key = await askSelect<string>({
      message: 'Which config key?',
      options: CONFIG_KEYS.map(k => ({ value: k, label: k })),
    });
  }

  if (!value) {
    if (!isInteractive()) {
      console.log('Usage: kitty-hive config set <key> <value>');
      process.exit(1);
    }
    const current = (getNodeConfig() as any)[key] || '';
    value = await askText({
      message: `Value for "${key}"`,
      placeholder: current || (key === 'name' ? hostname().split('.')[0] : ''),
      initialValue: current,
      validate: (v) => ((v ?? '').trim().length === 0 ? 'Value cannot be empty' : undefined),
    });
  }

  setNodeConfig({ [key]: value });
  console.log(`✅ ${key} = ${value}`);
}

// --- log (history viewers) ---

function resolveAgentByIdOrName(target: string): { id: string; display_name: string } | null {
  const byId = getAgentById(target);
  if (byId) return { id: byId.id, display_name: byId.display_name };
  const byName = listAllAgents().filter(a => a.display_name === target);
  if (byName.length === 1) return { id: byName[0].id, display_name: byName[0].display_name };
  if (byName.length > 1) {
    console.log(`"${target}" matches ${byName.length} agents — use id to disambiguate:`);
    for (const a of byName) console.log(`  ${a.id}  ${a.display_name}`);
    process.exit(1);
  }
  return null;
}

function parseLogLimit(from = 2): number {
  for (let i = from; i < args.length; i++) {
    if ((args[i] === '--limit' || args[i] === '-n') && args[i + 1]) {
      const n = parseInt(args[i + 1], 10);
      if (n > 0) return n;
    }
  }
  return 50;
}

async function cmdLogDM() {
  const { dbPath } = parseFlags(2);
  const db = initDB(dbPath);
  let target = args[2] && !args[2].startsWith('-') ? args[2] : '';
  const limit = parseLogLimit(2);

  let agent: { id: string; display_name: string } | null = null;
  if (target) {
    agent = resolveAgentByIdOrName(target);
    if (!agent) {
      console.log(`Agent "${target}" not found.`);
      process.exit(1);
    }
  } else {
    if (!isInteractive()) {
      console.log('Usage: kitty-hive log dm <agent-id-or-name> [--limit 50]');
      process.exit(1);
    }
    const all = listAllAgents().filter(a => a.origin_peer === '' || a.origin_peer);
    if (all.length === 0) {
      console.log('No agents registered.');
      return;
    }
    const id = await askSelect<string>({
      message: 'Show DM log involving which agent?',
      options: all.map(a => ({
        value: a.id,
        label: a.display_name,
        hint: a.origin_peer ? `${a.id} @${a.origin_peer}` : a.id,
      })),
    });
    agent = resolveAgentByIdOrName(id);
  }
  if (!agent) { console.log('Not found.'); process.exit(1); }

  const msgs = getDMLog(agent.id, limit);
  if (msgs.length === 0) {
    console.log(`No DMs involving ${agent.display_name} (${agent.id}).`);
    return;
  }
  console.log(`Last ${msgs.length} DMs involving ${agent.display_name} (${agent.id}):\n`);
  for (const m of msgs) {
    const from = getAgentById(m.from_agent_id);
    const to = getAgentById(m.to_agent_id);
    const fromLabel = from?.display_name ?? m.from_agent_id.slice(-12);
    const toLabel = to?.display_name ?? m.to_agent_id.slice(-12);
    const ts = m.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
    let att = '';
    try {
      const a = JSON.parse(m.attachments || '[]');
      if (a.length > 0) att = `  [${a.length} attachment${a.length > 1 ? 's' : ''}]`;
    } catch { /* ignore */ }
    const body = m.content.length > 400 ? m.content.slice(0, 400) + ' …' : m.content;
    console.log(`${ts}  #${m.id}  ${fromLabel} → ${toLabel}${att}`);
    for (const line of body.split('\n')) console.log(`    ${line}`);
    console.log('');
  }
}

async function cmdLogTeam() {
  const { dbPath } = parseFlags(2);
  const db = initDB(dbPath);
  let target = args[2] && !args[2].startsWith('-') ? args[2] : '';
  const limit = parseLogLimit(2);

  if (!target) {
    if (!isInteractive()) {
      console.log('Usage: kitty-hive log team <team-name-or-id> [--limit 50]');
      process.exit(1);
    }
    const teams = db.prepare("SELECT id, name FROM teams ORDER BY created_at DESC").all() as any[];
    if (teams.length === 0) {
      console.log('No teams exist.');
      return;
    }
    target = await askSelect<string>({
      message: 'Show event log for which team?',
      options: teams.map(t => ({ value: t.id, label: t.name, hint: t.id })),
    });
  }
  const team = getTeamByName(target) || getTeamById(target);
  if (!team) {
    console.log(`Team "${target}" not found.`);
    process.exit(1);
  }
  const events = getTeamEvents(team.id, 0, limit);
  if (events.length === 0) {
    console.log(`No events in team "${team.name}".`);
    return;
  }
  console.log(`Last ${events.length} events in team ${team.name} (${team.id}):\n`);
  for (const e of events) {
    const actor = e.actor_agent_id ? (getAgentById(e.actor_agent_id)?.display_name ?? e.actor_agent_id.slice(-12)) : 'system';
    const ts = e.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
    console.log(`${ts}  seq=${e.seq}  ${e.type}  by ${actor}`);
    try {
      const p = JSON.parse(e.payload_json);
      if (p && Object.keys(p).length > 0) {
        const body = JSON.stringify(p);
        const trimmed = body.length > 400 ? body.slice(0, 400) + ' …' : body;
        console.log(`    ${trimmed}`);
      }
    } catch { /* ignore */ }
    console.log('');
  }
}

async function cmdLogTask() {
  const { dbPath } = parseFlags(2);
  initDB(dbPath);
  let target = args[2] && !args[2].startsWith('-') ? args[2] : '';
  const limit = parseLogLimit(2);

  if (!target) {
    if (!isInteractive()) {
      console.log('Usage: kitty-hive log task <task-id> [--limit 100]');
      process.exit(1);
    }
    target = await askText({
      message: 'Task id',
      validate: (v) => ((v ?? '').trim().length === 0 ? 'Task id required' : undefined),
    });
  }
  const task = getTaskById(target);
  if (!task) {
    console.log(`Task "${target}" not found.`);
    process.exit(1);
  }
  const creator = getAgentById(task.creator_agent_id)?.display_name ?? task.creator_agent_id.slice(-12);
  const assignee = task.assignee_agent_id ? (getAgentById(task.assignee_agent_id)?.display_name ?? task.assignee_agent_id.slice(-12)) : 'unassigned';
  console.log(`Task ${task.id}`);
  console.log(`  title:    ${task.title}`);
  console.log(`  status:   ${task.status}${task.workflow_json ? ` (step ${task.current_step})` : ''}`);
  console.log(`  creator:  ${creator}`);
  console.log(`  assignee: ${assignee}`);
  console.log('');

  const events = getTaskEvents(task.id, 0, limit);
  if (events.length === 0) {
    console.log('(no events yet)');
    return;
  }
  console.log(`Last ${events.length} events:\n`);
  for (const e of events) {
    const actor = e.actor_agent_id ? (getAgentById(e.actor_agent_id)?.display_name ?? e.actor_agent_id.slice(-12)) : 'system';
    const ts = e.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
    console.log(`${ts}  seq=${e.seq}  ${e.type}  by ${actor}`);
    try {
      const p = JSON.parse(e.payload_json);
      if (p && Object.keys(p).length > 0) {
        const body = JSON.stringify(p);
        const trimmed = body.length > 400 ? body.slice(0, 400) + ' …' : body;
        console.log(`    ${trimmed}`);
      }
    } catch { /* ignore */ }
    console.log('');
  }
}

function getDefaultAgentName(): string {
  // Try package.json name
  const pkgPath = join(process.cwd(), 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.name) return pkg.name;
    } catch { /* ignore */ }
  }
  // Fallback to directory name
  return basename(process.cwd()) || 'agent';
}

// --- Help (per-group + root) ---

function showRootHelp() {
  console.log(`🐝 kitty-hive — multi-agent collaboration server

Usage:
  kitty-hive <command> [args]

Top-level commands:
  serve [--port 4123] [--db path] [-v|-q]    Start the MCP server
  init [tool] [--port 4123]                  Write MCP config (claude|cursor|vscode|antigravity|all)
  status [--port 4123]                       Server & agent status

Command groups:
  agent      Manage local agents       (list, rename, remove, register)
  team       Inspect/maintain teams    (list, transfer)
  peer       Manage federation peers   (invite, accept, add, list, expose, set-url, remove)
  log        Inspect message history   (dm, team, task)
  tunnel     Cloudflare tunnel control (start, status)
  config     Node config               (set)
  files      Federation files          (clean)
  db         Database maintenance      (clear)

Run \`kitty-hive <group>\` to see that group's subcommands.
Most commands prompt for missing arguments interactively.`);
}

function showAgentHelp() {
  console.log(`🐝 kitty-hive agent — local agent management

Usage:
  kitty-hive agent <subcommand> [args]

Subcommands:
  list                                                List all agents (local + remote placeholders)
  rename   [old] [new]                                Rename an agent (interactive when args omitted)
  remove   [name-or-id] | --key <K> [--yes]           Remove an agent. --key is idempotent (missing = exit 0).
                                                      Hosted teams: pass --transfer-to <agent> to keep them,
                                                      or --cascade to delete them with all members + history.
  register --key <K> --display-name <N> [--roles R]   Idempotent upsert by external_key.
                                                      Stdout = agent_id (one line). Designed for orchestrator scripts.`);
}

function showTeamHelp() {
  console.log(`🐝 kitty-hive team — local team maintenance

Usage:
  kitty-hive team <subcommand> [args]

Subcommands:
  list                                              List all teams with host + member counts
  transfer [<team>] --to <agent> [--add-member]     Transfer team host to another local agent.
                                                    --add-member auto-joins target if not yet a member.

Note: agents normally manage teams via the hive-team-* MCP tools.
This group is for operator-level maintenance (e.g. before removing a host agent).`);
}

function showPeerHelp() {
  console.log(`🐝 kitty-hive peer — federation peer management

Usage:
  kitty-hive peer <subcommand> [args]

Subcommands:
  invite   [--expose <agent>]                          Create invite token (recommended for cross-machine)
  accept   [<token>] [--expose <agent>]                Accept an invite token (auto-handshake)
  add      [<name>] [<url>] [--expose a,b] [--secret s]  Add a peer manually
  list                                                 List configured peers
  expose   [<name>] [<id1,id2,...> | --clear]          View/manage exposed agents (TTY → multiselect; non-TTY → show)
  set-url  [<name>] [<url>]                            Update a peer's URL when auto-sync missed it
  remove   [<name>]                                    Remove a peer

All subcommands prompt for missing arguments interactively.
Cross-machine setups need \`kitty-hive tunnel start\` running.`);
}

function showLogHelp() {
  console.log(`🐝 kitty-hive log — browse message history (local DB, read-only)

Usage:
  kitty-hive log <subcommand> [args]

Subcommands:
  dm   [<agent-id-or-name>] [--limit 50]    All DMs involving this agent (either direction, chronological)
  team [<team-name-or-id>]  [--limit 50]    Team event log (join/leave/message/rename)
  task [<task-id>]          [--limit 100]   Task event log (propose/approve/step-*/reject/cancel)

Interactive picker opens when the target is omitted in a TTY.`);
}

function showTunnelHelp() {
  console.log(`🐝 kitty-hive tunnel — Cloudflare tunnel control

Usage:
  kitty-hive tunnel <subcommand> [args]

Subcommands:
  start  [--port 4123] [--name name]   Run cloudflared & register the public URL with the hive
  status [--port 4123]                 Show the URL currently registered with the hive`);
}

function showConfigHelp() {
  console.log(`🐝 kitty-hive config — node configuration

Usage:
  kitty-hive config <subcommand> [args]

Subcommands:
  set [key] [value]    Set a config value (interactive when args omitted)

Known keys:
  name    Node name (the label peers see for this machine)`);
}

function showFilesHelp() {
  console.log(`🐝 kitty-hive files — federation transfer file management

Usage:
  kitty-hive files <subcommand> [args]

Subcommands:
  clean [--days 7]    Remove federation transfer files older than N days`);
}

function showDbHelp() {
  console.log(`🐝 kitty-hive db — database maintenance

Usage:
  kitty-hive db <subcommand> [args]

Subcommands:
  clear [--db path]    Delete the SQLite database (asks confirmation)`);
}

// --- Main ---

function run(fn: () => Promise<void>) {
  fn().catch(err => { console.error('Failed:', err); process.exit(1); });
}

switch (command) {
  case 'serve':
    run(cmdServe);
    break;
  case 'init':
    run(cmdInit);
    break;
  case 'status':
    run(cmdStatus);
    break;
  case 'agent':
    switch (args[1]) {
      case 'register': run(cmdAgentRegister); break;
      case 'remove':   run(cmdAgentRemove);   break;
      case 'rename':   run(cmdAgentRename);   break;
      case 'list':     run(cmdAgentList);     break;
      default:         showAgentHelp();       break;
    }
    break;
  case 'team':
    switch (args[1]) {
      case 'list':     run(cmdTeamList);     break;
      case 'transfer': run(cmdTeamTransfer); break;
      default:         showTeamHelp();        break;
    }
    break;
  case 'peer':
    switch (args[1]) {
      case 'add':     run(cmdPeerAdd);    break;
      case 'list':    run(cmdPeerList);   break;
      case 'remove':  run(cmdPeerRemove); break;
      case 'expose':  run(cmdPeerExpose); break;
      case 'set-url': run(cmdPeerSetUrl); break;
      case 'invite':  run(cmdPeerInvite); break;
      case 'accept':  run(cmdPeerAccept); break;
      default:        showPeerHelp();     break;
    }
    break;
  case 'config':
    switch (args[1]) {
      case 'set': run(cmdConfigSet); break;
      default:    showConfigHelp();  break;
    }
    break;
  case 'db':
    switch (args[1]) {
      case 'clear': run(cmdDbClear); break;
      default:      showDbHelp();    break;
    }
    break;
  case 'files':
    switch (args[1]) {
      case 'clean': run(cmdFilesClean); break;
      default:      showFilesHelp();    break;
    }
    break;
  case 'tunnel':
    switch (args[1]) {
      case 'start':  run(cmdTunnelStart);  break;
      case 'status': run(cmdTunnelStatus); break;
      default:       showTunnelHelp();     break;
    }
    break;
  case 'log':
    switch (args[1]) {
      case 'dm':   run(cmdLogDM);   break;
      case 'team': run(cmdLogTeam); break;
      case 'task': run(cmdLogTask); break;
      default:     showLogHelp();   break;
    }
    break;
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    showRootHelp();
    break;
  default:
    console.log(`Unknown command: "${command}"\n`);
    showRootHelp();
    process.exit(1);
}
