import { getAgentById, appendDM, resolveAddressee, getPeerByName } from '../db.js';
import { storeFileFromPath, readFileBinary } from '../files.js';
import type { FileAttachment } from '../models.js';

interface DMInput {
  to: string;
  content: string;
  attach?: string[];   // local file paths
}

interface DMOutput {
  to_agent_id: string;
  message_id: number;
  seq: number;
  federated?: boolean;
  attachments?: FileAttachment[];
}

// Parse "agent_id_or_nickname@node" → { target, node }
function parseTarget(to: string): { target: string; node?: string } {
  const at = to.lastIndexOf('@');
  if (at > 0) return { target: to.slice(0, at), node: to.slice(at + 1) };
  return { target: to };
}

// Push each local attachment binary to peer via /federation/file, return peer's file metadata.
async function uploadAttachmentsToPeer(
  attachments: FileAttachment[], peer: { url: string; secret: string; name: string },
): Promise<FileAttachment[]> {
  const remote: FileAttachment[] = [];
  for (const att of attachments) {
    const bin = readFileBinary(att.file_id);
    if (!bin) continue;
    const res = await fetch(peer.url.replace('/mcp', '/federation/file'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Authorization': `Bearer ${peer.secret}`,
        'X-Hive-Peer': peer.name,
        'X-Filename': encodeURIComponent(bin.filename),
      },
      body: new Uint8Array(bin.data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(`Federation file upload failed: ${(err as any).error || res.statusText}`);
    }
    const { file_id } = await res.json() as { file_id: string };
    remote.push({ file_id, filename: att.filename, mime: att.mime, size: att.size });
  }
  return remote;
}

async function sendFederatedDM(
  fromAgentId: string, fromDisplayName: string,
  toRemoteId: string, peerName: string, content: string,
  attachments: FileAttachment[] = [],
): Promise<DMOutput> {
  const peer = getPeerByName(peerName);
  if (!peer) throw new Error(`Peer "${peerName}" not found. Add it with: kitty-hive peer add ${peerName} <url>`);

  const remoteAttachments = attachments.length > 0
    ? await uploadAttachmentsToPeer(attachments, peer)
    : [];

  const res = await fetch(peer.url.replace('/mcp', '/federation/dm'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${peer.secret}`,
      'X-Hive-Peer': peerName,
    },
    body: JSON.stringify({
      from_agent_id: fromAgentId,
      from_display_name: fromDisplayName,
      to: toRemoteId,
      content,
      attachments: remoteAttachments,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`Federation DM failed: ${(err as any).error || res.statusText}`);
  }

  const result = await res.json() as { delivered: boolean; message_id: number; seq: number };
  return {
    to_agent_id: `${toRemoteId}@${peerName}`,
    message_id: result.message_id, seq: result.seq, federated: true,
    attachments: remoteAttachments,
  };
}

function ingestAttachments(paths?: string[]): FileAttachment[] {
  if (!paths || paths.length === 0) return [];
  return paths.map(p => storeFileFromPath(p));
}

export function handleDM(actorId: string, input: DMInput): DMOutput {
  const resolved = resolveAddressee(actorId, input.to);
  if ('error' in resolved) throw new Error(resolved.error);
  const target = resolved.agent!;
  if (target.id === actorId) throw new Error('Cannot DM yourself');

  const attachments = ingestAttachments(input.attach);
  const msg = appendDM(actorId, target.id, input.content, attachments);
  return { to_agent_id: target.id, message_id: msg.id, seq: msg.seq, attachments };
}

export async function handleDMAsync(actorId: string, input: DMInput): Promise<DMOutput> {
  const actor = getAgentById(actorId);
  if (!actor) throw new Error('Actor not found');

  const { target, node } = parseTarget(input.to);

  // Ingest attachments locally first (we need a local file_id even before deciding routing)
  const attachments = ingestAttachments(input.attach);

  // Explicit cross-node addressing: id@peer
  if (node) {
    return sendFederatedDM(actor.id, actor.display_name, target, node, input.content, attachments);
  }

  // Local resolve — but if target is a remote placeholder, route through its origin peer
  const resolved = resolveAddressee(actorId, target);
  if ('error' in resolved) throw new Error(resolved.error);
  const targetAgent = resolved.agent!;
  if (targetAgent.origin_peer && targetAgent.remote_id) {
    return sendFederatedDM(actor.id, actor.display_name, targetAgent.remote_id, targetAgent.origin_peer, input.content, attachments);
  }
  if (targetAgent.id === actorId) throw new Error('Cannot DM yourself');
  const msg = appendDM(actorId, targetAgent.id, input.content, attachments);
  return { to_agent_id: targetAgent.id, message_id: msg.id, seq: msg.seq, attachments };
}
