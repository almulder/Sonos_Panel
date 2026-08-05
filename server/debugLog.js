// server/debugLog.js
//
// Small in-memory ring buffer of recent log entries, exposed via
// GET /api/debug so the touch panel itself can show a debug screen
// (with a "copy to clipboard" button) instead of requiring someone to
// go read the terminal window. Also means when this is deployed
// headless on the Pi (no terminal attached), you're not blind.

const MAX_ENTRIES = 300;
let entries = [];

function log(level, scope, message) {
  const entry = {
    time: new Date().toISOString(),
    level, // 'info' | 'warn' | 'error'
    scope, // e.g. 'sonos', 'server'
    message: String(message)
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();

  const line = `[${scope}] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  return entry;
}

function getEntries() {
  return entries;
}

module.exports = {
  log,
  getEntries,
  info: (scope, message) => log('info', scope, message),
  warn: (scope, message) => log('warn', scope, message),
  error: (scope, message) => log('error', scope, message)
};
