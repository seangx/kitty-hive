import { getAgentById, getAgentByName, findDMRoom, createRoom, appendRoomEvent, getPeerByName } from '../db.js';

interface DMInput {
  to: string;
  content: string;
}

interface DMOutput {
  room_id: string;
  event_id: number;
  federated?: boolean;
}

// Parse "bob@alice" → { agent: "bob", node: "alice" }
function parseTarget(to: string): { agent: string; node?: string } {
  const at = to.lastIndexOf('@');
  if (at > 0) return { agent: to.slice(0, at), node: to.slice(at + 1) };
  return { agent: to };
}

// Send DM to a remote peer
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

  const result = await res.json() as { delivered: boolean; event_id: number };
  return { room_id: `federated:${peerName}`, event_id: result.event_id, federated: true };
}

export function handleDM(actorId: string, input: DMInput): DMOutput {
  const actor = getAgentById(actorId);
  const { agent: targetName, node } = parseTarget(input.to);

  // Federated DM — handled async, return promise-like
  // Note: caller must handle the async case
  if (node) {
    // Store as pending — actual send happens in handleDMAsync
    throw new Error(`__FEDERATED__:${targetName}:${node}`);
  }

  const target = getAgentById(targetName) || getAgentByName(targetName);
  if (!target) throw new Error(`Agent not found: ${input.to}`);
  if (target.id === actorId) throw new Error('Cannot DM yourself');

  let room = findDMRoom(actorId, target.id);
  if (!room) {
    const actorName = actor?.display_name ?? actorId;
    room = createRoom('dm', actorId, `DM: ${actorName} ↔ ${target.display_name}`);
    appendRoomEvent(room.id, 'join', actorId);
    appendRoomEvent(room.id, 'join', target.id);
  }

  const event = appendRoomEvent(room.id, 'message', actorId, { content: input.content });
  return { room_id: room.id, event_id: event.id };
}

export async function handleDMAsync(actorId: string, input: DMInput): Promise<DMOutput> {
  const actor = getAgentById(actorId);
  const { agent: targetName, node } = parseTarget(input.to);

  if (node) {
    const fromName = actor?.display_name ?? actorId;
    return sendFederatedDM(fromName, targetName, node, input.content);
  }

  return handleDM(actorId, input);
}
