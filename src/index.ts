#!/usr/bin/env node

import { startServer, setLogLevel } from './server.js';
import { initDB } from './db.js';
import { writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);
const command = args[0];

function parseFlags(startIdx: number) {
  let port = 4100;
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
  // Support: kitty-hive init [agent-name] [--port N] [--http]
  let agentName = '';
  let useChannel = true;
  const { port } = parseFlags(1);

  // Parse init-specific args
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--http') { useChannel = false; }
    else if (args[i] === '--port' || args[i] === '-p') { i++; } // skip, already parsed
    else if (args[i] === '--db') { i++; }
    else if (!args[i].startsWith('-')) { agentName = args[i]; }
  }

  // Interactive fallback only if no agent name provided
  if (!agentName) {
    agentName = await ask('Agent name', getDefaultAgentName());
  }

  const channelPath = join(__dirname, '..', 'channel.ts');
  const mcpJsonPath = join(process.cwd(), '.mcp.json');
  let existing: any = {};
  if (existsSync(mcpJsonPath)) {
    try { existing = JSON.parse(readFileSync(mcpJsonPath, 'utf8')); } catch { /* ignore */ }
  }
  if (!existing.mcpServers) existing.mcpServers = {};

  if (useChannel) {
    existing.mcpServers['hive-channel'] = {
      command: 'npx',
      args: ['tsx', channelPath],
      env: {
        HIVE_URL: `http://localhost:${port}/mcp`,
        HIVE_AGENT_NAME: agentName,
      },
    };
    delete existing.mcpServers['hive'];
  } else {
    existing.mcpServers['hive'] = {
      url: `http://localhost:${port}/mcp`,
    };
    delete existing.mcpServers['hive-channel'];
  }

  writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2) + '\n');
  console.log(`🐝 kitty-hive configured`);
  console.log(`   Agent: ${agentName}`);
  console.log(`   Server: http://localhost:${port}/mcp`);
  console.log(`   Mode: ${useChannel ? 'channel (push)' : 'HTTP (pull)'}`);

  if (useChannel) {
    console.log(`\n   Run: claude --dangerously-load-development-channels server:hive-channel`);
  }
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
    const agents = db.prepare('SELECT display_name, status, last_seen FROM agents ORDER BY last_seen DESC').all() as any[];
    const rooms = db.prepare('SELECT count(*) as cnt FROM rooms').get() as { cnt: number };
    const events = db.prepare('SELECT count(*) as cnt FROM room_events').get() as { cnt: number };

    console.log(`\n📊 Database: ${dbPath || '~/.kitty-hive/hive.db'}`);
    console.log(`   Rooms: ${rooms.cnt}  Events: ${events.cnt}`);
    console.log(`\n👥 Agents (${agents.length}):`);
    for (const a of agents) {
      console.log(`   ${a.display_name} (${a.status}) — last seen ${a.last_seen}`);
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
  kitty-hive serve [--port 4100] [--db path]    Start the server
  kitty-hive init <name> [--port 4123] [--http]  Configure hive for this project
  kitty-hive status [--port 4100]                Check server & agent status
  kitty-hive db clear [--db path]                Clear the database

Examples:
  kitty-hive init myagent                  Channel mode (push notifications)
  kitty-hive init myagent --http           HTTP mode (for Antigravity/Cursor)
  kitty-hive init myagent --port 4200      Custom server port

Options:
  --port, -p   Port (default: 4100 for serve, 4123 for init)
  --db         Database path (default: ~/.kitty-hive/hive.db)
  --http       Use HTTP MCP instead of channel plugin
  --verbose/-v Show debug logs (serve)
  --quiet/-q   Only show warnings and errors (serve)`);
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
