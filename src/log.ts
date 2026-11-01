/**
 * Tiny JSON-lines logger. One line per event so Render's log search works
 * (e.g. search for a PayPal debug_id). Keys that look secret are redacted.
 * Set LOG_LEVEL=debug|info|warn|error|silent (default info).
 */
type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

const RANK: Record<Level | 'silent', number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const SECRET_KEY = /secret|password|authorization|token|api[-_]?key|cookie/i;

function threshold(): number {
  const level = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return RANK[level as Level] ?? RANK.info;
}

function serialize(value: unknown, depth = 0): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => serialize(v, depth + 1));
  const out: Fields = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? '[redacted]' : serialize(v, depth + 1);
  }
  return out;
}

function write(level: Level, msg: string, fields?: Fields): void {
  if (RANK[level] < threshold()) return;
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    msg,
    ...(fields ? (serialize(fields) as Fields) : {}),
  });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, fields?: Fields) => write('debug', msg, fields),
  info: (msg: string, fields?: Fields) => write('info', msg, fields),
  warn: (msg: string, fields?: Fields) => write('warn', msg, fields),
  error: (msg: string, fields?: Fields) => write('error', msg, fields),
};
