/**
 * Antigravity CLI (agy) 实时推送中继守护进程
 *
 * 运行方式：在 agy 会话中通过 run_command(IsDaemon=true, BypassSandbox=true) 启动 `kitty-hive agy-relay`。
 *
 * 工作原理：
 * 1. 自动沿祖先进程链查找同 agy 进程下 `agy-channel` 监听的 Unix domain socket（也可通过 `--socket` 指定）；
 * 2. 建立长连接，接收来自 kitty-hive 的实时推送帧；
 * 3. 调用 Antigravity 官方 `agentapi send-message` 将消息注入目标 conversationId（唤醒空闲会话或自动排队）；
 * 4. 向 agy-channel 回传 `push-ack`；当宿主 agy 进程退出时自动退出，不留孤儿进程。
 */

import { execFile, spawn } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { basename } from 'node:path';
import { discoverBridgeSocket, isPidAlive, type BridgePushFrame } from './agy-bridge.js';

export type AgentApiSender = (input: {
  conversationId: string;
  title: string;
  content: string;
}) => Promise<void>;

export interface AgyRelayOptions {
  socketPath?: string;
  conversationId?: string;
  sender?: AgentApiSender;
  onLog?: (msg: string) => void;
  /** 仅用于测试：限制最大启动发现等待时间（毫秒）。 */
  discoveryTimeoutMs?: number;
  /** 可选取消信号，便于单测优雅关闭中继循环。 */
  signal?: AbortSignal;
}

/**
 * 解析 agentapi 调用方式：
 * Antigravity 注入的 ANTIGRAVITY_AGENTAPI_EXE 指向主二进制 `antigravity`（需要带 `agentapi` 子命令），
 * 而 PATH 中的 `agentapi` 包装脚本或测试 stub 则直接接受 `send-message`。
 */
export function resolveAgentApiInvocation(
  envExe = process.env.ANTIGRAVITY_AGENTAPI_EXE,
): { bin: string; prefixArgs: string[] } {
  const bin = envExe || 'agentapi';
  const base = basename(bin).toLowerCase();
  const needsSubcommand = !base.includes('agentapi');
  return {
    bin,
    prefixArgs: needsSubcommand ? ['agentapi'] : [],
  };
}

/** 默认发送器：调用 Antigravity 注入到环境中的官方 `agentapi send-message`。 */
export function createDefaultAgentApiSender(): AgentApiSender {
  return ({ conversationId, title, content }) =>
    new Promise<void>((resolve, reject) => {
      const { bin, prefixArgs } = resolveAgentApiInvocation();
      execFile(
        bin,
        [...prefixArgs, 'send-message', '--title', title, conversationId, content],
        { timeout: 15_000 },
        (err, _stdout, stderr) => {
          if (err) {
            const detail = String(stderr || err.message || err).trim();
            reject(new Error(`agentapi send-message failed: ${detail}`));
            return;
          }
          resolve();
        },
      );
    });
}

function parseRelayCliArgs(argv: string[]): {
  socketPath?: string;
  conversationId?: string;
  foreground: boolean;
} {
  let socketPath: string | undefined;
  let conversationId: string | undefined;
  let foreground = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--socket' && argv[i + 1]) {
      socketPath = argv[++i];
    } else if (argv[i] === '--conversation' && argv[i + 1]) {
      conversationId = argv[++i];
    } else if (argv[i] === '--foreground' || argv[i] === '-f') {
      foreground = true;
    }
  }
  return { socketPath, conversationId, foreground };
}

