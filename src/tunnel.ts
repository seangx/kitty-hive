/**
 * cloudflared quick-tunnel manager.
 * Pure module — no HTTP, no DB. Caller wires up callbacks.
 */

import { spawn, ChildProcess, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const COMMON_PATHS = process.platform === 'win32'
  ? ['C:\\Program Files (x86)\\cloudflared\\cloudflared.exe']
  : ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared'];

export function findCloudflared(): string | null {
  if (process.platform === 'win32') {
    // On Windows, prefer .exe then .cmd; the bare-name shim is a sh script that spawn() can't run.
    for (const name of ['cloudflared.exe', 'cloudflared.cmd', 'cloudflared.ps1']) {
      try {
        const out = execSync(`where ${name}`, { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
        if (out) return out;
      } catch { /* not found */ }
    }
  } else {
    try {
      const out = execSync('command -v cloudflared', { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
      if (out) return out;
    } catch { /* not in PATH */ }
  }
  // Fallback to known install locations
  for (const p of COMMON_PATHS) {
    if (existsSync(p)) return p;
  }
  return null;
}

export interface TunnelOptions {
  port: number;
  binary?: string;             // path to cloudflared (auto-detected if omitted)
  onUrl: (url: string) => void;
  onError?: (msg: string) => void;
  onExit?: (code: number | null) => void;
  restartOnDeath?: boolean;    // default true
}

export class TunnelManager {
  private child: ChildProcess | null = null;
  private currentUrl: string | null = null;
  private stopRequested = false;
  private restartDelayMs = 1000;
  private readonly opts: TunnelOptions;
  private readonly binary: string;

  constructor(opts: TunnelOptions) {
    this.opts = { restartOnDeath: true, ...opts };
    const bin = opts.binary || findCloudflared();
    if (!bin) {
      throw new Error('cloudflared not found in PATH. Install it: brew install cloudflared (macOS) · choco install cloudflared (Windows) · see https://github.com/cloudflare/cloudflared/releases');
    }
    this.binary = bin;
  }

  start(): void {
    this.stopRequested = false;
    this.spawn();
  }

  stop(): void {
    this.stopRequested = true;
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM');
      // Force kill after 3s if it doesn't exit
      const c = this.child;
      setTimeout(() => { if (!c.killed) c.kill('SIGKILL'); }, 3000);
    }
    this.child = null;
  }

  getUrl(): string | null { return this.currentUrl; }

  private spawn(): void {
    const args = ['tunnel', '--url', `http://localhost:${this.opts.port}`, '--no-autoupdate'];
    // On Windows, .cmd / .ps1 shims need a shell to invoke. Safe here because
    // both binary path and args are under our control (no user-supplied strings).
    const useShell = process.platform === 'win32';
    const child = spawn(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: useShell });
    this.child = child;

    const handleData = (buf: Buffer) => {
      const text = buf.toString();
      const match = text.match(URL_REGEX);
      if (match && match[0] !== this.currentUrl) {
        const url = match[0];
        this.currentUrl = url;
        try { this.opts.onUrl(url); } catch (err) { this.opts.onError?.(`onUrl handler threw: ${(err as any).message}`); }
      }
    };
    child.stderr?.on('data', handleData);
    child.stdout?.on('data', handleData);

    child.on('error', err => {
      this.opts.onError?.(`cloudflared spawn error: ${err.message}`);
    });

    child.on('exit', code => {
      this.child = null;
      this.opts.onExit?.(code);
      if (this.stopRequested) return;
      if (!this.opts.restartOnDeath) return;
      // exponential backoff up to 60s
      const delay = this.restartDelayMs;
      this.restartDelayMs = Math.min(this.restartDelayMs * 2, 60_000);
      this.opts.onError?.(`cloudflared exited (code=${code}); restarting in ${Math.round(delay / 1000)}s`);
      setTimeout(() => { if (!this.stopRequested) this.spawn(); }, delay);
    });

    // Reset backoff after stable run (60s without exit = healthy)
    setTimeout(() => { if (this.child === child) this.restartDelayMs = 1000; }, 60_000);
  }
}
