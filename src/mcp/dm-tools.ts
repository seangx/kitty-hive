import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { handleDMAsync } from '../tools/dm.js';
import { asParam, authError, resolveAgent } from '../auth.js';
import { notifyAgents } from '../sessions.js';
import { getUnreadForAgent, setReadCursor } from '../db.js';
import { getFilePath, getFileMeta } from '../files.js';
import { buildDMPreview, CHANNEL_PREVIEW_LEN } from '../preview.js';
import * as db from '../db.js';

export function registerDMTools(mcp: McpServer) {
  mcp.tool(
    'hive.dm',
    'Send a direct message to another agent. `to` accepts agent id, team-nickname (within your teams), display_name (only if unambiguous), or "id@node" for federation. ' +
    'IMPORTANT: any file path you mention in `content` is local-to-YOUR-machine ONLY — the receiver cannot read it (they may be on a different OS). ' +
    'To actually share a file, pass `attach: [absolute path on YOUR disk]`; hive copies the bytes into storage (replicating across federation if needed) and the receiver gets a `file_id` they fetch via `hive.file.fetch`. ' +
    'Use `attach` for screenshots, PDFs, CSVs, logs, pasted-image temp files, anything binary.',
    {
      as: asParam,
      to: z.string().describe('Target: agent id, team-nickname, display_name, or "id@node"'),
      content: z.string().describe('Message text. NEVER put a local file path here expecting the receiver to read it — use `attach` instead.'),
      attach: z.array(z.string()).optional().describe('Absolute paths on YOUR machine; bytes are copied into hive and referenced by file_id on the receiver side.'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = await handleDMAsync(agent.id, params);
      if (!result.federated) {
        const { preview } = buildDMPreview({
          content: params.content || '',
          messageId: result.message_id,
          attachments: result.attachments || [],
          maxLen: CHANNEL_PREVIEW_LEN,
        });
        await notifyAgents([result.to_agent_id], agent.id, JSON.stringify({
          type: 'dm', from_agent_id: agent.id, from: agent.display_name,
          message_id: result.message_id, preview,
          attachments: result.attachments || [],
        }));
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive.dm.read',
    'Fetch a single DM in full by message_id. Use whenever a preview contains a `[hive note]` paragraph mentioning hive-dm-read — the visible text is only the first 200/2000 characters. Returns the full content, attachments, sender, and timestamp.',
    { message_id: z.number().describe('Message id — the integer N from the truncation hint, from `message_id` in hive-inbox latest entries, or from the `message_id` meta field on channel notifications') },
    async (params) => {
      const msg = db.getDMById(params.message_id);
      if (!msg) return { content: [{ type: 'text', text: JSON.stringify({ error: `Message not found: ${params.message_id}` }) }], isError: true };
      const sender = db.getAgentById(msg.from_agent_id);
      let attachments: any[] = [];
      try { attachments = JSON.parse(msg.attachments || '[]'); } catch { /* ignore */ }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            message_id: msg.id,
            from_agent_id: msg.from_agent_id,
            from_display_name: sender?.display_name ?? 'unknown',
            to_agent_id: msg.to_agent_id,
            content: msg.content,
            attachments,
            ts: msg.ts,
          }),
        }],
      };
    },
  );

  mcp.tool(
    'hive.file.fetch',
    'Fetch an attachment by file_id (from a DM you received). Returns a `path` on the hive node serving you (your local hive when running locally; the receiver\'s hive in federated setups — already replicated). Pass `save_to` to copy it to a path of your choice (a trailing "/" treats it as a directory and keeps the original filename).',
    {
      file_id: z.string().describe('Attachment file_id (from hive-inbox latest entry attachments, or from a channel notification)'),
      save_to: z.string().optional().describe('Optional destination path; pass a trailing "/" to copy into a directory keeping the original filename.'),
    },
    async (params) => {
      const meta = getFileMeta(params.file_id);
      if (!meta) return { content: [{ type: 'text', text: JSON.stringify({ error: `File not found: ${params.file_id}` }) }], isError: true };
      const sourcePath = getFilePath(params.file_id)!;
      let saved: string | undefined;
      if (params.save_to) {
        // If save_to ends with / or is an existing dir, append filename
        let dest = params.save_to;
        if (/[\\/]$/.test(dest)) dest = dest.replace(/[\\/]+$/, '') + '/' + meta.filename;
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(sourcePath, dest);
        saved = dest;
      }
      return { content: [{ type: 'text', text: JSON.stringify({ ...meta, path: sourcePath, saved_to: saved }) }] };
    },
  );

  mcp.tool(
    'hive.inbox',
    'Check unread DMs, team events, and task events. Marks returned items as read.',
    { as: asParam },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const unread = getUnreadForAgent(agent.id);
      // Mark as read
      for (const u of unread) {
        if (u.latest.length === 0) continue;
        if (u.type === 'team') {
          const events = db.getTeamEvents(u.id, 0, 10000);
          if (events.length > 0) setReadCursor(agent.id, 'team', u.id, events[events.length - 1].seq);
        } else if (u.type === 'task') {
          const events = db.getTaskEvents(u.id, 0, 100);
          if (events.length > 0) setReadCursor(agent.id, 'task', u.id, events[events.length - 1].seq);
        } else if (u.type === 'dm') {
          // Per-sender cursor: u.id is the sender agent_id
          const max = db.getMaxIncomingDMId(agent.id, u.id);
          if (max > 0) setReadCursor(agent.id, 'dm', u.id, max);
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify(unread.length > 0 ? unread : []) }] };
    },
  );
}
