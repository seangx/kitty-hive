import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as db from '../db.js';

const REMOTE_AGENTS_TTL_MS = 5 * 60 * 1000;
interface RemoteAgentsEntry { data: any; expires: number; }
const remoteAgentsCache = new Map<string, RemoteAgentsEntry>();

async function fetchRemoteAgents(peer: db.Peer): Promise<any> {
  const res = await fetch(peer.url.replace('/mcp', '/federation/agents'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${peer.secret}`,
      'X-Hive-Peer': peer.name,
    },
  });
  if (!res.ok) throw new Error(`Failed to fetch agents from peer "${peer.name}": HTTP ${res.status}`);
  return res.json();
}

export function registerFederationTools(mcp: McpServer) {
  mcp.tool(
    'hive.peers',
    'List connected federation peers.',
    {},
    async () => {
      const peers = db.listPeers();
      const result = peers.map(p => ({
        name: p.name, node: p.node_name, url: p.url, status: p.status,
        exposed: p.exposed, last_seen: p.last_seen,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  mcp.tool(
    'hive.remote.agents',
    'List agents on a remote peer node. Cached 5 minutes; pass fresh=true to bypass.',
    {
      peer: z.string().describe('Peer node name'),
      fresh: z.boolean().optional().describe('Bypass cache'),
    },
    async (params) => {
      const peer = db.getPeerByName(params.peer);
      if (!peer) throw new Error(`Peer "${params.peer}" not found`);

      const now = Date.now();
      const cached = remoteAgentsCache.get(peer.name);
      if (!params.fresh && cached && cached.expires > now) {
        return { content: [{ type: 'text', text: JSON.stringify({ ...cached.data, cached: true }, null, 2) }] };
      }
      const data = await fetchRemoteAgents(peer);
      remoteAgentsCache.set(peer.name, { data, expires: now + REMOTE_AGENTS_TTL_MS });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );
}
