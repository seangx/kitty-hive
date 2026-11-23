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

function evaluatePreToolUse(input) {
  const tc = input.toolCall || {};
  const name = tc.name || '';
  const args = tc.args || {};

  // 1. 自动放行 kitty-hive 的 MCP 工具调用，防止后台唤醒后卡在权限确认弹窗
  if (name === 'call_mcp_tool') {
    const serverName = String(args.ServerName || '');
    if (serverName === 'kitty-hive_hive-channel' || serverName === 'hive-channel') {
      return { decision: 'allow' };
    }
  }

  // 2. 自动放行启动后台推送守护进程 `kitty-hive agy-relay`
  if (name === 'run_command') {
    const cmd = String(args.CommandLine || '').trim();
    if (cmd === 'kitty-hive agy-relay') {
      return { decision: 'allow' };
    }
  }

  // 3. 自动放行读取 kitty-hive 插件自身的 MCP 工具 schema 与规则文件（位于工作区外的 ~/.gemini 下）
  if (name === 'read_file') {
    const p = String(args.Path || '').replace(/\\/g, '/');
    if (
      p.includes('/mcp/kitty-hive_hive-channel/')
      || p.includes('/.gemini/config/plugins/kitty-hive/')
    ) {
      return { decision: 'allow' };
    }
  }

  return { decision: 'ask' };
}

const RELAY_AUTOSTART_NOTICE =
  '[kitty-hive] Real-time push relay is not running for this agy process yet. ' +
  'In this turn, call run_command({ CommandLine: "kitty-hive agy-relay", WaitMsBeforeAsync: 5000 }) ' +
  '(auto-approved, detaches in <50ms with no background task bar) so incoming hive messages can wake this session while idle.';

async function main() {
  const input = readStdinJson();
  const event = input.hookEventName || '';

  if (event === 'PreToolUse') {
    process.stdout.write(JSON.stringify(evaluatePreToolUse(input)) + '\n');
    return;
  }

  const conversationId = input.conversationId || process.env.ANTIGRAVITY_CONVERSATION_ID || '';
  const socketPath = process.env.HIVE_AGY_BRIDGE_SOCKET || join(tmpdir(), `kitty-hive-agy-${process.ppid}.sock`);

  const res = await queryBridge(socketPath, {
    type: 'hook',
    event,
    conversationId,
    continuationActive: Boolean(input.continuationActive),
    cwd: input.cwd || '',
  });

  if (!res || !res.ok) {
    process.stdout.write('{}\n');
    return;
  }

  if (event === 'PreInvocation') {
    const parts = [];
    if (res.remindRelayStart) parts.push(RELAY_AUTOSTART_NOTICE);
    if (res.block) parts.push(res.block);
    if (parts.length === 0) {
      process.stdout.write('{}\n');
      return;
    }
    process.stdout.write(JSON.stringify({
      injectSteps: [
        {
          systemMessage: {
            systemMessage: parts.join('\n\n'),
          },
        },
      ],
    }) + '\n');
    return;
  }

  if (event === 'Stop' && res.block) {
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
