import { listPeers, touchPeer, setPeerStatus, setPeerNodeName } from './db.js';
import { log } from './log.js';

export async function pingPeer(name: string, url: string, secret: string, timeoutMs = 5000): Promise<{ ok: boolean; node?: string; error?: string }> {
  const pingUrl = url.replace('/mcp', '/federation/ping');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(pingUrl, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${secret}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json() as { node?: string };
    return { ok: true, node: body.node };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: (err as any).message ?? String(err) };
  }
}

export async function pingAllPeers(): Promise<void> {
  const peers = listPeers();
  await Promise.all(peers.map(async p => {
    const r = await pingPeer(p.name, p.url, p.secret);
    if (r.ok) {
      touchPeer(p.name);
      setPeerStatus(p.name, 'active');
      if (r.node && r.node !== p.node_name) setPeerNodeName(p.name, r.node);
    } else {
      setPeerStatus(p.name, 'inactive');
      log('debug', `[heartbeat] peer ${p.name} unreachable: ${r.error}`);
    }
  }));
}

export function startHeartbeat(intervalMs = 60 * 1000): NodeJS.Timeout {
  // First ping after 5s to give server time to fully boot
  setTimeout(() => { pingAllPeers().catch(() => { /* ignore */ }); }, 5000);
  return setInterval(() => { pingAllPeers().catch(() => { /* ignore */ }); }, intervalMs);
}
