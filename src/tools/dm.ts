import { getAgentById, getAgentByName, findDMRoom, createRoom, appendRoomEvent } from '../db.js';

interface DMInput {
  to: string;
  content: string;
}

interface DMOutput {
  room_id: string;
  event_id: number;
}

export function handleDM(actorId: string, input: DMInput): DMOutput {
  const actor = getAgentById(actorId);
  const target = getAgentById(input.to) || getAgentByName(input.to);
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