export async function runAgyRelay(argv: string[] = [], opts: AgyRelayOptions = {}): Promise<void> {
  const parsed = parseRelayCliArgs(argv);
  const explicitSocket = opts.socketPath ?? parsed.socketPath ?? process.env.HIVE_AGY_BRIDGE_SOCKET;
  const initialConvId = opts.conversationId ?? parsed.conversationId ?? process.env.ANTIGRAVITY_CONVERSATION_ID ?? null;
  const sender = opts.sender ?? createDefaultAgentApiSender();
  const onLog = opts.onLog ?? ((msg) => console.error(`[agy-relay] ${msg}`));
  const discoveryTimeoutMs = opts.discoveryTimeoutMs ?? 30_000;

  let shuttingDown = false;
  let activeSocket: Socket | null = null;
  let ownerPid: number | null = null;
  let sendChain: Promise<void> = Promise.resolve();

  const stop = (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    onLog(`shutting down (${reason})`);
    if (activeSocket && !activeSocket.destroyed) activeSocket.destroy();
  };

  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
  if (opts.signal) {
    if (opts.signal.aborted) stop('signal');
    else opts.signal.addEventListener('abort', () => stop('signal'), { once: true });
  }

  // 定期检测宿主 agy 进程是否存活，防止极端情况下残留孤儿进程
  const ownerCheck = setInterval(() => {
    if (ownerPid && !isPidAlive(ownerPid)) {
      stop(`owner pid ${ownerPid} exited`);
      clearInterval(ownerCheck);
    }
  }, 10_000);
  ownerCheck.unref();

  let discovered = discoverBridgeSocket(process.pid, { explicitSocket });
  const discoveryDeadline = Date.now() + discoveryTimeoutMs;
  while (!discovered && !shuttingDown && Date.now() < discoveryDeadline) {
    await new Promise((r) => setTimeout(r, 500));
    discovered = discoverBridgeSocket(process.pid, { explicitSocket });
  }

  if (shuttingDown) return;
  if (!discovered) {
    throw new Error(
      'Could not find kitty-hive agy-channel bridge socket in ancestor processes. ' +
      'Make sure the kitty-hive Antigravity plugin (agy-channel) is active in this agy session.',
    );
  }

  ownerPid = discovered.ownerPid;
  const socketPath = discovered.socketPath;

  // CLI 默认自后台化（detached）：在父进程完成祖先 PID socket 发现后，
  // 将 --socket 显式传给脱离后台的子进程并立即退出，避免在 agy 界面一直挂着黄色 running 任务条。
  const runInForeground =
    parsed.foreground || Boolean(opts.sender) || Boolean(opts.signal) || Boolean(opts.socketPath);
  if (!runInForeground) {
    const childArgs = [process.argv[1], 'agy-relay', '--foreground', '--socket', socketPath];
    if (initialConvId) childArgs.push('--conversation', initialConvId);
    const child = spawn(process.execPath, childArgs, {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    onLog(`started background relay pid=${child.pid} socket=${socketPath} ownerPid=${ownerPid ?? 'explicit'}`);
    return;
  }

  onLog(`discovered bridge socket=${socketPath} ownerPid=${ownerPid ?? 'explicit'}`);

  let backoffMs = 500;
  while (!shuttingDown) {
    if (ownerPid && !isPidAlive(ownerPid)) {
      onLog(`owner pid ${ownerPid} is gone; exiting`);
      break;
    }

    await new Promise<void>((resolve) => {
      const socket = createConnection(socketPath);
      activeSocket = socket;
      socket.setEncoding('utf8');
      let buffer = '';

      const writeJson = (obj: unknown) => {
        if (socket.destroyed) return;
        try { socket.write(JSON.stringify(obj) + '\n'); } catch { /* ignore */ }
      };

      socket.on('connect', () => {
        backoffMs = 500;
        writeJson({
          type: 'relay-hello',
          conversationId: initialConvId,
          pid: process.pid,
        });
      });

      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let idx = buffer.indexOf('\n');
        while (idx !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) handleServerLine(line, writeJson);
          idx = buffer.indexOf('\n');
        }
      });

      socket.on('error', (err: any) => {
        if (!shuttingDown) onLog(`socket error: ${err?.code || err?.message || err}`);
      });

      socket.on('close', () => {
        if (activeSocket === socket) activeSocket = null;
        resolve();
      });
    });

    if (shuttingDown) break;
    if (ownerPid && !isPidAlive(ownerPid)) break;
    await new Promise((r) => setTimeout(r, backoffMs));
    backoffMs = Math.min(3000, backoffMs * 2);
  }

  clearInterval(ownerCheck);

  function handleServerLine(line: string, writeJson: (obj: unknown) => void): void {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }

    if (msg.type === 'relay-ready') {
      onLog(`connected to agy-channel agent=${msg.agentName ?? 'unregistered'} conv=${msg.conversationId ?? 'pending'}`);
      return;
    }

    if (msg.type === 'ping') {
      writeJson({ type: 'pong' });
      return;
    }

    if (msg.type === 'push') {
      const frame = msg as BridgePushFrame;
      // 串行投递保证推送顺序，不让并发 send-message 打乱消息次序
      sendChain = sendChain.then(async () => {
        try {
          await sender({
            conversationId: frame.conversationId,
            title: frame.title,
            content: frame.content,
          });
          onLog(`delivered push id=${frame.deliveryId} → conv=${frame.conversationId}`);
          writeJson({ type: 'push-ack', deliveryId: frame.deliveryId, ok: true });
        } catch (err: any) {
          const errMsg = String(err?.message || err);
          onLog(`failed push id=${frame.deliveryId}: ${errMsg}`);
          writeJson({ type: 'push-ack', deliveryId: frame.deliveryId, ok: false, error: errMsg });
        }
      });
    }
  }
}
