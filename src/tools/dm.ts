import { getAgentById, appendDM, resolveAddressee, getPeerByName } from '../db.js';

interface DMInput {
  to: string;
  content: string;
}

interface DMOutput {
  to_agent_id: string;
  message_id: number;
  seq: number;
  federated?: boolean;
}

// Parse "agent_id_or_nickname@node" → { target, node }
function parseTarget(to: string): { target: string; node?: string } {
  const at = to.lastIndexOf('@');
  if (at > 0) return { target: to.slice(0, at), node: to.slice(at + 1) };
  return { target: to };
}

async function sendFederatedDM(fromName: string, toAgent: string, peerName: string, content: string): Promise<DMOutput> {
  const peer = getPeerByName(peerName);
  if (!peer) throw new Error(`Peer "${peerName}" not found. Add it with: kitty-hive peer add ${peerName} <url>`);

  const res = await fetch(peer.url.replace('/mcp', '/federation/dm'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${peer.secret}`,
      'X-Hive-Peer': peerName,
    },
    body: JSON.stringify({ from: fromName, to: toAgent, content }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`Federation DM failed: ${(err as any).error || res.statusText}`);
  }

  const result = await res.json() as { delivered: boolean; message_id: number; seq: number };
  return { to_agent_id: `federated:${peerName}`, message_id: result.message_id, seq: result.seq, federated: true };
}

export function handleDM(actorId: string, input: DMInput): DMOutput {
  const resolved = resolveAddressee(actorId, input.to);
  if ('error' in resolved) throw new Error(resolved.error);
  const target = resolved.agent!;
  if (target.id === actorId) throw new Error('Cannot DM yourself');

  const msg = appendDM(actorId, target.id, input.content);
  return { to_agent_id: target.id, message_id: msg.id, seq: msg.seq };
}

export async function handleDMAsync(actorId: string, input: DMInput): Promise<DMOutput> {
  const actor = getAgentById(actorId);
  const { target, node } = parseTarget(input.to);

  if (node) {
    const fromName = actor?.display_name ?? actorId;
    return sendFederatedDM(fromName, target, node, input.content);
  }

  return handleDM(actorId, { to: target, content: input.content });
}
