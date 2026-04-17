import { createAgent, getAgentById, getAgentsByName, touchAgent, getDB, getAgentTeams } from '../db.js';
import type { Team } from '../models.js';

interface StartInput {
  id?: string;
  name?: string;
  roles?: string;
  tool?: string;
  expertise?: string;
}

interface StartOutput {
  agent_id: string;
  token: string;
  display_name: string;
  teams: Team[];
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
  let agent;
  // Priority: id (exact reconnect) > name (reuse latest match) > create new
  if (input.id) {
    agent = getAgentById(input.id);
    if (!agent) throw new Error(`Agent id "${input.id}" not found`);
    touchAgent(agent.id);
  } else if (input.name) {
    const matches = getAgentsByName(input.name);
    if (matches.length > 0) {
      agent = matches.sort((a, b) => b.last_seen.localeCompare(a.last_seen))[0];
      touchAgent(agent.id);
    }
  }
  if (agent) {
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
    const displayName = input.name || randomDisplayName();
    agent = createAgent(displayName, input.tool ?? '', input.roles ?? '', input.expertise ?? '');
  }

  return {
    agent_id: agent.id,
    token: agent.token,
    display_name: agent.display_name,
    teams: getAgentTeams(agent.id, true),
  };
}
