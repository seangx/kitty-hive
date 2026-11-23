/**
 * Antigravity CLI (agy) 本地推送桥核心逻辑
 *
 * 负责在 agy-channel（MCP 服务端）、agy-hook（生命周期钩子）与 agy-relay（agentapi 推送守护进程）
 * 之间维护会话 ID 追踪、事件去重、排队与投递确认，确保：
 * 1. relay 在线时，SSE 推送实时通过 `agentapi send-message` 唤醒空闲的 agy 会话；
 * 2. relay 离线或投递失败时，未送达事件保留在队列中，由 PreInvocation / Stop hook 兜底注入；
 * 3. /clear 或 /resume 切换会话后，hook 上报新的 conversationId，后续推送自动切到新会话。
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

export interface AgyPushEvent {
  type?: string;
  from?: string;
  from_agent_id?: string;
  message_id?: number | string;
  task_id?: string;
  team_id?: string;
  event_id?: string;
  preview?: string;
  title?: string;
  reason?: string;
  replayed?: boolean;
  queued_at?: string;
}

export interface QueuedPush {
  deliveryId: string;
  dedupKey: string;
  title: string;
  content: string;
  eventType: string;
  enqueuedAt: number;
}

export interface HookBridgeRequest {
  type: 'hook';
  event: 'SessionStart' | 'PreInvocation' | 'Stop' | string;
  conversationId?: string | null;
  continuationActive?: boolean;
  cwd?: string;
}

export interface RelayHelloRequest {
  type: 'relay-hello';
  conversationId?: string | null;
  pid?: number;
}

export interface RelayPushAckRequest {
  type: 'push-ack';
  deliveryId: string;
  ok: boolean;
  error?: string;
}

export interface RelayPongRequest {
  type: 'pong';
}

export type BridgeClientMessage =
  | HookBridgeRequest
  | RelayHelloRequest
  | RelayPushAckRequest
  | RelayPongRequest;

export interface BridgePushFrame {
  type: 'push';
  deliveryId: string;
  conversationId: string;
  title: string;
  content: string;
}

export interface BridgeStatus {
  conversationId: string | null;
  relayConnected: boolean;
  pendingCount: number;
  inFlightCount: number;
}

const MAX_SEEN_KEYS = 500;
const MAX_PENDING_PUSHES = 200;

/** 根据宿主 agy 进程 PID 生成本地 Unix socket 路径，隔离多个并发终端窗口。 */
export function bridgeSocketPath(ownerPid: number, dir = tmpdir()): string {
  return join(dir, `kitty-hive-agy-${ownerPid}.sock`);
}

