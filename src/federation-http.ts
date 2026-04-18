import { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { hostname } from 'node:os';
import { log } from './log.js';
import * as db from './db.js';
import type { Agent, FileAttachment } from './models.js';
import { handleDM } from './tools/dm.js';
import { storeFileFromBuffer } from './files.js';
import {
  handleTaskCreate, handleWorkflowPropose, handleWorkflowApprove,
  handleStepComplete, handleWorkflowReject, handleTaskClaim,
} from './tools/task.js';
import { notifyAgents, notifyTaskParticipants } from './sessions.js';

function authenticatePeer(req: IncomingMessage): db.Peer | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!match) return null;
  const peer = db.getPeerBySecret(match[1]);
  if (peer) {
    db.touchPeer(peer.name);
    db.setPeerStatus(peer.name, 'active');
  }
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

export function getNodeName(): string {
  try {
    const configPath = join(homedir(), '.kitty-hive', 'config.json');
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      if (config.name) return config.name;
    }
  } catch { /* ignore */ }
  return hostname().split('.')[0];
}

// Resolve "from_agent_id"/"from_display_name" payload → local placeholder for that remote agent.
function ensureRemoteFrom(body: any, peerName: string): Agent {
  const remoteId = body.from_agent_id || body.from || 'unknown';
  const display = body.from_display_name || body.from || remoteId;
  return db.ensureRemoteAgentByRemoteId(remoteId, peerName, display);
}

