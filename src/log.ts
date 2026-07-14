export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LOG_PRIORITY: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
let logLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel) { logLevel = level; }

export function log(level: LogLevel, msg: string) {
  if (LOG_PRIORITY[level] <= LOG_PRIORITY[logLevel]) {
    const prefix = level === 'info' ? '' : `[${level}] `;
    // warn/error → stderr. Matters for CLI subcommands with a machine-readable
    // stdout contract (`agent register` prints bare agent_id): a warn fired
    // from shared handlers (e.g. handleStart's refused-tool-change) used to
    // land on stdout and corrupt the parsed output.
    if (level === 'warn' || level === 'error') {
      console.error(`${prefix}${msg}`);
    } else {
      console.log(`${prefix}${msg}`);
    }
  }
}
