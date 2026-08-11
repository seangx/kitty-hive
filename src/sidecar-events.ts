export interface SidecarWake {
  taskId: string;
  cursor: number;
}

type SidecarWakeListener = (wake: SidecarWake) => void;

// The Sidecar stream is a wake-up channel only. Authoritative state stays in
// SQLite and clients re-read snapshots after every wake. A Set keeps listener
// ownership explicit and avoids EventEmitter's global listener-limit warnings
// when Kitty reconnects several renderer windows during development.
const listeners = new Set<SidecarWakeListener>();

export function publishSidecarWake(wake: SidecarWake): void {
  for (const listener of [...listeners]) listener(wake);
}

export function subscribeSidecarWakes(listener: SidecarWakeListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function sidecarSubscriberCount(): number {
  return listeners.size;
}
