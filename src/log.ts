export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LOG_PRIORITY: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
let logLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel) { logLevel = level; }

export function log(level: LogLevel, msg: string) {
  if (LOG_PRIORITY[level] <= LOG_PRIORITY[logLevel]) {
    const prefix = level === 'info' ? '' : `[${level}] `;
    console.log(`${prefix}${msg}`);
  }
}
