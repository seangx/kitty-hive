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
