#!/usr/bin/env node
/**
 * Antigravity 生命周期钩子脚本（零外部依赖，确保低延迟启动与 fail-open）。
 *
 * 作用：
 * 1. SessionStart / PreInvocation / Stop 时向同 agy 进程的 agy-channel 同步最新 conversationId
 *    （天然支持 /clear 与 /resume 切换会话）；
 * 2. 若 agy-relay 离线或消息暂未送达，通过 PreInvocation（systemMessage）或 Stop（continue）
 *    将待处理的 kitty-hive 推送兜底注入当前对话。
 */

import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function readStdinJson() {
  try {
    const raw = readFileSync(0, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function queryBridge(socketPath, payload, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    const socket = createConnection(socketPath);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      finish(null);
    }, timeoutMs);

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(JSON.stringify(payload) + '\n');
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        clearTimeout(timer);
        const line = buffer.slice(0, idx).trim();
        socket.end();
        try {
          finish(JSON.parse(line));
        } catch {
          finish(null);
        }
      }
    });
    socket.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      finish(null);
    });
  });
}

async function main() {
  const input = readStdinJson();
  const event = input.hookEventName || '';
  const conversationId = input.conversationId || process.env.ANTIGRAVITY_CONVERSATION_ID || '';
  const socketPath = process.env.HIVE_AGY_BRIDGE_SOCKET || join(tmpdir(), `kitty-hive-agy-${process.ppid}.sock`);

  const res = await queryBridge(socketPath, {
    type: 'hook',
    event,
    conversationId,
    continuationActive: Boolean(input.continuationActive),
    cwd: input.cwd || '',
  });

  if (!res || !res.ok || !res.block) {
    process.stdout.write('{}\n');
    return;
  }

  if (event === 'PreInvocation') {
    process.stdout.write(JSON.stringify({
      injectSteps: [
        {
          systemMessage: {
            systemMessage: res.block,
          },
        },
      ],
    }) + '\n');
    return;
  }

  if (event === 'Stop') {
    process.stdout.write(JSON.stringify({
      decision: 'continue',
      reason: res.block,
    }) + '\n');
    return;
  }

  process.stdout.write('{}\n');
}

main().catch(() => {
  process.stdout.write('{}\n');
});
