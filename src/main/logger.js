/**
 * 本地日志：滚动保留 7 天。**不收集、不上传任何数据**（§15.4）。
 */
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor(dir, { level = 'info', keepDays = 7, echo = true } = {}) {
    this.dir = dir;
    this.level = level;
    this.keepDays = keepDays;
    this.echo = echo;
    this.buffer = [];
    try {
      mkdirSync(dir, { recursive: true });
      this.prune();
    } catch {
      this.dir = null;
    }
  }

  file() {
    const today = new Date().toISOString().slice(0, 10);
    return this.dir ? join(this.dir, `main-${today}.log`) : null;
  }

  prune() {
    if (!this.dir) return;
    const cutoff = Date.now() - this.keepDays * 86400000;
    for (const name of readdirSync(this.dir)) {
      if (!/^main-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
      const full = join(this.dir, name);
      try {
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full);
      } catch { /* 忽略 */ }
    }
  }

  setLevel(level) {
    if (level in LEVEL_ORDER) this.level = level;
  }

  log(level, message, detail) {
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}${detail === undefined ? '' : ` ${safeJson(detail)}`}`;
    this.buffer.push(line);
    if (this.buffer.length > 500) this.buffer.shift();
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    if (this.echo) process.stdout?.write?.(`${line}\n`);
    const file = this.file();
    if (!file) return;
    try {
      appendFileSync(file, `${line}\n`, 'utf8');
    } catch { /* 日志失败不影响主流程 */ }
  }

  debug(m, d) { this.log('debug', m, d); }
  info(m, d) { this.log('info', m, d); }
  warn(m, d) { this.log('warn', m, d); }
  error(m, d) { this.log('error', m, d); }

  tail(n = 100) {
    return this.buffer.slice(-n);
  }
}

function safeJson(value) {
  try {
    if (value instanceof Error) return JSON.stringify({ message: value.message, stack: value.stack?.split('\n').slice(0, 3) });
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
