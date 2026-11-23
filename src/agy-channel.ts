/**
 * Antigravity CLI (agy) 的 kitty-hive MCP 通道与推送桥服务端
 *
 * 运行方式：`kitty-hive agy-channel`（由 Antigravity 插件的 mcp_config.json 拉起）
 *
 * 职责：
 * 1. 作为 stdio MCP server 向 agy 暴露所有 `hive-*` 工具（自动注入 `as: agentId`）及本地 `hive-whoami`；
 * 2. 以 `kitty-hive/event-consumer` 身份维护到 kitty-hive HTTP 服务的长连接与 SSE 推送流；
 * 3. 启动本地 Unix domain socket（AgyBridgeServer），将 SSE 推送转发给同会话的 agy-relay，
 *    或交由 agy-hook 在 PreInvocation / Stop 节点兜底注入；
 * 4. hive 重启重连时自动刷新工具列表，有变化时发送 `notifications/tools/list_changed`。
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AgyBridgeServer, bridgeSocketPath } from './agy-bridge.js';

interface MCPTool {
  name: string;
  description?: string;
  inputSchema: any;
}

function hiveToKebab(name: string): string {
  return name.replace(/_/g, '-');
}

function kebabToHive(name: string): string {
  return name.replace(/-/g, '_');
}

function stripAsParam(schema: any): any {
  if (!schema?.properties) return schema;
  const { as: _as, ...rest } = schema.properties;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((r: string) => r !== 'as')
    : undefined;
  const out: any = { ...schema, properties: rest };
  if (required && required.length > 0) out.required = required;
  else delete out.required;
  return out;
}

function toolListFingerprint(tools: MCPTool[]): string {
  return JSON.stringify(
    tools.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema })),
  );
}

const WHOAMI_TOOL: MCPTool = {
  name: 'hive-whoami',
  description:
    'Show your agent id, display_name, registration info, and Antigravity push-bridge status. ' +
    'If not registered yet, pass `name` to register on kitty-hive.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Agent name (only when first registering)' },
    },
  },
};

export async function runAgyChannel(): Promise<void> {
  const HIVE_URL = process.env.HIVE_URL || 'http://localhost:4123/mcp';
  const HIVE_AGENT_ID = process.env.HIVE_AGENT_ID || '';
  const HIVE_AGENT_KEY = process.env.HIVE_AGENT_KEY || '';
  const HIVE_AGENT_NAME = process.env.HIVE_AGENT_NAME || '';
  const HIVE_AGENT_ROLES = process.env.HIVE_AGENT_ROLES || '';
  const SOCKET_PATH = process.env.HIVE_AGY_BRIDGE_SOCKET || bridgeSocketPath(process.ppid);

  let sessionId: string | null = null;
  let agentId: string | null = null;
  let agentName: string | null = null;
  let rpcId = 0;
  let sseStarted = false;
  let shuttingDown = false;
  let cachedHiveTools: MCPTool[] = [];
  let cachedFingerprint = '';

  const bridge = new AgyBridgeServer({
    socketPath: SOCKET_PATH,
    getIdentity: () => ({ agentId, agentName }),
    onLog: (msg) => console.error(`[agy-channel] ${msg}`),
  });

  await bridge.start();
  console.error(`[agy-channel] bridge socket listening on ${SOCKET_PATH}`);

  const mcp = new Server(
    { name: 'agy-channel', version: '1.0.0' },
    {
      capabilities: {
        tools: { listChanged: true },
      },
      instructions: [
        'You are connected to kitty-hive, a multi-agent collaboration server, via the Antigravity channel bridge.',
        '',
        '## Identity',
        '- If not auto-registered, ask the user "What name should I register on the hive?" and call hive-whoami(name=<that name>).',
        '- Check hive-whoami: if `relay_connected` is false in an interactive agy session, start real-time idle push wakeup by running `kitty-hive agy-relay` with run_command(IsDaemon=true, WaitMsBeforeAsync=500, BypassSandbox=true).',
        '',
        '## Push notifications (id-only)',
        '- Incoming hive notifications arrive via Antigravity messaging or hook injection with sender, type, and record identifiers.',
        '- Always fetch full content before acting:',
        '    DM         → hive-dm-read({ message_id: N })',
        '    Task event → hive-check({ task_id: "..." })',
        '    Team event → hive-team-events({ team_id: "..." }) (or hive-team-info for team-rules-update)',
        '',
        '## File transfer',
        '- Never pass local file paths in DM text expecting another machine to read them. Use hive-dm({ ..., attach: ["/abs/path"] }) and hive-file-fetch({ file_id }).',
        '',
        '## Team rules & workflows',
        '- Honor team.rules (from hive-team-info) as binding house rules inside that team.',
        '- Ordinary tasks finish with hive-task-complete. Only propose/start a workflow when explicitly requested.',
      ].join('\n'),
    },
  );

  async function hivePost(method: string, params: any = {}, _retried = false): Promise<any> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    if (sessionId && method !== 'initialize') headers['Mcp-Session-Id'] = sessionId;

    const res = await fetch(HIVE_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });

    if (res.status === 404 && !_retried && method !== 'initialize') {
      console.error('[agy-channel] server returned 404 (stale session); re-initializing...');
      sessionId = null;
      await initHiveSession();
      if (agentId) await hiveCallTool('hive_start', reconnectArgs(), true);
      await refreshHiveTools(true);
      return hivePost(method, params, true);
    }

    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;

    const text = await res.text();
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) {
        const data = JSON.parse(line.slice(5));
        if (data.error) throw new Error(JSON.stringify(data.error));
        return data.result;
      }
    }
    const data = JSON.parse(text);
    if (data.error) throw new Error(JSON.stringify(data.error));
    return data.result;
  }

  async function hiveCallTool(name: string, args: any = {}, _retried = false): Promise<any> {
    const result = await hivePost('tools/call', { name, arguments: args }, _retried);
    const text = result.content?.[0]?.text ?? '';
    if (result.isError) throw new Error(text);
    try { return JSON.parse(text); } catch { return text; }
  }

  async function initHiveSession(): Promise<void> {
    sessionId = null;
    await hivePost('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: { experimental: { 'kitty-hive/event-consumer': {} } },
      clientInfo: { name: 'agy-channel', version: '1.0' },
    });
    await fetch(HIVE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Mcp-Session-Id': sessionId!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
  }

  function reconnectArgs(): Record<string, any> {
    const a: Record<string, any> = { tool: 'antigravity' };
    if (agentId) a.id = agentId;
    if (HIVE_AGENT_ROLES) a.roles = HIVE_AGENT_ROLES;
    return a;
  }

  async function refreshHiveTools(notifyIfChanged = false): Promise<void> {
    try {
      const result = await hivePost('tools/list', {});
      const next = (result.tools || []).filter((t: MCPTool) => t.name.startsWith('hive_'));
      const nextFp = toolListFingerprint(next);
      const changed = cachedFingerprint !== '' && cachedFingerprint !== nextFp;
      cachedHiveTools = next;
      cachedFingerprint = nextFp;
      if (notifyIfChanged && changed) {
        try {
          await mcp.notification({ method: 'notifications/tools/list_changed' });
          console.error('[agy-channel] tool list changed; notified Antigravity client');
        } catch {
          // 忽略客户端未就绪时的通知错误
        }
      }
    } catch (err) {
      console.error('[agy-channel] failed to fetch tool list:', err);
    }
  }

  async function registerAgent(opts: { id?: string; key?: string; name?: string }): Promise<any> {
    const args: Record<string, any> = { tool: 'antigravity' };
    if (HIVE_AGENT_ROLES) args.roles = HIVE_AGENT_ROLES;
    if (opts.id) args.id = opts.id;
    if (opts.key) args.key = opts.key;
    if (opts.name) args.name = opts.name;
    let result: any;
    try {
      result = await hiveCallTool('hive_start', args);
    } catch (err: any) {
      const msg = String(err?.message || err);
      if (opts.key && /key|invalid params|unknown|validation|unrecognized/i.test(msg)) {
        console.error(`[agy-channel] server rejected key param, falling back to name-only: ${msg}`);
        delete args.key;
        result = await hiveCallTool('hive_start', args);
      } else {
        throw err;
      }
    }
    agentId = result.agent_id;
    agentName = result.display_name;
    // 若用户已在 Kitty 中重命名了该会话（KITTY_SESSION_ID === HIVE_AGENT_KEY 且 KITTY_SESSION_NAME 变化），
    // hive_start 的 key 路径出于防 .mcp.json 污染会忽略 name 更新，此处主动调用 hive_rename 同步。
    const kittySessionId = process.env.KITTY_SESSION_ID || '';
    const kittySessionName = process.env.KITTY_SESSION_NAME || '';
    if (
      opts.name
      && agentName !== opts.name
      && opts.key
      && kittySessionId === opts.key
      && kittySessionName === opts.name
    ) {
      try {
        await hiveCallTool('hive_rename', { as: agentId, name: opts.name });
        agentName = opts.name;
        result.display_name = opts.name;
      } catch (err) {
        console.error('[agy-channel] failed to sync Kitty session rename:', err);
      }
    }
    if (!sseStarted) {
      sseStarted = true;
      void listenSSE();
    }
    return result;
  }

  async function listenSSE(): Promise<void> {
    while (!shuttingDown) {
      try {
        if (!sessionId) {
          await initHiveSession();
          if (agentId) await hiveCallTool('hive_start', reconnectArgs());
          await refreshHiveTools(true);
        }
        const res = await fetch(HIVE_URL, {
          method: 'GET',
          headers: { 'Accept': 'text/event-stream', 'Mcp-Session-Id': sessionId! },
        });
        if (!res.ok || !res.body) {
          console.error(`[agy-channel] SSE connect failed: ${res.status}, re-registering...`);
          try {
            await initHiveSession();
            if (agentId) await hiveCallTool('hive_start', reconnectArgs());
            await refreshHiveTools(true);
          } catch (e) {
            console.error('[agy-channel] re-register failed:', e);
          }
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }

        console.error('[agy-channel] SSE stream connected');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!shuttingDown) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            try {
              const data = JSON.parse(line.slice(5));
              if (data.method !== 'notifications/message' || !data.params?.data) continue;
              const raw = String(data.params.data);
              let parsed: any;
              try { parsed = JSON.parse(raw); } catch { parsed = { type: 'message', preview: raw }; }
              bridge.pushEvent(parsed, raw);
            } catch {
              // 忽略单行解析异常，保持 SSE 不断
            }
          }
        }
      } catch (err) {
        if (!shuttingDown) console.error('[agy-channel] SSE error, reconnecting...', err);
      }
      if (!shuttingDown) await new Promise((r) => setTimeout(r, 2000));
    }
  }

  mcp.setRequestHandler(ListToolsRequestSchema, async () => {
    if (cachedHiveTools.length === 0) await refreshHiveTools(false);
    const tools: MCPTool[] = [WHOAMI_TOOL];
    for (const t of cachedHiveTools) {
      if (t.name === 'hive_whoami') continue;
      tools.push({
        name: hiveToKebab(t.name),
        description: t.description,
        inputSchema: stripAsParam(t.inputSchema),
      });
    }
    return { tools };
  });

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name } = req.params;
    const args = (req.params.arguments || {}) as Record<string, any>;

    if (name === 'hive-whoami') {
      if (!agentName) {
        if (!args.name) {
          return {
            content: [{ type: 'text', text: 'Not registered. Provide a "name" parameter to register.' }],
            isError: true,
          };
        }
        await registerAgent({ name: String(args.name) });
        await refreshHiveTools(false);
      }
      const status = bridge.state.getStatus();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            agent_id: agentId,
            agent_name: agentName,
            tool: 'antigravity',
            hive_url: HIVE_URL,
            session_id: sessionId,
            conversation_id: status.conversationId,
            relay_connected: status.relayConnected,
            pending_pushes: status.pendingCount,
            bridge_socket: SOCKET_PATH,
          }, null, 2),
        }],
      };
    }

    if (!agentName) {
      return {
        content: [{ type: 'text', text: 'Not registered. Call hive-whoami(name=<your-agent-name>) first.' }],
        isError: true,
      };
    }

    if (!name.startsWith('hive-')) throw new Error(`Unknown tool: ${name}`);
    const hiveName = kebabToHive(name);
    const result = await hiveCallTool(hiveName, { as: agentId, ...args });
    return {
      content: [{
        type: 'text',
        text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
      }],
    };
  });

  const cleanup = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await bridge.close();
    process.exit(0);
  };
  process.once('SIGINT', () => { void cleanup(); });
  process.once('SIGTERM', () => { void cleanup(); });
  process.stdin.once('close', () => { void cleanup(); });

  await mcp.connect(new StdioServerTransport());

  // 后台连入 hive，避免 hive 尚未启动时阻塞 MCP stdio 握手
  void (async () => {
    while (!shuttingDown) {
      try {
        await initHiveSession();
        await refreshHiveTools(false);
        if (HIVE_AGENT_ID || HIVE_AGENT_KEY || HIVE_AGENT_NAME) {
          await registerAgent({
            id: HIVE_AGENT_ID || undefined,
            key: HIVE_AGENT_KEY || undefined,
            name: HIVE_AGENT_NAME || undefined,
          });
          console.error(`[agy-channel] connected as "${agentName}" (${agentId})`);
        } else {
          console.error('[agy-channel] connected (no env identity — register via hive-whoami)');
        }
        return;
      } catch (err) {
        console.error('[agy-channel] hive not ready, retrying in 3s...', err);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  })();

  await new Promise(() => { /* 由信号或 stdin 关闭触发退出 */ });
}
