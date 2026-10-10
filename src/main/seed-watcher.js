/**
 * SeedWatcher：轮询 Player.log 尾部读种子（§8.3）。
 *
 * 四个必须处理的实测坑（方案 §6.3）：
 *  1. 目录项长度陈旧 → 不用文件大小判断，固定间隔直接读尾部固定字节数
 *  2. 编码 → 必须按 UTF-8 读
 *  3. 重复行（[T16] 前缀）→ 取最后一个匹配
 *  4. 文件轮转 → 用轮询而不是 FileSystemWatcher
 */
import { EventEmitter } from 'node:events';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SEED_PATTERN = /Map seed is:\s*(\d{1,10})/g;
export const SEED_MIN = 1;
export const SEED_MAX = 2147483647;

export function defaultPlayerLogPath(env = process.env) {
  const home = env.USERPROFILE || env.HOME || homedir();
  return join(home, 'AppData', 'LocalLow', 'Northwood', 'SCPSL', 'Player.log');
}

/** 从一段文本里取最后一个合法种子；没有则返回 null */
export function parseSeed(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  let match;
  let found = null;
  SEED_PATTERN.lastIndex = 0;
  while ((match = SEED_PATTERN.exec(text)) !== null) found = match[1];
  if (found === null) return null;
  return validateSeed(found);
}

export function validateSeed(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  if (n < SEED_MIN || n > SEED_MAX) return null;
  return n;
}

/** 读文件尾部 bytes 字节并按 UTF-8 解码；多字节被截断时丢掉首个残行 */
export function readTail(path, bytes = 65536) {
  let fd;
  try {
    const size = statSync(path).size;
    const length = Math.min(bytes, size);
    const start = size - length;
    const buffer = Buffer.allocUnsafe(length);
    fd = openSync(path, 'r');
    const read = readSync(fd, buffer, 0, length, start);
    let text = buffer.subarray(0, read).toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : text;
    }
    return { text, size, read, truncated: start > 0 };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* 忽略 */ }
    }
  }
}

export class SeedWatcher extends EventEmitter {
  constructor({ logPath = null, pollMs = 500, tailBytes = 65536, deepScanBytes = 32 * 1024 * 1024, deepScanCooldownMs = 5000 } = {}) {
    super();
    this.logPath = logPath || defaultPlayerLogPath();
    this.pollMs = pollMs;
    this.tailBytes = tailBytes;
    /**
     * 实测坑（本机 Player.log 189KB 时，最后一次种子的位置在**距文件尾 126KB** 处）：
     * 游戏敲完 seed 之后还会继续写日志，种子行很快就被挤出尾部窗口。
     * 所以：常规轮询只读尾部（便宜），一旦尾部没有种子且当前还没有种子，
     * 就做一次"深处扫描"（最多 32MB，一次性读入避免多字节被切断），并加冷却时间。
     */
    this.deepScanBytes = deepScanBytes;
    this.deepScanCooldownMs = deepScanCooldownMs;
    this.lastDeepScanAt = 0;
    this.timer = null;
    this.currentSeed = null;
    this.state = 'idle';
    this.lastError = null;
    this.lastReadAt = null;
    this.lastDeepScanResult = null;
    this.missCount = 0;
  }

  setLogPath(path) {
    this.logPath = path;
    this.missCount = 0;
    this.emitStatus();
  }

  start() {
    if (this.timer) return;
    this.state = 'watching';
    this.emitStatus();
    this.tick();
    this.timer = setInterval(() => this.tick(), this.pollMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state = 'idle';
    this.emitStatus();
  }

  /** 手动重读（Ctrl+5 / 托盘菜单）：忽略去重，强制广播同一颗种子 */
  readNow({ force = false } = {}) {
    return this.tick({ force });
  }

  /** 深处扫描：一次性读入尾部最多 deepScanBytes，找最后一次种子（有冷却，避免狂读大文件） */
  deepScan({ force = false } = {}) {
    const now = Date.now();
    if (!force && now - this.lastDeepScanAt < this.deepScanCooldownMs) return this.lastDeepScanResult;
    this.lastDeepScanAt = now;
    try {
      const { text } = readTail(this.logPath, this.deepScanBytes);
      this.lastDeepScanResult = parseSeed(text);
    } catch (error) {
      this.lastError = error.code || error.message;
      this.lastDeepScanResult = null;
    }
    return this.lastDeepScanResult;
  }

  tick({ force = false } = {}) {
    if (!existsSync(this.logPath)) {
      this.missCount += 1;
      this.state = 'degraded';
      this.lastError = 'ENOENT';
      // 轮转/未启动都走这里：静默重试，不打扰用户（§12）
      if (this.missCount === 1 || this.missCount % 60 === 0) this.emitStatus();
      return null;
    }
    let tail;
    try {
      tail = readTail(this.logPath, this.tailBytes);
      this.missCount = 0;
    } catch (error) {
      this.state = 'degraded';
      this.lastError = error.code || error.message;
      this.emitStatus();
      return null;
    }
    this.lastReadAt = Date.now();
    let seed = parseSeed(tail.text);
    if (seed === null && (this.currentSeed === null || force)) {
      const deep = this.deepScan({ force });
      if (deep !== null) seed = deep;
    }
    if (seed === null) {
      if (this.state !== 'watching') {
        this.state = 'watching';
        this.emitStatus();
      } else if (this.missCount !== 0) {
        this.missCount = 0;
        this.emitStatus();
      }
      return null;
    }
    if (seed === this.currentSeed && !force) {
      if (this.state !== 'seedFound') {
        this.state = 'seedFound';
        this.emitStatus();
      }
      return null;
    }
    this.currentSeed = seed;
    this.state = 'seedFound';
    this.lastError = null;
    this.emit('seed', { seed, source: 'log', at: Date.now() });
    this.emitStatus();
    return seed;
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emitStatus();
  }

  status() {
    return {
      state: this.state,
      logPath: this.logPath,
      exists: existsSync(this.logPath),
      currentSeed: this.currentSeed,
      lastError: this.lastError,
      lastReadAt: this.lastReadAt,
      lastDeepScanAt: this.lastDeepScanAt || null,
      pollMs: this.pollMs,
      tailBytes: this.tailBytes,
      deepScanBytes: this.deepScanBytes,
    };
  }

  emitStatus() {
    this.emit('status', this.status());
  }
}
