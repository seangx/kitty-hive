import { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { hostname } from 'node:os';
import { log } from './log.js';
import * as db from './db.js';
import type { Agent } from './models.js';
import { handleDM } from './tools/dm.js';
import { handleTaskCreate, handleWorkflowPropose, handleWorkflowApprove, handleStepComplete, handleWorkflowReject } from './tools/task.js';
import { notifyAgents, notifyTaskParticipants } from './sessions.js';

function authenticatePeer(req: IncomingMessage): db.Peer | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!match) return null;
  const peer = db.getPeerBySecret(match[1]);
  if (peer) db.touchPeer(peer.name);
  return peer ?? null;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

function filesDir(): string {
  const dir = join(homedir(), '.kitty-hive', 'files');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function getNodeName(): string {
  try {
    const configPath = join(homedir(), '.kitty-hive', 'config.json');
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      if (config.name) return config.name;
    }
  } catch { /* ignore */ }
  return hostname().split('.')[0];
}

// Find or create a placeholder agent for a remote peer agent (keyed by name@peer).
function ensureRemoteAgent(name: string, peerName: string): Agent {
  const placeholderName = `${name}@${peerName}`;
  const existing = db.getAgentsByName(placeholderName);
  if (existing.length > 0) return existing[0];
  return db.createAgent(placeholderName, 'remote', `peer:${peerName}`, '');
}

export async function handleFederation(req: IncomingMessage, res: ServerResponse, url: URL) {
  const peer = authenticatePeer(req);
  if (!peer) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const peerName = (req.headers['x-hive-peer'] as string) || peer.name;
  log('info', `[federation] ${req.method} ${url.pathname} from peer=${peerName}`);

  // POST /federation/agents
  if (url.pathname === '/federation/agents' && req.method === 'POST') {
    const exposed = peer.exposed ? peer.exposed.split(',').map(s => s.trim()).filter(Boolean) : [];
    const agents: any[] = [];
    for (const id of exposed) {
      const agent = db.getAgentById(id);
      if (agent) agents.push({ id: agent.id, display_name: agent.display_name, roles: agent.roles, status: agent.status });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ node: getNodeName(), agents }));
    return;
  }

  // POST /federation/dm
  if (url.pathname === '/federation/dm' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const { from, to, content, file_id } = body;
    if (!from || !to || !content) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing from, to, or content' }));
      return;
    }
    if (!db.isPeerExposed(peer.name, to)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Agent "${to}" is not accessible` }));
      return;
    }
    const target = db.getAgentById(to);
    if (!target) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Agent "${to}" not found` }));
      return;
    }

    const remoteAgent = ensureRemoteAgent(from, peerName);
    const msgContent = file_id ? `${content}\n\n[file: ${file_id}]` : content;
    const result = handleDM(remoteAgent.id, { to: target.id, content: msgContent });

    await notifyAgents([target.id], remoteAgent.id, JSON.stringify({
      type: 'dm', from_agent_id: remoteAgent.id, from: remoteAgent.display_name,
      preview: content.length > 200 ? content.slice(0, 200) + ' [summary]' : content,
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ delivered: true, message_id: result.message_id, seq: result.seq }));
    return;
  }

  // POST /federation/file
  if (url.pathname === '/federation/file' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const data = Buffer.concat(chunks);
    const filename = (req.headers['x-filename'] as string) || 'upload';
    const fileId = 'f_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    const fileDir = join(filesDir(), fileId);
    mkdirSync(fileDir, { recursive: true });
    writeFileSync(join(fileDir, filename), data);
    log('info', `[federation] file received: ${fileId}/${filename} (${data.length} bytes)`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ file_id: fileId, filename, size: data.length }));
    return;
  }

  // GET /federation/file/:id
  if (url.pathname.startsWith('/federation/file/') && req.method === 'GET') {
    const fileId = url.pathname.split('/').pop();
    if (!fileId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing file ID' }));
      return;
    }
    const fileDir = join(filesDir(), fileId);
    if (!existsSync(fileDir)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File not found' }));
      return;
    }
    const files = readdirSync(fileDir);
    if (files.length === 0) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File not found' }));
      return;
    }
    const filePath = join(fileDir, files[0]);
    const fileData = readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${files[0]}"`,
    });
    res.end(fileData);
    return;
  }

  // POST /federation/task
  if (url.pathname === '/federation/task' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const { from, to, title, input } = body;
    if (!from || !to || !title) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing from, to, or title' }));
      return;
    }
    if (!db.isPeerExposed(peer.name, to)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Agent "${to}" is not accessible` }));
      return;
    }
    const target = db.getAgentById(to);
    if (!target) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Agent "${to}" not found` }));
      return;
    }
    const remoteAgent = ensureRemoteAgent(from, peerName);
    const result = handleTaskCreate(remoteAgent.id, { to: target.id, title, input });
    await notifyTaskParticipants(result.task_id, remoteAgent.id, JSON.stringify({
      type: 'task-assigned', from_agent_id: remoteAgent.id, from: remoteAgent.display_name,
      task_id: result.task_id, preview: title,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ task_id: result.task_id, status: result.status }));
    return;
  }

  // POST /federation/task/event
  if (url.pathname === '/federation/task/event' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const { from, task_id, type, workflow, step, reason, result: stepResult } = body;
    if (!from || !task_id || !type) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing from, task_id, or type' }));
      return;
    }
    const remoteAgent = ensureRemoteAgent(from, peerName);
    const task = db.getTaskById(task_id);
    if (!task) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Task not found: ${task_id}` }));
      return;
    }
    try {
      let action: any = null;
      switch (type) {
        case 'task-propose':
          handleWorkflowPropose(task_id, remoteAgent.id, workflow);
          break;
        case 'task-approve':
          action = handleWorkflowApprove(task_id, remoteAgent.id);
          break;
        case 'step-complete':
          action = handleStepComplete(task_id, remoteAgent.id, step, stepResult);
          break;
        case 'task-reject':
          action = handleWorkflowReject(task_id, remoteAgent.id, step, reason);
          break;
        default:
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Unknown event type: ${type}` }));
          return;
      }
      await notifyTaskParticipants(task_id, remoteAgent.id, JSON.stringify({
        type, from_agent_id: remoteAgent.id, from: remoteAgent.display_name,
        task_id, preview: `${type} from ${remoteAgent.display_name}`,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, action }));
    } catch (err: any) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unknown federation endpoint' }));
}