export async function handleFederation(req: IncomingMessage, res: ServerResponse, url: URL) {
  // GET /federation/ping is unauthenticated (handshake test) but echoes the secret
  if (url.pathname === '/federation/ping' && req.method === 'GET') {
    const peer = authenticatePeer(req);
    if (!peer) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const publicUrl = db.getNodeState('public_url') || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ node: getNodeName(), time: new Date().toISOString(), public_url: publicUrl }));
    return;
  }

  // POST /federation/update-url — peer announces a new URL for itself
  if (url.pathname === '/federation/update-url' && req.method === 'POST') {
    const peer = authenticatePeer(req);
    if (!peer) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const body = JSON.parse(await readBody(req));
    const newUrl: string | undefined = body.url;
    if (!newUrl || !/^https?:\/\//i.test(newUrl)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid url' }));
      return;
    }
    if (peer.url !== newUrl) {
      db.setPeerUrl(peer.name, newUrl);
      log('info', `[federation] peer "${peer.name}" updated url → ${newUrl}`);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /federation/handshake — receive callback from peer that accepted our invite.
  // Auth: token_id + secret in body must match a pending invite.
  if (url.pathname === '/federation/handshake' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const { token_id, secret, name: peerName, url: peerUrl, exposed: peerExposed } = body;
    if (!token_id || !secret || !peerName || !peerUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing token_id, secret, name, or url' }));
      return;
    }
    db.cleanupExpiredInvites();
    const invite = db.getPendingInvite(token_id);
    if (!invite) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invite not found or expired' }));
      return;
    }
    if (invite.secret !== secret) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Secret mismatch' }));
      return;
    }
    // Avoid duplicate peer name
    let localName = peerName;
    if (db.getPeerByName(localName)) {
      localName = `${peerName}-${Date.now().toString(36).slice(-4)}`;
    }
    // exposed = OUR local agent that THE PEER can reach (from our pending invite,
    // i.e. what the inviter said --as). NOT the agent the peer sent in the body
    // (that's their side's exposure, only relevant on their local peer record).
    db.addPeer(localName, peerUrl, secret, invite.exposed_agent_id);
    db.setPeerNodeName(localName, peerName);
    db.deletePendingInvite(token_id);
    log('info', `[federation] handshake accepted: peer="${localName}" url=${peerUrl}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, peer_name: localName, node: getNodeName() }));
    return;
  }

  const peer = authenticatePeer(req);
  if (!peer) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const peerName = peer.name;
  log('info', `[federation] ${req.method} ${url.pathname} from peer=${peerName}`);

  // POST /federation/agents — list agents this peer has exposed access to
  if (url.pathname === '/federation/agents' && req.method === 'POST') {
    const exposed = peer.exposed ? peer.exposed.split(',').map(s => s.trim()).filter(Boolean) : [];
    const agents: any[] = [];
    for (const ref of exposed) {
      // Accept either agent_id directly, or display_name (only if unambiguous)
      let agent = db.getAgentById(ref);
      if (!agent) {
        const matches = db.getAgentsByName(ref);
        if (matches.length === 1) agent = matches[0];
      }
      if (agent) agents.push({
        id: agent.id, display_name: agent.display_name, roles: agent.roles,
        tool: agent.tool, status: agent.status,
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ node: getNodeName(), agents }));
    return;
  }

  // POST /federation/dm
  if (url.pathname === '/federation/dm' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const { to, content } = body;
    if (!body.from_agent_id || !to || content === undefined) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing from_agent_id, to, or content' }));
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

    const remoteAgent = ensureRemoteFrom(body, peerName);
    const attachments: FileAttachment[] = Array.isArray(body.attachments) ? body.attachments : [];
    const msg = db.appendDM(remoteAgent.id, target.id, content, attachments);

    const previewBase = content || (attachments.length > 0 ? `[${attachments.length} attachment(s)]` : '');
    await notifyAgents([target.id], remoteAgent.id, JSON.stringify({
      type: 'dm', from_agent_id: remoteAgent.id, from: remoteAgent.display_name,
      preview: previewBase.length > 200 ? previewBase.slice(0, 200) + ' [summary]' : previewBase,
      attachments,
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ delivered: true, message_id: msg.id, seq: msg.seq }));
    return;
  }

  // POST /federation/file — receive raw binary, store under our own file_id
  if (url.pathname === '/federation/file' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const data = Buffer.concat(chunks);
    const filenameHeader = req.headers['x-filename'] as string | undefined;
    const filename = filenameHeader ? decodeURIComponent(filenameHeader) : 'upload';
    const meta = storeFileFromBuffer(filename, data);
    log('info', `[federation] file received: ${meta.file_id}/${filename} (${data.length} bytes)`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ file_id: meta.file_id, filename, size: data.length }));
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

  // POST /federation/task — create local replica with originator link
  if (url.pathname === '/federation/task' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const { to, title, input, originator_task_id } = body;
    if (!body.from_agent_id || !to || !title || !originator_task_id) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing from_agent_id, to, title, or originator_task_id' }));
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
    const remoteCreator = ensureRemoteFrom(body, peerName);

    // Create real task with originator link; assignee = local exposed agent
    const task = db.createTask(title, remoteCreator.id, {
      assigneeId: target.id,
      input,
      originatorPeer: peerName,
      originatorTaskId: originator_task_id,
    });
    db.appendTaskEvent(task.id, 'task-start', remoteCreator.id, {
      title, input, assignee_agent_id: target.id, federated_from: `${remoteCreator.id}@${peerName}`,
    });
    db.updateTaskStatus(task.id, 'proposing');

    await notifyTaskParticipants(task.id, remoteCreator.id, JSON.stringify({
      type: 'task-assigned', from_agent_id: remoteCreator.id, from: remoteCreator.display_name,
      task_id: task.id, preview: title,
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ task_id: task.id, status: 'proposing' }));
    return;
  }

  // POST /federation/task/event — apply state-changing events from peer
  if (url.pathname === '/federation/task/event' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const { task_id, type, workflow, step, reason, result: stepResult } = body;
    if (!body.from_agent_id || !task_id || !type) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing from_agent_id, task_id, or type' }));
      return;
    }
    const task = db.getTaskById(task_id);
    if (!task) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Task not found: ${task_id}` }));
      return;
    }
    const remoteAgent = ensureRemoteFrom(body, peerName);
    try {
      let action: any = null;
      switch (type) {
        case 'task-claim':
          action = handleTaskClaim(task_id, remoteAgent.id);
          break;
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

// --- File cleanup (called from server startup) ---

export function cleanupOldFiles(maxAgeDays: number = 7): { removed: number; kept: number } {
  const dir = filesDir();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0, kept = 0;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (st.mtimeMs < cutoff) {
        rmSync(full, { recursive: true, force: true });
        removed++;
      } else {
        kept++;
      }
    } catch { /* ignore */ }
  }
  return { removed, kept };
}
