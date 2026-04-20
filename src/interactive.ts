// Thin wrappers around @clack/prompts. Always exit cleanly on Ctrl+C / Esc.
import * as clack from '@clack/prompts';
import { listPeers, getPeerByName } from './db.js';

export const intro = clack.intro;
export const outro = clack.outro;
export const spinner = clack.spinner;
export const isCancel = clack.isCancel;
export const cancel = clack.cancel;
export const isInteractive = () => Boolean(process.stdin.isTTY);

function check<T>(v: T | symbol): T {
  if (clack.isCancel(v)) {
    clack.cancel('Cancelled.');
    process.exit(0);
  }
  return v as T;
}

export async function askText(opts: Parameters<typeof clack.text>[0]): Promise<string> {
  return check(await clack.text(opts));
}

export async function askSelect<V>(opts: {
  message: string;
  options: Array<{ value: V; label?: string; hint?: string }>;
  initialValue?: V;
}): Promise<V> {
  return check(await clack.select<V>(opts as any));
}

export async function askMultiselect<V>(opts: {
  message: string;
  options: Array<{ value: V; label?: string; hint?: string }>;
  initialValues?: V[];
  required?: boolean;
}): Promise<V[]> {
  return check(await clack.multiselect<V>(opts as any));
}

export async function askConfirm(opts: {
  message: string;
  initialValue?: boolean;
}): Promise<boolean> {
  return check(await clack.confirm(opts));
}

// --- Domain-specific pickers ---

interface AgentRow {
  id: string;
  display_name: string;
}

function listLocalAgents(db: any): AgentRow[] {
  return db
    .prepare("SELECT id, display_name FROM agents WHERE origin_peer = '' ORDER BY last_seen DESC")
    .all() as AgentRow[];
}

export async function pickLocalAgent(db: any, message: string): Promise<string> {
  const agents = listLocalAgents(db);
  if (agents.length === 0) {
    console.log('No local agents registered yet. (Agents register on first hive_start.)');
    process.exit(1);
  }
  if (agents.length === 1) return agents[0].id;
  return askSelect<string>({
    message,
    options: agents.map(a => ({
      value: a.id,
      label: a.display_name,
      hint: a.id,
    })),
  });
}

export async function pickLocalAgents(
  db: any,
  message: string,
  initial: string[] = [],
): Promise<string[]> {
  const agents = listLocalAgents(db);
  if (agents.length === 0) {
    console.log('No local agents to expose. Register one first via hive_start.');
    return [];
  }
  return askMultiselect<string>({
    message,
    options: agents.map(a => ({
      value: a.id,
      label: a.display_name,
      hint: a.id,
    })),
    initialValues: initial.filter(id => agents.some(a => a.id === id)),
    required: false,
  });
}

export function isLocalAgent(db: any, agentId: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM agents WHERE id = ? AND origin_peer = ''")
    .get(agentId);
  return !!row;
}

export async function pickPeer(message: string): Promise<string> {
  const peers = listPeers();
  if (peers.length === 0) {
    console.log('No peers configured. Run `kitty-hive peer invite` or `kitty-hive peer add` first.');
    process.exit(1);
  }
  if (peers.length === 1) return peers[0].name;
  return askSelect<string>({
    message,
    options: peers.map(p => ({
      value: p.name,
      label: p.name,
      hint: `${p.status} · ${p.url}`,
    })),
  });
}

export function peerExists(name: string): boolean {
  return !!getPeerByName(name);
}
