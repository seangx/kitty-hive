import { z } from 'zod';
import { getAgentById, touchAgent } from './db.js';
import { sessionAgents } from './sessions.js';
import type { Agent } from './models.js';

export const asParam = z.string().optional().describe('Your agent id (from hive_start). Optional — session binding takes precedence.');

export function resolveAgent(extra: any, asValue?: string): Agent | null {
  // 1) Session binding (preferred)
  const sessionId = extra?.sessionId;
  if (sessionId) {
    const agentId = sessionAgents.get(sessionId);
    if (agentId) {
      const agent = getAgentById(agentId);
      if (agent) { touchAgent(agent.id); return agent; }
    }
  }
  // 2) `as` param fallback (id only — names not unique)
  if (asValue) {
    const agent = getAgentById(asValue);
    if (agent) { touchAgent(agent.id); return agent; }
  }
  return null;
}

export function authError() {
  return {
    content: [{ type: 'text' as const, text: 'Error: Not authenticated. Call hive_start first.' }],
    isError: true,
  };
}
