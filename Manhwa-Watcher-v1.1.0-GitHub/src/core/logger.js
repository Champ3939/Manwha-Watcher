const fs = require('fs');
const path = require('path');

class Logger {
  constructor(baseDir, limit = 500) {
    this.limit = limit;
    this.entries = [];
    this.logDir = path.join(baseDir, 'Logs');
    this.logFile = path.join(this.logDir, 'manhwa-watcher.log');
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  add(level, message, details = null) {
    const entry = {
      time: new Date().toISOString(),
      level: String(level || 'info'),
      message: String(message || ''),
      details: details == null ? null : details
    };
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    try {
      const suffix = details == null ? '' : ` | ${JSON.stringify(details)}`;
      fs.appendFileSync(this.logFile, `${entry.time} [${entry.level.toUpperCase()}] ${entry.message}${suffix}\r\n`, 'utf8');
    } catch {}
    return entry;
  }

  info(message, details) { return this.add('info', message, details); }
  warn(message, details) { return this.add('warn', message, details); }
  error(message, details) { return this.add('error', message, details); }
  list() { return structuredClone(this.entries); }
  clear() {
    this.entries = [];
    try { fs.writeFileSync(this.logFile, '', 'utf8'); } catch {}
    return true;
  }
}

module.exports = Logger;
