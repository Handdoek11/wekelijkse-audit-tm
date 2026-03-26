const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL ?? "info"] ?? LEVELS.info;

/**
 * @param {"debug"|"info"|"warn"|"error"} level
 * @param {string} message
 * @param {string} [context]
 */
function log(level, message, context) {
  if (LEVELS[level] < currentLevel) return;
  const ts = new Date().toISOString();
  const ctx = context ? ` [${context}]` : "";
  const line = `[${ts}] [${level.toUpperCase()}]${ctx} ${message}`;
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (msg, ctx) => log("debug", msg, ctx),
  info: (msg, ctx) => log("info", msg, ctx),
  warn: (msg, ctx) => log("warn", msg, ctx),
  error: (msg, ctx) => log("error", msg, ctx),
};
