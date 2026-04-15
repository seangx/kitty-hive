#!/usr/bin/env node

import { startServer, setLogLevel } from './server.js';
import { initDB, addPeer, listPeers, removePeer, updatePeerExposed, getPeerByName } from './db.js';
import { generateToken } from './utils.js';
import { writeFileSync, existsSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

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

async function cmdInit() {
  console.log('🐝 kitty-hive init — configure HTTP MCP for non-Claude-Code clients\n');
  console.log('   (Claude Code users: install the kitty-hive plugin instead)\n');

  let port = 4123;
  let explicitPort = false;

  for (let i = 1; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
      port = parseInt(args[i + 1], 10); explicitPort = true; i++;
    }
  }

  if (!explicitPort) {
    const p = await ask('Hive server port', '4123');
    port = parseInt(p, 10) || 4123;
  }

  const mcpJsonPath = join(process.cwd(), '.mcp.json');
  let existing: any = {};
  if (existsSync(mcpJsonPath)) {
    try { existing = JSON.parse(readFileSync(mcpJsonPath, 'utf8')); } catch { /* ignore */ }
  }
  if (!existing.mcpServers) existing.mcpServers = {};

  existing.mcpServers['hive'] = {
    url: `http://localhost:${port}/mcp`,
  };
  delete existing.mcpServers['hive-channel'];

  writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2) + '\n');
  console.log(`🐝 Configured`);
  console.log(`   Server: http://localhost:${port}/mcp`);
  console.log(`   Mode: HTTP MCP (for Antigravity, Cursor, VS Code, etc.)`);
  console.log(`\n   Agent registers via hive.start when first used.`);
}

async function cmdStatus() {
  const { port, dbPath } = parseFlags(1);
  const url = `http://localhost:${port}/mcp`;

  // Check server
  try {
    const res = await fetch(url, { method: 'GET' });
    console.log(`🐝 Server: http://localhost:${port}/mcp (online)`);
  } catch {
    console.log(`❌ Server: http://localhost:${port}/mcp (offline)`);
    process.exit(1);
  }

  // Check DB
  try {
    const db = initDB(dbPath);
    const agents = db.prepare('SELECT id, display_name, status, last_seen FROM agents ORDER BY last_seen DESC').all() as any[];
    const rooms = db.prepare("SELECT id, name, kind FROM rooms WHERE closed_at IS NULL").all() as any[];
    const tasks = db.prepare("SELECT count(*) as cnt FROM tasks WHERE status NOT IN ('completed','failed','canceled')").get() as { cnt: number };

    console.log(`\n📊 Database: ${dbPath || '~/.kitty-hive/hive.db'}`);
    console.log(`   Rooms: ${rooms.length}  Active tasks: ${tasks.cnt}`);

    console.log(`\n👥 Agents (${agents.length}):`);
    for (const a of agents) {
      // Find rooms this agent is in
      const memberRooms = db.prepare(`
        SELECT DISTINCT r.name FROM rooms r
        JOIN room_events e ON e.room_id = r.id AND e.type = 'join' AND e.actor_agent_id = ?
        WHERE r.closed_at IS NULL AND NOT EXISTS (
          SELECT 1 FROM room_events e2 WHERE e2.room_id = r.id AND e2.type = 'leave' AND e2.actor_agent_id = ? AND e2.seq > e.seq
        )
      `).all(a.id, a.id) as any[];
      const roomNames = memberRooms.map((r: any) => r.name).filter(Boolean).join(', ');
      console.log(`   ${a.display_name} (${a.status}) — ${roomNames || 'no rooms'}`);
    }

    if (rooms.length > 0) {
      console.log(`\n🏠 Rooms:`);
      for (const r of rooms) {
        const memberCount = db.prepare(`
          SELECT COUNT(DISTINCT e.actor_agent_id) as cnt FROM room_events e
          WHERE e.room_id = ? AND e.type = 'join'
        `).get(r.id) as { cnt: number };
        console.log(`   ${r.name || r.id} (${r.kind}) — ${memberCount.cnt} members`);
      }
    }
  } catch (err) {
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
  const name = args[2];
  if (!name) {
    console.log('Usage: kitty-hive agent remove <name>');
    process.exit(1);
  }

  const db = initDB(dbPath);
  const agent = db.prepare('SELECT id, display_name FROM agents WHERE display_name = ?').get(name) as any;
  if (!agent) {
    console.log(`Agent "${name}" not found.`);
    process.exit(1);
  }

  const confirm = await ask(`Remove agent "${name}" and all related data? (y/n)`, 'n');
  if (confirm.toLowerCase() !== 'y') {
    console.log('Cancelled.');
    process.exit(0);
  }

  db.prepare('DELETE FROM read_cursors WHERE agent_id = ?').run(agent.id);
  db.prepare('DELETE FROM task_events WHERE actor_agent_id = ?').run(agent.id);
  db.prepare('DELETE FROM room_events WHERE actor_agent_id = ?').run(agent.id);
  db.prepare('UPDATE tasks SET assignee_agent_id = NULL WHERE assignee_agent_id = ?').run(agent.id);
  db.prepare('DELETE FROM agents WHERE id = ?').run(agent.id);

  console.log(`✅ Removed agent "${name}".`);
}

async function cmdAgentList() {
  const { dbPath } = parseFlags(1);
  const db = initDB(dbPath);
  const agents = db.prepare('SELECT display_name, roles, status, last_seen FROM agents ORDER BY last_seen DESC').all() as any[];
  if (agents.length === 0) {
    console.log('No agents registered.');
    return;
  }
  for (const a of agents) {
    console.log(`  ${a.display_name} (${a.status}) roles=${a.roles || 'none'} last_seen=${a.last_seen}`);
  }
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
  return getNodeConfig().name || require('os').hostname().split('.')[0];
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
  for (const p of peers) {
    console.log(`  ${p.name} (${p.status}) — ${p.url}`);
    console.log(`    exposed: ${p.exposed || 'none'}`);
    console.log(`    last seen: ${p.last_seen || 'never'}`);
  }
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
  return process.cwd().split('/').pop() || 'agent';
}

function showHelp() {
  console.log(`🐝 kitty-hive — multi-agent collaboration server

Usage:
  kitty-hive serve [--port 4123] [--db path] [-v|-q]     Start the server
  kitty-hive init [--port 4123]                           Configure HTTP MCP for this project
  kitty-hive status [--port 4123]                         Server & agent status
  kitty-hive agent list                                   List agents
  kitty-hive agent remove <name>                          Remove an agent
  kitty-hive peer add <name> <url> [--expose a,b] [--secret s]  Add a peer
  kitty-hive peer list                                    List peers
  kitty-hive peer remove <name>                           Remove a peer
  kitty-hive peer expose <name> --add/--remove <agent>    Manage exposed agents
  kitty-hive config set <key> <value>                     Set config (e.g. name)
  kitty-hive db clear [--db path]                         Clear the database`);
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
  default:
    showHelp();
    break;
}
