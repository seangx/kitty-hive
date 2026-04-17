import { randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { initDB, cleanupStaleTasks } from './db.js';
import { log, setLogLevel } from './log.js';
import { sessions, unbindSession, sessionAgents, activeSSE } from './sessions.js';
import { createMcpServer } from './mcp/server.js';
import { handleFederation } from './federation-http.js';

export { setLogLevel };

export async function startServer(port: number, dbPath?: string): Promise<void> {
  initDB(dbPath);

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    // Federation routes
    if (url.pathname.startsWith('/federation/')) {
      await handleFederation(req, res, url);
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. MCP endpoint is at /mcp' }));
      return;
    }

    // GET: SSE stream
    if (req.method === 'GET') {
      const sid = req.headers['mcp-session-id'] as string | undefined;
      if (!sid || !sessions[sid]) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing session ID' }));
        return;
      }
      log('info', `[sse] opening stream for session=${sid} agent=${sessionAgents.get(sid) || 'unbound'}`);
      activeSSE.add(sid);
      res.on('close', () => {
        activeSSE.delete(sid);
        log('info', `[sse] stream closed for session=${sid}`);
      });
      await sessions[sid].transport.handleRequest(req, res);
      return;
    }

    // DELETE: session termination
    if (req.method === 'DELETE') {
      const sid = req.headers['mcp-session-id'] as string | undefined;
      if (!sid || !sessions[sid]) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing session ID' }));
        return;
      }
      log('info', `[session] DELETE session=${sid}`);
      unbindSession(sid);
      await sessions[sid].transport.handleRequest(req, res);
      return;
    }

    // POST: JSON-RPC
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());

      const sid = req.headers['mcp-session-id'] as string | undefined;
      const method = body?.method || (Array.isArray(body) ? `batch[${body.length}]` : 'unknown');
      const tool = body?.params?.name || '';
      const isHeartbeat = tool === 'hive.inbox' || method === 'notifications/initialized';
      if (!isHeartbeat) {
        log('info', `[rpc] method=${method} sid=${sid || 'none'} tool=${tool || '-'}`);
      }

      if (sid && sessions[sid]) {
        await sessions[sid].transport.handleRequest(req, res, body);
      } else if (sid && !sessions[sid]) {
        // Stale session id (e.g. after server restart) — reject with 404 so the client
        // knows to re-initialize. Do NOT fall through to stateless: that would create
        // a transport with no sessionId, breaking session binding for push notifications.
        log('info', `[session] stale sid=${sid} method=${method} → 404 (client should re-init)`);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found. Re-initialize.' },
          id: body?.id ?? null,
        }));
        return;
      } else if (!sid && isInitializeRequest(body)) {
        const server = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSid: string) => {
            log('info', `[session] new session: ${newSid}`);
            sessions[newSid] = { transport, server };
          },
        });
        transport.onclose = () => {
          const tSid = transport.sessionId;
          if (tSid) {
            log('debug', `[session] transport closed: ${tSid}`);
            unbindSession(tSid);
            delete sessions[tSid];
          }
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } else {
        // Stateless fallback (per-request server, no session)
        if (!isHeartbeat) log('debug', `[rpc] stateless: method=${method} tool=${tool || '-'}`);
        const server = createMcpServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        res.on('close', () => { transport.close(); server.close(); });
      }
    } catch (error) {
      console.error('[rpc] error:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        }));
      }
    }
  });

  httpServer.listen(port, () => {
    console.log(`🐝 kitty-hive listening on http://localhost:${port}/mcp`);
    console.log(`   Database: ${dbPath || '~/.kitty-hive/hive.db'}`);
    console.log(`   Mode: stateful (SSE push enabled)`);
  });

  setInterval(() => {
    const count = cleanupStaleTasks(7);
    if (count > 0) log('info', `[cleanup] removed ${count} stale tasks`);
  }, 60 * 60 * 1000);

  process.on('SIGINT', async () => {
    for (const sid in sessions) {
      try { await sessions[sid].transport.close(); } catch { /* ignore */ }
      delete sessions[sid];
    }
    process.exit(0);
  });
}
