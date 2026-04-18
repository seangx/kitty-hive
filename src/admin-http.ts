/**
 * Local-only admin HTTP endpoints. Used by helper processes (e.g. `kitty-hive tunnel start`)
 * to push runtime state into the running hive without needing peer credentials.
 *
 * Auth: only accept connections from 127.0.0.1 / ::1 / ::ffff:127.0.0.1 (loopback).
 */

import { IncomingMessage, ServerResponse } from 'node:http';
import * as db from './db.js';
import { log } from './log.js';

function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

export async function broadcastUrlChange(newUrl: string): Promise<{ ok: number; fail: number }> {
  const peers = db.listPeers();
  let ok = 0, fail = 0;
  await Promise.all(peers.map(async p => {
    try {
      const r = await fetch(p.url.replace('/mcp', '/federation/update-url'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${p.secret}`,
        },
        body: JSON.stringify({ url: newUrl }),
      });
      if (r.ok) ok++; else fail++;
    } catch { fail++; }
  }));
  return { ok, fail };
}

export async function handleAdmin(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (!isLoopback(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Admin endpoints are loopback-only' }));
    return;
  }

  // POST /admin/tunnel-url — set/clear the current public URL and broadcast to peers
  if (url.pathname === '/admin/tunnel-url' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const newUrl: string = (body.url || '').trim();
    if (newUrl && !/^https?:\/\//i.test(newUrl)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid url' }));
      return;
    }
    const previous = db.getNodeState('public_url') || '';
    if (newUrl) {
      db.setNodeState('public_url', newUrl);
    } else {
      db.deleteNodeState('public_url');
    }
    let broadcast = { ok: 0, fail: 0 };
    if (newUrl && newUrl !== previous) {
      broadcast = await broadcastUrlChange(newUrl);
      log('info', `[admin] tunnel url → ${newUrl} (broadcast ok=${broadcast.ok} fail=${broadcast.fail})`);
    } else if (!newUrl && previous) {
      log('info', `[admin] tunnel url cleared (was ${previous})`);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, previous, current: newUrl, broadcast }));
    return;
  }

  // GET /admin/tunnel-url — query current public URL
  if (url.pathname === '/admin/tunnel-url' && req.method === 'GET') {
    const url = db.getNodeState('public_url') || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unknown admin endpoint' }));
}
