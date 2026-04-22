import {
  createAgent, getAgentById, getAgentsByName, touchAgent, getDB, getAgentTeams,
  getAgentByExternalKey, trySetAgentExternalKey,
} from '../db.js';
import { log } from '../log.js';
import type { Agent, Team } from '../models.js';

interface StartInput {
  id?: string;
  key?: string;     // external_key from an external orchestrator (kitty session uuid, etc.)
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

/**
 * Resolve or create an agent. Priority for picking the row to act on:
 *   1. `id` — explicit hive agent_id (exact ULID)
 *   2. `key` — opaque external_key (orchestrator-assigned)
 *   3. `name` — display_name (latest match by last_seen)
 *
 * Caller never has to handle "not found" — every path either reuses or
 * creates. external_key is upserted onto the chosen agent silently
 * (UNIQUE conflict → logged warn, agent unchanged).
 */
export function handleStart(input: StartInput): StartOutput {
  let agent: Agent | undefined;

  // 1. id wins (exact identity)
  if (input.id) {
    agent = getAgentById(input.id);
  }
  // 2. key (external orchestrator handle)
  if (!agent && input.key) {
    agent = getAgentByExternalKey(input.key);
  }
  // 3. name (fuzzy, reuse latest match)
  if (!agent && input.name) {
    const matches = getAgentsByName(input.name);
    if (matches.length > 0) {
      agent = matches.sort((a, b) => b.last_seen.localeCompare(a.last_seen))[0];
    }
  }

  if (!agent) {
    // Create — honor caller-supplied id and key when given
    const displayName = input.name || randomDisplayName();
    agent = createAgent(
      displayName,
      input.tool ?? '',
      input.roles ?? '',
      input.expertise ?? '',
      { id: input.id, externalKey: input.key },
    );
  } else {
    touchAgent(agent.id);
    const updates: string[] = [];
    const params: any[] = [];
    if (input.tool) { updates.push('tool = ?'); params.push(input.tool); }
    if (input.roles) { updates.push('roles = ?'); params.push(input.roles); }
    if (input.expertise) { updates.push('expertise = ?'); params.push(input.expertise); }
    // Silent display_name refresh when caller supplied a different name
    // (orchestrator updates the pane title → hive picks it up automatically).
    if (input.name && input.name !== agent.display_name) {
      updates.push('display_name = ?'); params.push(input.name);
    }
    if (updates.length > 0) {
      params.push(agent.id);
      getDB().prepare(`UPDATE agents SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      agent = getAgentById(agent.id)!; // refresh
    }
    // Attach external_key when given and not already set on this agent.
    // UNIQUE conflict means another agent owns that key → leave as-is, warn.
    if (input.key && agent.external_key !== input.key) {
      const ok = trySetAgentExternalKey(agent.id, input.key);
      if (!ok) {
        log('warn', `[start] external_key="${input.key}" already owned by another agent; agent=${agent.id} keeps key="${agent.external_key || '(none)'}"`);
      }
    }
  }

  return {
    agent_id: agent.id,
    token: agent.token,
    display_name: agent.display_name,
    teams: getAgentTeams(agent.id, true),
  };
}
