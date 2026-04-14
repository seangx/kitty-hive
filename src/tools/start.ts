import { createAgent, getAgentByName, getLobby, createRoom, appendRoomEvent, getRoomEvents, isMember, touchAgent, getDB } from '../db.js';
import type { RoomEvent } from '../models.js';

interface StartInput {
  name?: string;
  roles?: string;
  tool?: string;
  expertise?: string;
}

interface StartOutput {
  agent_id: string;
  token: string;
  display_name: string;
  lobby_room_id: string;
  pending: RoomEvent[];
}

const ADJECTIVES = ['Swift', 'Calm', 'Bold', 'Keen', 'Warm', 'Wise', 'Fair', 'True', 'Deft', 'Glad'];
const NOUNS = ['Paw', 'Claw', 'Tail', 'Fang', 'Mane', 'Wing', 'Reef', 'Peak', 'Glen', 'Vale'];

function randomDisplayName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(Math.random() * 100);
  return `${adj}${noun}${num}`;
}

export function handleStart(input: StartInput): StartOutput {
  const displayName = input.name || randomDisplayName();

  let agent = input.name ? getAgentByName(input.name) : undefined;
  if (agent) {
    touchAgent(agent.id);
    // Update roles/tool/expertise if provided
    const updates: string[] = [];
    const params: any[] = [];
    if (input.tool) { updates.push('tool = ?'); params.push(input.tool); }
    if (input.roles) { updates.push('roles = ?'); params.push(input.roles); }
    if (input.expertise) { updates.push('expertise = ?'); params.push(input.expertise); }
    if (updates.length > 0) {
      params.push(agent.id);
      getDB().prepare(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }
  } else {
    agent = createAgent(displayName, input.tool ?? '', input.roles ?? '', input.expertise ?? '');
  }

  let lobby = getLobby();
  if (!lobby) {
    lobby = createRoom('lobby', null, 'Lobby');
  }

  if (!isMember(lobby.id, agent.id)) {
    appendRoomEvent(lobby.id, 'join', agent.id, { display_name: agent.display_name });
  }

  const pending = getRoomEvents(lobby.id, 0, 20);

  return {
    agent_id: agent.id,
    token: agent.token,
    display_name: agent.display_name,
    lobby_room_id: lobby.id,
    pending,
  };
}