/** 从 socket 文件名解析宿主 PID，用于 relay 检测宿主进程是否已退出。 */
export function parseBridgeSocketPid(socketPath: string): number | null {
  const m = basename(socketPath).match(/^kitty-hive-agy-(\d+)\.sock$/);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** 生成与 channel.ts 一致的去重键，优先使用稳定的 event_id / message_id。 */
export function agyPushDedupKey(ev: AgyPushEvent, fallbackContent: string): string {
  if (ev.event_id) return `evid:${ev.event_id}`;
  if (ev.message_id != null && ev.message_id !== '') return `dm:${ev.message_id}`;
  const from = ev.from || ev.from_agent_id || 'unknown';
  return `${from}:${ev.type || 'message'}:${fallbackContent.slice(0, 60)}`;
}

/** 构造适合 agentapi send-message 与 hook 注入的清晰推送文案（保持 id-only 约定）。 */
export function formatAgyPushNotification(ev: AgyPushEvent, raw: string): { title: string; content: string } {
  const type = ev.type || 'message';
  const from = ev.from || ev.from_agent_id || 'unknown';
  const baseText = ev.preview || ev.title || raw;
  const title = `[hive] ${type} from ${from}`;

  const metaParts: string[] = [`type=${type}`, `from=${from}`];
  if (ev.from_agent_id) metaParts.push(`from_agent_id=${ev.from_agent_id}`);
  if (ev.message_id != null && ev.message_id !== '') metaParts.push(`message_id=${ev.message_id}`);
  if (ev.task_id) metaParts.push(`task_id=${ev.task_id}`);
  if (ev.team_id) metaParts.push(`team_id=${ev.team_id}`);
  if (ev.event_id) metaParts.push(`event_id=${ev.event_id}`);
  if (ev.reason) metaParts.push(`reason=${ev.reason}`);

  let fetchHint = '';
  if (!/call\s+hive[-_]/i.test(baseText)) {
    if (ev.message_id != null && ev.message_id !== '') {
      fetchHint = ` — call hive-dm-read({ message_id: ${ev.message_id} }) for full content.`;
    } else if (ev.task_id) {
      fetchHint = ` — call hive-check({ task_id: "${ev.task_id}" }) for full content.`;
    } else if (ev.team_id) {
      fetchHint = type === 'team-rules-update'
        ? ` — call hive-team-info({ team_id: "${ev.team_id}" }) for current rules.`
        : ` — call hive-team-events({ team_id: "${ev.team_id}" }) for full content.`;
    }
  }

  const lines = [
    `[kitty-hive push] (${metaParts.join(', ')})`,
    `${baseText}${fetchHint}`,
  ];
  if (ev.replayed && ev.queued_at) {
    lines.push(`(replayed queued event from ${ev.queued_at})`);
  }
  return { title, content: lines.join('\n') };
}

/** 将多条待处理推送合并为一段供 hook 注入的文本。 */
export function formatHookPushBlock(items: QueuedPush[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0].content;
  return [
    `[kitty-hive] ${items.length} pending push notification(s):`,
    ...items.map((item, idx) => `--- #${idx + 1} ---\n${item.content}`),
  ].join('\n');
}

/**
 * 纯内存状态机：管理会话 ID、去重、待投递队列与 relay 在途确认。
 * 关键不变量：发往 relay 的事件在发出前即从 pending 移入 inFlight，
 * 避免 agentapi 唤醒触发 PreInvocation hook 时重复注入同一条消息；
 * 若 relay 投递失败或断连，inFlight 会按原顺序退回 pending，交由 hook 或重连后的 relay 兜底。
 */
export class AgyBridgeState {
  private conversationId: string | null = null;
  private relayConnected = false;
  private pending: QueuedPush[] = [];
  private inFlight = new Map<string, QueuedPush>();
  private seenKeys = new Set<string>();
  private seq = 0;
  private lastStopDrainSeq = 0;

  getStatus(): BridgeStatus {
    return {
      conversationId: this.conversationId,
      relayConnected: this.relayConnected,
      pendingCount: this.pending.length,
      inFlightCount: this.inFlight.size,
    };
  }

  getConversationId(): string | null {
    return this.conversationId;
  }

  setConversationId(id: string | null | undefined, force = true): boolean {
    const clean = typeof id === 'string' ? id.trim() : '';
    if (!clean) return false;
    if (!force && this.conversationId) return false;
    const changed = this.conversationId !== clean;
    this.conversationId = clean;
    return changed;
  }

  setRelayConnected(connected: boolean): void {
    if (connected) {
      this.relayConnected = true;
      return;
    }
    this.onRelayDisconnect();
  }

  /** 收到新的 Hive SSE 事件时入队；跳过 join/leave 噪音并按 dedupKey 去重。 */
  enqueue(ev: AgyPushEvent, raw: string): QueuedPush | null {
    if (ev.type === 'join' || ev.type === 'leave') return null;
    const { title, content } = formatAgyPushNotification(ev, raw);
    const dedupKey = agyPushDedupKey(ev, content);
    if (this.seenKeys.has(dedupKey)) return null;
    this.seenKeys.add(dedupKey);
    if (this.seenKeys.size > MAX_SEEN_KEYS) {
      const oldest = this.seenKeys.values().next().value;
      if (oldest) this.seenKeys.delete(oldest);
    }

    const item: QueuedPush = {
      deliveryId: `d-${++this.seq}`,
      dedupKey,
      title,
      content,
      eventType: ev.type || 'message',
      enqueuedAt: Date.now(),
    };
    this.pending.push(item);
    if (this.pending.length > MAX_PENDING_PUSHES) {
      this.pending.shift();
    }
    return item;
  }

  /** 取出当前可发给 relay 的推送，并移入 inFlight 等待 push-ack。 */
  takeForRelay(): Array<QueuedPush & { conversationId: string }> {
    if (!this.relayConnected || !this.conversationId || this.pending.length === 0) {
      return [];
    }
    const items = this.pending.splice(0, this.pending.length);
    const convId = this.conversationId;
    for (const item of items) {
      this.inFlight.set(item.deliveryId, item);
    }
    return items.map((item) => ({ ...item, conversationId: convId }));
  }

  /** 处理 relay 的投递回执：成功则彻底移除，失败则退回 pending 队首等待兜底。 */
  ackRelay(deliveryId: string, ok: boolean): boolean {
    const item = this.inFlight.get(deliveryId);
    if (!item) return false;
    this.inFlight.delete(deliveryId);
    if (!ok) {
      this.pending.unshift(item);
      if (this.pending.length > MAX_PENDING_PUSHES) {
        this.pending.pop();
      }
    }
    return true;
  }

  /** relay 断开时，将所有未确认的在途推送按原顺序放回 pending 队首。 */
  onRelayDisconnect(): void {
    this.relayConnected = false;
    if (this.inFlight.size === 0) return;
    const restored = [...this.inFlight.values()];
    this.inFlight.clear();
    this.pending.unshift(...restored);
    if (this.pending.length > MAX_PENDING_PUSHES) {
      this.pending.splice(MAX_PENDING_PUSHES);
    }
  }

  /**
   * 供 PreInvocation / Stop hook 排空未通过 relay 送达的推送。
   * Stop hook 若处于 continuationActive 且没有新到达的事件，则不再继续阻断停止，防止死循环。
   */
  drainForHook(event: 'PreInvocation' | 'Stop', continuationActive = false): QueuedPush[] {
    if (this.pending.length === 0) return [];
    if (event === 'Stop' && continuationActive && this.seq <= this.lastStopDrainSeq) {
      return [];
    }
    const items = this.pending.splice(0, this.pending.length);
    if (event === 'Stop') {
      this.lastStopDrainSeq = this.seq;
    }
    return items;
  }
}

export interface AgyBridgeServerOptions {
  socketPath: string;
  getIdentity?: () => { agentId: string | null; agentName: string | null };
  onLog?: (msg: string) => void;
}

/**
 * 本地 Unix domain socket 服务端，运行在 agy-channel 进程内，
 * 同时服务短连接（agy-hook）与长连接（agy-relay）。
 */
export class AgyBridgeServer {
  readonly state = new AgyBridgeState();
  readonly socketPath: string;
  private readonly getIdentity: () => { agentId: string | null; agentName: string | null };
  private readonly onLog: (msg: string) => void;
  private server: NetServer | null = null;
  private relaySocket: Socket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(opts: AgyBridgeServerOptions) {
    this.socketPath = opts.socketPath;
    this.getIdentity = opts.getIdentity ?? (() => ({ agentId: null, agentName: null }));
    this.onLog = opts.onLog ?? ((msg) => console.error(`[agy-bridge] ${msg}`));
  }

  async start(): Promise<void> {
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch { /* ignore stale socket cleanup error */ }
    }
    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => this.handleConnection(socket));
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        try { chmodSync(this.socketPath, 0o600); } catch { /* ignore on platforms without chmod */ }
        this.server = server;
        resolve();
      });
    });

    this.pingTimer = setInterval(() => {
      if (this.relaySocket && !this.relaySocket.destroyed) {
        this.writeJsonLine(this.relaySocket, { type: 'ping' });
      }
    }, 30_000);
    this.pingTimer.unref();
  }

  /** 将一条 Hive SSE 事件投入桥接器，并在 relay 就绪时立即推送。 */
  pushEvent(ev: AgyPushEvent, raw: string): QueuedPush | null {
    const item = this.state.enqueue(ev, raw);
    if (!item) return null;
    this.flushRelay();
    return item;
  }

  /** 将状态机中可投递的事件立刻发送给当前在线的 relay。 */
  flushRelay(): number {
    if (!this.relaySocket || this.relaySocket.destroyed) return 0;
    const frames = this.state.takeForRelay();
    for (const f of frames) {
      const frame: BridgePushFrame = {
        type: 'push',
        deliveryId: f.deliveryId,
        conversationId: f.conversationId,
        title: f.title,
        content: f.content,
      };
      this.writeJsonLine(this.relaySocket, frame);
    }
    return frames.length;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.relaySocket && !this.relaySocket.destroyed) {
      this.relaySocket.destroy();
    }
    this.relaySocket = null;
    this.state.onRelayDisconnect();
    if (this.server) {
      const srv = this.server;
      this.server = null;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch { /* ignore */ }
    }
  }

  private handleConnection(socket: Socket): void {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) this.handleLine(socket, line);
        idx = buffer.indexOf('\n');
      }
    });
    socket.on('error', () => {
      // 忽略客户端异常断连
    });
    socket.on('close', () => {
      if (this.relaySocket === socket) {
        this.relaySocket = null;
        this.state.onRelayDisconnect();
        this.onLog('relay disconnected');
      }
    });
  }

  private handleLine(socket: Socket, line: string): void {
    let msg: BridgeClientMessage;
    try {
      msg = JSON.parse(line) as BridgeClientMessage;
    } catch {
      return;
    }

    if (msg.type === 'hook') {
      this.handleHook(socket, msg);
      return;
    }

    if (msg.type === 'relay-hello') {
      // 若已有旧 relay，平滑替换，防止双 relay 抢消息
      if (this.relaySocket && this.relaySocket !== socket && !this.relaySocket.destroyed) {
        const prev = this.relaySocket;
        this.relaySocket = null;
        this.state.onRelayDisconnect();
        prev.destroy();
      }
      this.relaySocket = socket;
      this.state.setRelayConnected(true);
      if (msg.conversationId) {
        // hook 上报的 conversationId 优先级更高（会随 /clear、/resume 更新）；
        // 仅当尚未收到 hook 时用 relay 启动时的环境变量兜底。
        this.state.setConversationId(msg.conversationId, false);
      }
      const id = this.getIdentity();
      this.writeJsonLine(socket, {
        type: 'relay-ready',
        conversationId: this.state.getConversationId(),
        agentId: id.agentId,
        agentName: id.agentName,
      });
      this.onLog(`relay connected pid=${msg.pid ?? 'unknown'} conv=${this.state.getConversationId() ?? 'pending'}`);
      this.flushRelay();
      return;
    }

    if (msg.type === 'push-ack') {
      this.state.ackRelay(msg.deliveryId, Boolean(msg.ok));
      if (!msg.ok) {
        this.onLog(`relay delivery failed id=${msg.deliveryId}: ${msg.error ?? 'unknown error'}`);
      }
      return;
    }

    if (msg.type === 'pong') {
      return;
    }
  }

  private handleHook(socket: Socket, msg: HookBridgeRequest): void {
    if (msg.conversationId) {
      const changed = this.state.setConversationId(msg.conversationId, true);
      if (changed) {
        this.onLog(`conversation updated (${msg.event}) → ${msg.conversationId}`);
      }
    }

    const id = this.getIdentity();
    const status = this.state.getStatus();

    if (msg.event === 'SessionStart') {
      // 会话刚启动拿到 conversationId 时，若 relay 已连接则顺手冲刷缓冲队列
      this.flushRelay();
      this.writeJsonLine(socket, {
        ok: true,
        pending: [],
        relayConnected: status.relayConnected,
        agentId: id.agentId,
        agentName: id.agentName,
      });
      socket.end();
      return;
    }

    if (msg.event === 'PreInvocation' || msg.event === 'Stop') {
      const pending = this.state.drainForHook(msg.event, Boolean(msg.continuationActive));
      this.writeJsonLine(socket, {
        ok: true,
        pending,
        block: formatHookPushBlock(pending),
        relayConnected: status.relayConnected,
        agentId: id.agentId,
        agentName: id.agentName,
      });
      socket.end();
      return;
    }

    this.writeJsonLine(socket, { ok: true, pending: [], relayConnected: status.relayConnected });
    socket.end();
  }

  private writeJsonLine(socket: Socket, payload: unknown): void {
    if (socket.destroyed) return;
    try {
      socket.write(JSON.stringify(payload) + '\n');
    } catch {
      // close 事件会清理状态
    }
  }
}

