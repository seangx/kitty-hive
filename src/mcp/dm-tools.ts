import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { handleDMAsync } from '../tools/dm.js';
import { asParam, authError, resolveAgent } from '../auth.js';
import { notifyAgents } from '../sessions.js';
import { getUnreadForAgent, setReadCursor } from '../db.js';
import { getFilePath, getFileMeta } from '../files.js';
import * as db from '../db.js';

export function registerDMTools(mcp: McpServer) {
  mcp.tool(
    'hive.dm',
    'Send a direct message to another agent. `to` accepts agent id, or a nickname/display_name unambiguous within your teams. Use "id@node" for federation. `attach` accepts an array of local file paths (images, screenshots, PDFs, etc.) — the file binary is copied into hive storage and referenced by file_id; receivers fetch via hive.file.fetch.',
    {
      as: asParam,
      to: z.string().describe('Target: agent id, team-nickname, display_name, or "id@node"'),
      content: z.string().describe('Message text (may be empty if only sending attachments)'),
      attach: z.array(z.string()).optional().describe('Local file paths to attach (e.g. screenshots, PDFs, csv)'),
    },
    async (params, extra) => {
      const agent = resolveAgent(extra, params.as);
      if (!agent) return authError();
      const result = await handleDMAsync(agent.id, params);
      if (!result.federated) {
        const previewBase = params.content || (result.attachments && result.attachments.length > 0 ? `[${result.attachments.length} attachment(s)]` : '');
        const preview = previewBase.length > 200 ? previewBase.slice(0, 200) + ' [summary]' : previewBase;
        await notifyAgents([result.to_agent_id], agent.id, JSON.stringify({
          type: 'dm', from_agent_id: agent.id, from: agent.display_name, preview,
          attachments: result.attachments || [],
        }));
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  mcp.tool(
    'hive.file.fetch',
    'Fetch an attachment by file_id. Returns the local path inside hive storage; optionally copy to a destination path.',
    {
      file_id: z.string().describe('Attachment file_id (from a DM\'s attachments list)'),
      save_to: z.string().optional().describe('Destination path. If a directory, the original filename is preserved.'),
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
