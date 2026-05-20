import {
  createAgent, getAgentById, getAgentsByName, touchAgent, getDB, getAgentTeams,
  getAgentByExternalKey, trySetAgentExternalKey, setAgentProjectDir,
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
  projectDir?: string;  // working directory hint (codex agents); set as agent.project_dir
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
  // Track which lookup path matched the existing agent. Used downstream to
  // decide whether to silently mutate identity-sensitive fields (display_name,
  // tool): id-match is operator-explicit, name-match is name-only (so by
  // definition name agrees), but key-match means an orchestrator key resolved
  // to an existing agent — if the caller's `name`/`tool` disagree, that's
  // almost always a stray .mcp.json env or env-leak situation, not an
  // intentional rename. See silent-rename incident 2026-05-20 (kitty-kitty
  // → skillsmgr-web-slave; project .mcp.json hardcoded NAME but KEY was
  // inherited correctly from the pane env).
  let matchedVia: 'id' | 'key' | 'name' | null = null;

  // 1. id wins (exact identity)
  if (input.id) {
    const candidate = getAgentById(input.id);
    // Refuse to bind a local client to a remote peer's mirror row.
    // origin_peer != '' means this row is a placeholder for an agent that
    // lives on another node — its identity belongs there, not here.
    // Without this guard, anyone passing a remote agent_id (e.g. copied
    // from a whoami output) would silently take over the placeholder,
    // pollute its tool/roles, and start consuming pushes meant for the
    // real owner. See agent-id collision incident, 2026-04-22.
    if (candidate && candidate.origin_peer === '') {
      agent = candidate;
      matchedVia = 'id';
    } else if (candidate) {
      log('warn', `[start] refusing to bind to remote placeholder agent=${candidate.id} origin_peer=${candidate.origin_peer}; falling back to key/name`);
    }
  }
  // 2. key (external orchestrator handle)
  if (!agent && input.key) {
    const candidate = getAgentByExternalKey(input.key);
    if (candidate && candidate.origin_peer === '') {
      agent = candidate;
      matchedVia = 'key';
    }
  }
  // 3. name (fuzzy, reuse latest match — local only)
  if (!agent && input.name) {
    const matches = getAgentsByName(input.name).filter(a => a.origin_peer === '');
    if (matches.length > 0) {
      agent = matches.sort((a, b) => b.last_seen.localeCompare(a.last_seen))[0];
      matchedVia = 'name';
    }
  }

  if (!agent) {
    // Create — honor caller-supplied id only if it isn't already taken by a
    // remote placeholder (which we'd otherwise PRIMARY-KEY-conflict against).
    // When the id collides with a remote row, mint a fresh ULID instead so
    // the caller still gets a usable local agent rather than an error.
    let createId = input.id;
    if (createId) {
      const collision = getAgentById(createId);
      if (collision && collision.origin_peer !== '') {
        log('warn', `[start] requested id=${createId} belongs to remote peer=${collision.origin_peer}; creating fresh local agent with new id`);
        createId = undefined;
      }
    }
    const displayName = input.name || randomDisplayName();
    agent = createAgent(
      displayName,
      input.tool ?? '',
      input.roles ?? '',
      input.expertise ?? '',
      { id: createId, externalKey: input.key, projectDir: input.projectDir },
    );
  } else {
    touchAgent(agent.id);
    const updates: string[] = [];
    const params: any[] = [];

    // Silent identity updates on existing agents need different trust levels
    // per lookup path (see matchedVia above):
    //   - id match  : operator was explicit ("I am agent X"); allow silent
    //                 updates to display_name and tool.
    //   - name match: matched by name itself, so by definition input.name
    //                 equals agent.display_name; tool update allowed.
    //   - key match : key matched but caller MAY be confused about identity
    //                 (typical cause: project .mcp.json hardcodes a NAME but
    //                 the KEY env was inherited from a parent pane bound to
    //                 a different agent). Refuse to silently change
    //                 identity-sensitive fields (display_name, tool); cheap
    //                 metadata (roles, expertise) is still fair game.
    const trustIdentityUpdates = matchedVia !== 'key';

    // tool / display_name — gated on trust
    if (input.tool && input.tool !== agent.tool) {
      if (trustIdentityUpdates) {
        updates.push('tool = ?'); params.push(input.tool);
      } else {
        log('warn', `[start] refusing silent tool change via key path: agent=${agent.id} key="${input.key}" current_tool="${agent.tool}" proposed_tool="${input.tool}". Caller likely has stale env. Use hive_start with explicit id= or call dedicated mutation tools to change tool intentionally.`);
      }
    }
    if (input.name && input.name !== agent.display_name) {
      if (trustIdentityUpdates) {
        updates.push('display_name = ?'); params.push(input.name);
      } else {
        log('warn', `[start] refusing silent rename via key path: agent=${agent.id} key="${input.key}" current_name="${agent.display_name}" proposed_name="${input.name}". Caller likely has stale env (e.g. project .mcp.json hardcoded HIVE_AGENT_NAME while HIVE_AGENT_KEY was inherited from elsewhere). Use hive_rename to rename intentionally.`);
      }
    }

    // roles / expertise — cheap descriptive metadata, silent update always OK
    if (input.roles) { updates.push('roles = ?'); params.push(input.roles); }
    if (input.expertise) { updates.push('expertise = ?'); params.push(input.expertise); }

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
    // Update project_dir if caller supplied one and it differs. Lets a launcher
    // (kitty etc.) update an agent's cwd hint across re-registrations without
    // creating a new agent row.
    if (input.projectDir !== undefined && input.projectDir !== agent.project_dir) {
      setAgentProjectDir(agent.id, input.projectDir);
    }
  }

  return {
    agent_id: agent.id,
    token: agent.token,
    display_name: agent.display_name,
    teams: getAgentTeams(agent.id, true),
  };
}
