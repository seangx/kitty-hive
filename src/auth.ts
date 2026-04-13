import { getAgentByToken, touchAgent } from './db.js';
import type { Agent } from './models.js';

/**
 * Extract agent from Bearer token.
 * Returns the agent if valid, null otherwise.
 * Also updates last_seen timestamp.
 */
export function authenticateToken(authHeader: string | undefined): Agent | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!match) return null;

  const agent = getAgentByToken(match[1]);
  if (!agent) return null;

  touchAgent(agent.id);
  return agent;
}
