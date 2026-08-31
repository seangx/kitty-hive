import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface NodeConfig {
  name?: string;
  /** Executable used by Hive-supervised Codex daemons. */
  codexCommand?: string;
  [key: string]: unknown;
}

export function getNodeConfigPath(): string {
  return join(homedir(), '.kitty-hive', 'config.json');
}

export function getNodeConfig(configPath = getNodeConfigPath()): NodeConfig {
  if (!existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as NodeConfig
      : {};
  } catch {
    return {};
  }
}

export function setNodeConfig(
  config: Record<string, unknown>,
  configPath = getNodeConfigPath(),
): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const existing = getNodeConfig(configPath);
  writeFileSync(configPath, JSON.stringify({ ...existing, ...config }, null, 2) + '\n');
}

/** Resolve the Codex executable for `kitty-hive serve`.
 *
 * An explicit environment override stays authoritative for one-off launches;
 * otherwise the persisted node setting applies to every supervised daemon.
 */
export function resolveServeCodexCommand(
  envCommand: string | undefined,
  config: NodeConfig,
): string | undefined {
  const configured = typeof config.codexCommand === 'string'
    ? config.codexCommand.trim()
    : '';
  return envCommand?.trim() || configured || undefined;
}
