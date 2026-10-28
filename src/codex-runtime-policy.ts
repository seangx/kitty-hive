/** Unknown observations are never permission to terminate a runtime. */
export function canStopCodexRuntime(observation: {
  ready: boolean;
  attachedConnections: number | null;
  activeTask: boolean;
}): boolean {
  return observation.ready && observation.attachedConnections === 1 && !observation.activeTask;
}

export function shouldWakeCodexForEvent(agent: {
  tool: string; origin_peer: string; runtime_enabled: number; event_mode: string;
} | undefined): boolean {
  return Boolean(agent && agent.tool === 'codex' && !agent.origin_peer
    && agent.runtime_enabled === 1 && agent.event_mode === 'auto');
}

export function selectCodexBootAgents<T extends { id: string; tool: string; origin_peer: string; runtime_enabled: number; event_mode: string }>(
  agents: T[], hasDurableDemand: (id: string) => boolean,
): T[] {
  return agents.filter(agent => shouldWakeCodexForEvent(agent) && hasDurableDemand(agent.id));
}
