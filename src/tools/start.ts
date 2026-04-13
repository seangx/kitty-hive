import { createAgent, getAgentByName, getLobby, createRoom, appendEvent, getEvents, isMember, touchAgent } from '../db.js';
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

  // Reconnect: if agent with same name exists, reuse it
  let agent = input.name ? getAgentByName(input.name) : undefined;
  if (agent) {
    touchAgent(agent.id);
  } else {
    agent = createAgent(
      displayName,
      input.tool ?? '',
      input.roles ?? '',
      input.expertise ?? '',
    );
  }

  // Find or create lobby
  let lobby = getLobby();
  if (!lobby) {
    lobby = createRoom('lobby', null, 'Lobby');
  }

  // Join lobby if not already a member
  if (!isMember(lobby.id, agent.id)) {
    appendEvent(lobby.id, 'join', agent.id, { display_name: agent.display_name });
  }

  // Get pending events in lobby (last 20)
  const pending = getEvents(lobby.id, 0, 20);

  return {
    agent_id: agent.id,
    token: agent.token,
    display_name: agent.display_name,
    lobby_room_id: lobby.id,
    pending,
  };
}
