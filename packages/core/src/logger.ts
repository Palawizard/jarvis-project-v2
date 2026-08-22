type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.JARVIS_LOG_LEVEL as Level) || 'info'] ?? 20;

/**
 * Deliberately tiny structured logger. Anything that needs durable inspection goes
 * to the `events` table, not here — this is for operator-facing stderr only.
 */
export function createLogger(scope: string) {
  const emit = (level: Level, msg: string, data?: unknown) => {
    if (LEVELS[level] < threshold) return;
    const line = data === undefined ? '' : ` ${safeJson(data)}`;
    process.stderr.write(`${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${msg}${line}\n`);
  };
  return {
    debug: (m: string, d?: unknown) => emit('debug', m, d),
    info: (m: string, d?: unknown) => emit('info', m, d),
    warn: (m: string, d?: unknown) => emit('warn', m, d),
    error: (m: string, d?: unknown) => emit('error', m, d),
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