export interface DiscoverSocketResult {
  socketPath: string;
  ownerPid: number | null;
}

export interface DiscoverSocketOptions {
  explicitSocket?: string;
  dir?: string;
  maxDepth?: number;
  getParentPid?: (pid: number) => number | null;
  exists?: (p: string) => boolean;
}

function defaultGetParentPid(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const ppid = Number(out);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}

/**
 * 供 agy-relay 定位当前 agy 会话对应的 agy-channel Unix socket：
 * 优先级：显式参数/环境变量 > 沿祖先进程链向上匹配 `kitty-hive-agy-<pid>.sock`。
 */
export function discoverBridgeSocket(
  startPid = process.pid,
  opts: DiscoverSocketOptions = {},
): DiscoverSocketResult | null {
  const exists = opts.exists ?? existsSync;
  const explicit = opts.explicitSocket || process.env.HIVE_AGY_BRIDGE_SOCKET || '';
  if (explicit) {
    if (!exists(explicit)) return null;
    return { socketPath: explicit, ownerPid: parseBridgeSocketPid(explicit) };
  }

  const dir = opts.dir ?? tmpdir();
  const maxDepth = opts.maxDepth ?? 12;
  const getParentPid = opts.getParentPid ?? defaultGetParentPid;

  let cur: number | null = startPid;
  const visited = new Set<number>();
  for (let i = 0; i < maxDepth && cur && cur > 1; i++) {
    if (visited.has(cur)) break;
    visited.add(cur);
    const candidate = bridgeSocketPath(cur, dir);
    if (exists(candidate)) {
      return { socketPath: candidate, ownerPid: cur };
    }
    cur = getParentPid(cur);
  }
  return null;
}

/** 检查进程是否仍存活（用于 relay 判断宿主 agy 退出后自行退出，避免孤儿进程）。 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}
