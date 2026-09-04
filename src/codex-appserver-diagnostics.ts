export type CodexAppserverDiagnostic =
  | { kind: 'mcp_unavailable'; endpoint: string }
  | { kind: 'model_refresh_timeout' }
  | { kind: 'system_skills_race' };

type DiagnosticBucket = {
  count: number;
  agents: Set<string>;
};

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

function safeEndpointLabel(raw: string): string {
  try {
    const url = new URL(raw);
    // Never copy query strings or credentials from an MCP URL into the
    // operator log. The origin + path is enough to locate the bad config.
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return 'unknown-http-endpoint';
  }
}

/** Classify only exact, known Codex app-server diagnostics that do not stop
 * the Hive daemon from reaching ready. Everything else must remain visible. */
export function classifyCodexAppserverDiagnostic(
  line: string,
): CodexAppserverDiagnostic | null {
  const plain = line.replace(ANSI_ESCAPE, '');

  if (
    plain.includes('rmcp::transport::worker')
    && plain.includes('worker quit with fatal: Transport channel closed')
    && plain.includes('http/request failed: error sending request for url')
  ) {
    const match = plain.match(
      /error sending request for url \((https?:\/\/[^)\s"]+)/,
    );
    return {
      kind: 'mcp_unavailable',
      endpoint: safeEndpointLabel(match?.[1] || ''),
    };
  }

  if (
    plain.includes('codex_models_manager::manager')
    && plain.includes(
      'failed to refresh available models: timeout waiting for child process to exit',
    )
  ) {
    return { kind: 'model_refresh_timeout' };
  }

  if (
    plain.includes('codex_skills_extension::host_service')
    && plain.includes('failed to install system skills:')
    && plain.includes('Directory not empty (os error 66)')
  ) {
    return { kind: 'system_skills_race' };
  }

  return null;
}

function diagnosticKey(diagnostic: CodexAppserverDiagnostic): string {
  return diagnostic.kind === 'mcp_unavailable'
    ? `${diagnostic.kind}\0${diagnostic.endpoint}`
    : diagnostic.kind;
}

/** Cross-daemon accumulator. A quiet-period flush turns a burst of identical
 * app-server errors into one actionable warning without hiding the cause. */
export class CodexAppserverDiagnosticCoalescer {
  private readonly buckets = new Map<string, DiagnosticBucket>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly emit: (message: string) => void,
    private readonly quietMs = 5_000,
  ) {}

  record(agent: string, diagnostic: CodexAppserverDiagnostic): void {
    const key = diagnosticKey(diagnostic);
    const bucket = this.buckets.get(key) || { count: 0, agents: new Set<string>() };
    bucket.count += 1;
    bucket.agents.add(agent);
    this.buckets.set(key, bucket);

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.quietMs);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.buckets.size === 0) return;

    const allAgents = new Set<string>();
    let total = 0;
    const mcp: Array<{ endpoint: string; count: number }> = [];
    let modelRefreshTimeouts = 0;
    let systemSkillsRaces = 0;

    for (const [key, bucket] of this.buckets) {
      total += bucket.count;
      for (const agent of bucket.agents) allAgents.add(agent);
      if (key.startsWith('mcp_unavailable\0')) {
        mcp.push({
          endpoint: key.slice('mcp_unavailable\0'.length),
          count: bucket.count,
        });
      } else if (key === 'model_refresh_timeout') {
        modelRefreshTimeouts += bucket.count;
      } else if (key === 'system_skills_race') {
        systemSkillsRaces += bucket.count;
      }
    }

    const details: string[] = [];
    if (mcp.length > 0) {
      mcp.sort((a, b) => b.count - a.count || a.endpoint.localeCompare(b.endpoint));
      details.push(
        `MCP unavailable: ${mcp.map(item => `${item.endpoint} x${item.count}`).join(', ')}`,
      );
    }
    if (modelRefreshTimeouts > 0) {
      details.push(`model refresh timeout x${modelRefreshTimeouts}`);
    }
    if (systemSkillsRaces > 0) {
      details.push(`system skill install race x${systemSkillsRaces}`);
    }

    this.buckets.clear();
    this.emit(
      `[codex-supervisor] coalesced ${total} non-blocking app-server diagnostic(s) `
      + `across ${allAgents.size} daemon(s): ${details.join('; ')}`,
    );
  }
}

/** Line-buffer one daemon's stderr so split chunks can be classified safely. */
export class CodexDaemonLogForwarder {
  private remainder = '';

  constructor(
    private readonly prefix: string,
    private readonly agent: string,
    private readonly diagnostics: CodexAppserverDiagnosticCoalescer,
    private readonly compact: boolean,
    private readonly write: (text: string) => void = text => process.stderr.write(text),
  ) {}

  push(chunk: string | Buffer): void {
    const parts = (this.remainder + String(chunk)).split(/\n/);
    this.remainder = parts.pop() || '';
    for (const part of parts) this.forwardLine(part.replace(/\r$/, ''));
  }

  end(): void {
    if (!this.remainder) return;
    this.forwardLine(this.remainder.replace(/\r$/, ''));
    this.remainder = '';
  }

  private forwardLine(line: string): void {
    if (this.compact) {
      const diagnostic = classifyCodexAppserverDiagnostic(line);
      if (diagnostic) {
        this.diagnostics.record(this.agent, diagnostic);
        return;
      }
    }
    this.write(`${this.prefix} ${line}\n`);
  }
}
