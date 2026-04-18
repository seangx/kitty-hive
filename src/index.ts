#!/usr/bin/env node

import { startServer, setLogLevel } from './server.js';
import { initDB, addPeer, listPeers, removePeer, updatePeerExposed, getPeerByName, setPeerNodeName, setPeerStatus, touchPeer, createPendingInvite, deletePendingInvite, cleanupExpiredInvites, getNodeState } from './db.js';
import { pingPeer } from './federation-heartbeat.js';
import { TunnelManager, findCloudflared } from './tunnel.js';
import { generateToken } from './utils.js';
import { writeFileSync, existsSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname, basename, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname } from 'node:os';
import { createInterface } from 'node:readline';
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

async function ask(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` (${defaultValue})` : '';
  return new Promise(resolve => {
    rl.question(`${question}${suffix}: `, answer => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
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
  const tool = args[1];
  if (!tool || tool.startsWith('-')) {
    showInitUsage();
    process.exit(1);
  }

  const known = (ALL_INIT_TARGETS as readonly string[]);
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

  let port = 4123;
  for (let i = 2; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
      port = parseInt(args[i + 1], 10) || 4123; i++;
    }
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
  console.log(`\n  Agent registers via hive.start when first used.`);
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

  const confirm = await ask(`Delete ${resolvedPath}? (y/n)`, 'n');
  if (confirm.toLowerCase() !== 'y') {
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
  const target = args[2];
  if (!target) {
    console.log('Usage: kitty-hive agent remove <name-or-id>');
    process.exit(1);
  }

  const db = initDB(dbPath);
  const matches = db.prepare('SELECT id, display_name FROM agents WHERE id = ? OR display_name = ?').all(target, target) as any[];
  if (matches.length === 0) {
    console.log(`Agent "${target}" not found.`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.log(`"${target}" matches ${matches.length} agents. Use id to disambiguate.`);
    for (const m of matches) console.log(`  ${m.id}  ${m.display_name}`);
    process.exit(1);
  }
  const agent = matches[0];
  const name = agent.display_name;

  const confirm = await ask(`Remove agent "${name}" and all related data? (y/n)`, 'n');
  if (confirm.toLowerCase() !== 'y') {
    console.log('Cancelled.');
    process.exit(0);
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
  // Teams hosted by this agent (and their content)
  db.prepare(`DELETE FROM team_events WHERE team_id IN (SELECT id FROM teams WHERE host_agent_id = ?)`).run(agent.id);
  db.prepare(`DELETE FROM team_members WHERE team_id IN (SELECT id FROM teams WHERE host_agent_id = ?)`).run(agent.id);
  db.prepare(`DELETE FROM read_cursors WHERE target_id IN (SELECT id FROM teams WHERE host_agent_id = ?)`).run(agent.id);
  db.prepare('DELETE FROM teams WHERE host_agent_id = ?').run(agent.id);
  db.prepare('DELETE FROM agents WHERE id = ?').run(agent.id);

  console.log(`✅ Removed agent "${name}".`);
}

async function cmdAgentRename() {
  const { dbPath } = parseFlags(1);
  const oldName = args[2];
  const newName = args[3];
  if (!oldName || !newName) {
    console.log('Usage: kitty-hive agent rename <old-name> <new-name>');
    process.exit(1);
  }

  const db = initDB(dbPath);
  const matches = db.prepare('SELECT id FROM agents WHERE display_name = ? OR id = ?').all(oldName, oldName) as Array<{ id: string }>;
  if (matches.length === 0) {
    console.log(`Agent "${oldName}" not found.`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.log(`"${oldName}" matches ${matches.length} agents. Use agent id to disambiguate.`);
    process.exit(1);
  }
  db.prepare('UPDATE agents SET display_name = ? WHERE id = ?').run(newName, matches[0].id);
  console.log(`✅ Renamed "${oldName}" → "${newName}".`);
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

  if (!peerName || !peerUrl) {
    console.log('Usage: kitty-hive peer add <name> <url> [--expose agent1,agent2] [--secret s]');
    process.exit(1);
  }

  initDB(dbPath);

  if (getPeerByName(peerName)) {
    console.log(`Peer "${peerName}" already exists. Remove it first.`);
    process.exit(1);
  }

  if (!secret) {
    secret = 'sk_' + generateToken().slice(0, 32);
  }

  const peer = addPeer(peerName, peerUrl, secret, exposed);
  console.log(`🤝 Peer added: ${peerName}`);
  console.log(`   URL: ${peerUrl}`);
  console.log(`   Secret: ${secret}`);
  console.log(`   Exposed agents: ${exposed || 'none (use --expose to add)'}`);

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
  const name = args[2];
  if (!name) {
    console.log('Usage: kitty-hive peer remove <name>');
    process.exit(1);
  }
  initDB(dbPath);
  if (removePeer(name)) {
    console.log(`✅ Peer "${name}" removed.`);
  } else {
    console.log(`Peer "${name}" not found.`);
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
  if (!process.stdin.isTTY) {
    // Non-interactive (e.g. systemd) — silently use hostname
    return defaultName;
  }
  console.log(`\n📛 No node name set. Peers will see you under this name.`);
  const answer = (await ask(`   Node name`, defaultName)).trim() || defaultName;
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
  if (!exposed) {
    console.log('Usage: kitty-hive peer invite --expose <my-agent-id>');
    console.log('  --expose  YOUR local agent that the peer should be allowed to reach');
    console.log('');
    console.log('  Cross-machine? Run `kitty-hive tunnel start` first; the URL will be picked up');
    console.log('  automatically. (Advanced: --url <https://.../mcp> overrides.)');
    process.exit(1);
  }
  initDB(dbPath);
  cleanupExpiredInvites();

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
  if (!token || !myExposed) {
    console.log('Usage: kitty-hive peer accept <token> --expose <my-agent-id>');
    console.log('  --expose  YOUR local agent that the inviter should be allowed to reach');
    console.log('');
    console.log('  Cross-machine? Run `kitty-hive tunnel start` first; the URL will be picked up');
    console.log('  automatically. (Advanced: --url <https://.../mcp> overrides.)');
    console.log('  (The token already contains the inviter\'s URL, secret, and exposed agent.)');
    process.exit(1);
  }

  let invite: InvitePayload;
  try { invite = decodeInvite(token); }
  catch (err) { console.log(`Invalid invite: ${(err as any).message}`); process.exit(1); }

  initDB(dbPath);
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

async function cmdPeerExpose() {
  const { dbPath } = parseFlags(1);
  const peerName = args[2];
  if (!peerName) {
    console.log('Usage: kitty-hive peer expose <peer> --add/--remove <agent>');
    process.exit(1);
  }
  initDB(dbPath);
  const peer = getPeerByName(peerName);
  if (!peer) {
    console.log(`Peer "${peerName}" not found.`);
    process.exit(1);
  }

  const current = peer.exposed ? peer.exposed.split(',').map(s => s.trim()).filter(Boolean) : [];

  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--add' && args[i + 1]) {
      const agents = args[i + 1].split(',').map(s => s.trim());
      for (const a of agents) if (!current.includes(a)) current.push(a);
      i++;
    } else if (args[i] === '--remove' && args[i + 1]) {
      const agents = args[i + 1].split(',').map(s => s.trim());
      for (const a of agents) {
        const idx = current.indexOf(a);
        if (idx >= 0) current.splice(idx, 1);
      }
      i++;
    }
  }

  updatePeerExposed(peerName, current.join(','));
  console.log(`✅ Peer "${peerName}" exposed agents: ${current.join(', ') || 'none'}`);
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

async function cmdConfigSet() {
  // kitty-hive config set name marvin
  const key = args[2];
  const value = args[3];
  if (!key || !value) {
    console.log('Usage: kitty-hive config set <key> <value>');
    console.log('  e.g. kitty-hive config set name marvin');
    process.exit(1);
  }
  setNodeConfig({ [key]: value });
  console.log(`✅ ${key} = ${value}`);
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

function showHelp() {
  console.log(`🐝 kitty-hive — multi-agent collaboration server

Usage:
  kitty-hive serve [--port 4123] [--db path] [-v|-q]     Start the server
  kitty-hive init <tool> [--port 4123]                    Write MCP config (claude|cursor|vscode|antigravity|all)
  kitty-hive status [--port 4123]                         Server & agent status
  kitty-hive agent list                                   List agents
  kitty-hive agent rename <old> <new>                     Rename an agent
  kitty-hive agent remove <name>                          Remove an agent
  kitty-hive peer invite --expose <my-agent>              Create invite token (recommended)
  kitty-hive peer accept <token> --expose <my-agent>      Accept an invite token (auto-handshake)
  kitty-hive peer add <name> <url> [--expose a,b] [--secret s]  Add a peer (manual)
  kitty-hive peer list                                    List peers
  kitty-hive peer remove <name>                           Remove a peer
  kitty-hive peer expose <name> --add/--remove <agent>    Manage exposed agents
  kitty-hive config set <key> <value>                     Set config (e.g. name)
  kitty-hive db clear [--db path]                         Clear the database
  kitty-hive files clean [--days 7]                       Remove old federation transfer files
  kitty-hive tunnel start [--port 4123] [--name name]     Run cloudflared & register URL with the hive
  kitty-hive tunnel status [--port 4123]                  Show currently registered tunnel URL`);
}

// --- Main ---

switch (command) {
  case 'serve':
    cmdServe().catch(err => { console.error('Failed:', err); process.exit(1); });
    break;
  case 'init':
    cmdInit().catch(err => { console.error('Failed:', err); process.exit(1); });
    break;
  case 'status':
    cmdStatus().catch(err => { console.error('Failed:', err); process.exit(1); });
    break;
  case 'agent':
    if (args[1] === 'remove') {
      cmdAgentRemove().catch(err => { console.error('Failed:', err); process.exit(1); });
    } else if (args[1] === 'rename') {
      cmdAgentRename().catch(err => { console.error('Failed:', err); process.exit(1); });
    } else if (args[1] === 'list') {
      cmdAgentList().catch(err => { console.error('Failed:', err); process.exit(1); });
    } else {
      showHelp();
    }
    break;
  case 'peer':
    if (args[1] === 'add') {
      cmdPeerAdd().catch(err => { console.error('Failed:', err); process.exit(1); });
    } else if (args[1] === 'list') {
      cmdPeerList().catch(err => { console.error('Failed:', err); process.exit(1); });
    } else if (args[1] === 'remove') {
      cmdPeerRemove().catch(err => { console.error('Failed:', err); process.exit(1); });
    } else if (args[1] === 'expose') {
      cmdPeerExpose().catch(err => { console.error('Failed:', err); process.exit(1); });
    } else if (args[1] === 'invite') {
      cmdPeerInvite().catch(err => { console.error('Failed:', err); process.exit(1); });
    } else if (args[1] === 'accept') {
      cmdPeerAccept().catch(err => { console.error('Failed:', err); process.exit(1); });
    } else {
      showHelp();
    }
    break;
  case 'config':
    if (args[1] === 'set') {
      cmdConfigSet().catch(err => { console.error('Failed:', err); process.exit(1); });
    } else {
      showHelp();
    }
    break;
  case 'db':
    if (args[1] === 'clear') {
      cmdDbClear().catch(err => { console.error('Failed:', err); process.exit(1); });
    } else {
      showHelp();
    }
    break;
  case 'files':
    if (args[1] === 'clean') {
      cmdFilesClean().catch(err => { console.error('Failed:', err); process.exit(1); });
    } else {
      showHelp();
    }
    break;
  case 'tunnel':
    if (args[1] === 'start') {
      cmdTunnelStart().catch(err => { console.error('Failed:', err); process.exit(1); });
    } else if (args[1] === 'status') {
      cmdTunnelStatus().catch(err => { console.error('Failed:', err); process.exit(1); });
    } else {
      showHelp();
    }
    break;
  default:
    showHelp();
    break;
}
