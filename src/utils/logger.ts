/**
 * Minimal structured logger.
 *
 * Deliberately not winston/pino: this app's logging need is "one line per request plus errors",
 * and a logging framework would be a dependency doing less than 40 lines does. The interface is
 * the one those libraries expose (`info`/`warn`/`error`/`child`), so swapping one in later is a
 * change to this file alone.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

type Level = keyof typeof LEVELS;
export type LogMeta = Record<string, unknown>;

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
  /** A logger tagged with a narrower scope, e.g. logger.child('seed'). */
  child(childScope: string): Logger;
}

const isLevel = (value: string): value is Level => value in LEVELS;

const configured = process.env.LOG_LEVEL ?? 'info';
const threshold = isLevel(configured) ? LEVELS[configured] : LEVELS.info;

function emit(level: Level, scope: string | undefined, message: string, meta?: LogMeta): void {
  if (LEVELS[level] < threshold) return;
  const prefix = scope ? `[${scope}]` : '';
  const suffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  // Errors and warnings to stderr so `docker compose logs` and any collector can separate them.
  const sink = level === 'error' || level === 'warn' ? console.error : console.log;
  sink(`${new Date().toISOString()} ${level.toUpperCase()} ${prefix} ${message}${suffix}`.trim());
}

export function createLogger(scope?: string): Logger {
  return {
    debug: (message, meta) => emit('debug', scope, message, meta),
    info: (message, meta) => emit('info', scope, message, meta),
    warn: (message, meta) => emit('warn', scope, message, meta),
    error: (message, meta) => emit('error', scope, message, meta),
    child: (childScope) => createLogger(scope ? `${scope}:${childScope}` : childScope),
  };
}

export const logger = createLogger('api');
