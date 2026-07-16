import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { handleDMAsync } from '../tools/dm.js';
import { asParam, authError, resolveAgent } from '../auth.js';
import { notifyAgents } from '../sessions.js';
import { getUnreadForAgent, setReadCursor } from '../db.js';
import { getFilePath, getFileMeta } from '../files.js';
import { buildDMPreview, CHANNEL_PREVIEW_LEN, buildPushMessage } from '../preview.js';
import * as db from '../db.js';

export function registerDMTools(mcp: McpServer) {
  mcp.tool(
    'hive_dm',
    'Send a direct message to another agent. `to` accepts agent id, team-nickname (within your teams), display_name (only if unambiguous), or "id@node" for federation. ' +
    'File-sharing — pick the cheaper of two: ' +
    '(1) Same machine + receiver can read your filesystem (most common case for two local agents in the same project): just mention the absolute path inside `content`. Receiver opens it directly — zero copy, no DB bloat, the file stays live with your edits. ' +
    '(2) Cross-machine (target ends in `@node` for federation), or receiver runs in a sandbox / container / different cwd that cannot reach your path, or the file is binary (screenshot, PDF, CSV, log, paste-buffer temp file): pass `attach: [absolute path on YOUR disk]`. Hive copies the bytes into storage (replicating across federation as needed), receiver gets a `file_id` to fetch via `hive_file_fetch`. ' +
    'When in doubt about receiver reachability, default to `attach`.',
    {
      as: asParam,
      to: z.string().describe('Target: agent id, team-nickname, display_name, or "id@node"'),
      content: z.string().describe('Message text. Inline an absolute path here when sender+receiver share a filesystem and the receiver can read it (same-machine same-project is the common case); otherwise use `attach`.'),
      attach: z.array(z.string()).optional().describe('Absolute paths on YOUR machine; bytes are copied into hive and referenced by file_id on the receiver side. Use for cross-machine sends, binary blobs, or anything the receiver cannot read at its own path.'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = await handleDMAsync(agent.id, params);
      if (!result.federated) {
        await notifyAgents([result.to_agent_id], agent.id, buildPushMessage({
          type: 'dm',
          from: agent.display_name,
          from_agent_id: agent.id,
          event_id: `dm:${result.message_id}`,
          message_id: result.message_id,
          attachments_count: (result.attachments || []).length,
        }));
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive_dm_read',
    'Fetch a single DM in full by message_id. Use whenever a preview contains a `[hive note]` paragraph mentioning hive-dm-read — the visible text is only the first 200/2000 characters. Returns the full content, attachments, sender, and timestamp. ' +
    'When YOU are the recipient, this also marks the message as read (read-up-to: older messages from the same sender count as read too, same semantics as hive_inbox), so unread counts stay accurate without a separate inbox call.',
    {
      as: asParam,
      message_id: z.number().describe('Message id — the integer N from the truncation hint, from `message_id` in hive-inbox latest entries, or from the `message_id` meta field on channel notifications'),
    },
    async (params, extra) => {
      const msg = db.getDMById(params.message_id);
      if (!msg) return { content: [{ type: 'text', text: JSON.stringify({ error: `Message not found: ${params.message_id}` }) }], isError: true };
      const sender = db.getAgentById(msg.from_agent_id);
      let attachments: any[] = [];
      try { attachments = JSON.parse(msg.attachments || '[]'); } catch { /* ignore */ }

      // Advance the recipient's per-sender read cursor (forward-only) so
      // reading via dm_read doesn't leave a stale unread count that only
      // hive_inbox could clear (reported by 管家, DM #1978 side note).
      // Only the RECIPIENT's cursor moves — a sender re-reading their own
      // sent message, or a third party fetching by id, changes nothing.
      let markedRead = false;
      const reader = resolveAgent(extra, params.as);
      if (reader && reader.id === msg.to_agent_id) {
        const cursor = db.getReadCursor(reader.id, 'dm', msg.from_agent_id);
        if (msg.id > cursor) setReadCursor(reader.id, 'dm', msg.from_agent_id, msg.id);
        markedRead = true;
      }

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
            marked_read: markedRead,
          }),
        }],
      };
    },
  );

  mcp.tool(
    'hive_file_fetch',
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
    'hive_inbox',
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
