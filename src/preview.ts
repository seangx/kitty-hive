// Builds a 2-paragraph preview for DMs: the truncated content itself, then
// an explicit `[hive note]` block telling the receiving agent how to fetch
// the full message and any attachments.
//
// Putting the instructions in a separate, clearly-marked paragraph (vs a
// dangling suffix) makes it much harder for the receiver to skim past and
// act on incomplete content.

export const CHANNEL_PREVIEW_LEN = 200;
export const INBOX_PREVIEW_LEN = 2000;

export interface AttachmentMeta {
  file_id: string;
  filename: string;
  mime?: string;
  size?: number;
}

function fmtSize(bytes?: number): string {
  if (bytes == null) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export interface BuildPreviewOpts {
  content: string;
  messageId: number;
  attachments?: AttachmentMeta[];
  /** Max characters of `content` to keep in paragraph 1. */
  maxLen?: number;
}

/**
 * Returns the user-facing preview string. If the message fits in `maxLen` and
 * has no attachments, the original content is returned verbatim. Otherwise the
 * output is two paragraphs separated by a blank line:
 *
 *   <head: maxLen chars of content, OR "[N attachment(s) — no inline text]">
 *
 *   [hive note] This is a preview, not the full message.
 *   - Full text: hive-dm-read({ message_id: N })
 *   - Attachment(s) — call hive-file-fetch({ file_id }) on each before acting:
 *     • filename (size) — file_id: <id>
 */
export function buildDMPreview(opts: BuildPreviewOpts): { preview: string; truncated: boolean } {
  const { content, messageId, attachments = [], maxLen = CHANNEL_PREVIEW_LEN } = opts;
  const truncated = content.length > maxLen;
  const hasAttach = attachments.length > 0;

  if (!truncated && !hasAttach) {
    return { preview: content, truncated: false };
  }

  const head = truncated ? content.slice(0, maxLen) : content;
  const lines: string[] = [];

  if (head.length > 0) {
    lines.push(head);
  } else {
    lines.push(`[${attachments.length} attachment(s) — no inline text]`);
  }

  lines.push('');
  lines.push('[hive note] This is a preview, not the full message. Do not act on the content above until you have fetched the parts listed below.');

  if (truncated) {
    lines.push(`- Full text: hive-dm-read({ message_id: ${messageId} })`);
  }
  if (hasAttach) {
    lines.push(`- Attachment(s) — call hive-file-fetch({ file_id }) on each before acting:`);
    for (const a of attachments) {
      lines.push(`  • ${a.filename} (${fmtSize(a.size)}) — file_id: ${a.file_id}`);
    }
  }

  return { preview: lines.join('\n'), truncated };
}

// --- Channel push payloads ---
//
// Push notifications carry NO body — only a stable event_id + enough context
// for the receiver to fetch the full record themselves. This eliminates the
// "receiver acts on truncated preview" class of bugs (v0.5.5 tried to fix
// this by appending a `[hive note]` to the preview; v0.6.0 goes further and
// drops the preview entirely).

export interface PushPayloadInput {
  /** Event type: 'dm' | 'team-message' | 'join' | 'leave' | 'rename' |
   *  'task-assigned' | 'task-claimed' | 'task-propose' | 'step-start' |
   *  'step-complete' | 'awaiting_approval' | 'step-approve' |
   *  'task-reject' | 'task-cancel' | 'task-complete' */
  type: string;
  /** Sender display_name, e.g. for UI labels. */
  from: string;
  from_agent_id: string;
  /** Globally-unique event id. Used for dedup AND as the payload's stable
   *  identity. Format conventions:
   *    - DM:   `dm:<message_id>`
   *    - Task: `task-ev:<task_events.id>`
   *    - Team: `team-ev:<team_events.id>`
   *    - Synth (no DB row, e.g. task-assigned):  `task:<task_id>:<type>:<ts>` */
  event_id: string;
  message_id?: number;
  task_id?: string;
  team_id?: string;
  attachments_count?: number;
  /** Optional rejection/cancel reason (exposed so the receiver can see why
   *  without a round-trip; it's already a short field by convention). */
  reason?: string;
}

export function buildPushMessage(p: PushPayloadInput): string {
  const fromLabel = p.from ? ` from ${p.from}` : '';
  let preview: string;
  if (p.type === 'dm') {
    const att = p.attachments_count
      ? ` (${p.attachments_count} attachment${p.attachments_count > 1 ? 's' : ''})`
      : '';
    preview = `[hive] DM${fromLabel}${att} — call hive-dm-read({ message_id: ${p.message_id} }) for full content.`;
  } else if (p.task_id) {
    const reasonLabel = p.reason ? ` — reason: ${p.reason}` : '';
    preview = `[hive] ${p.type}${fromLabel} on task ${p.task_id}${reasonLabel} — call hive-check({ task_id: "${p.task_id}" }) for full state.`;
  } else if (p.team_id) {
    preview = `[hive] ${p.type}${fromLabel} in team ${p.team_id} — call hive-team-events({ team_id: "${p.team_id}" }) for details.`;
  } else {
    preview = `[hive] ${p.type}${fromLabel}`;
  }
  return JSON.stringify({
    type: p.type,
    from: p.from,
    from_agent_id: p.from_agent_id,
    event_id: p.event_id,
    message_id: p.message_id,
    task_id: p.task_id,
    team_id: p.team_id,
    reason: p.reason,
    preview,
  });
}
