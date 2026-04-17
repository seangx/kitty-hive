import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as db from '../db.js';

export function registerFederationTools(mcp: McpServer) {
  mcp.tool(
    'hive.peers',
    'List connected federation peers.',
    {},
    async () => {
      const peers = db.listPeers();
      const result = peers.map(p => ({
        name: p.name, url: p.url, status: p.status,
        exposed: p.exposed, last_seen: p.last_seen,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  mcp.tool(
    'hive.remote.agents',
    'List agents on a remote peer node.',
    { peer: z.string().describe('Peer node name') },
    async (params) => {
      const peer = db.getPeerByName(params.peer);
      if (!peer) throw new Error(`Peer "${params.peer}" not found`);
      const res = await fetch(peer.url.replace('/mcp', '/federation/agents'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${peer.secret}`,
          'X-Hive-Peer': peer.name,
        },
      });
      if (!res.ok) throw new Error(`Failed to fetch agents from peer "${params.peer}"`);
      const data = await res.json();
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    },
  );
}
