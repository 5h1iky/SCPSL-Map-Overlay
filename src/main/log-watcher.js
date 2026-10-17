/**
 * LogWatcher：轮询 Player.log，一次读尾提取**四种**信号（v0.3.0 日志信号管线）。
 *
 * 从 seed-watcher.js 升级而来，向后兼容（`seed` 事件 / `status()` / `readNow` 等全部保留）。
 * 新增提取的信号（全部实测自本机 14.2.7 日志，见 research 笔记）：
 *
 *   1. seed      「Map seed is: N」                  —— 原有能力
 *   2. holiday   「Holiday type: None|Christmas|Halloween|AprilFools」
 *                 客户端本地节日标志；服务器强制节日时进服后会有新值，轮询天然跟上
 *   3. scene     「SceneLoaded N. Facility|NewMainMenu|Loader」
 *                 进设施 = 正在游戏；回 NewMainMenu = 离开 → 驱动"智能显隐"
 *   4. server    「Connection IP set to <ip>, port: <port>」
 *                 本局服务器（在种子行之前出现，时间序配对可靠）
 *   5. roundLive 「Round has been started」/「Round has been ended」（仅本地监听服日志，参考用）
 *
 * 实测坑（沿袭 seed-watcher 的四个，全部保留）：
 *  1. 目录项长度陈旧 → 不用文件大小判断，固定间隔直接读尾部固定字节数
 *  2. 编码 → 必须按 UTF-8 读
 *  3. 重复行（[T16] 前缀）→ 各信号一律取**最后一次**出现
 *  4. 文件轮转 → 用轮询而不是 FileSystemWatcher
 *
 * v0.3.0 新增的兜底：Player.log 找不到种子时回退读 **Player-prev.log**
 * （游戏重启会把旧日志滚到 prev；上一局的种子还在里面）。
 * 来源标注 'prev-log'，让 UI 能明确告诉用户"这是上一会话的种子"。
 */
import { EventEmitter } from 'node:events';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const SEED_PATTERN = /Map seed is:\s*(\d{1,10})/g;
export const SEED_MIN = 1;
export const SEED_MAX = 2147483647;

export const HOLIDAY_PATTERN = /Holiday type:\s*(None|Christmas|Halloween|AprilFools)/g;
/** 日志里的节日名 → 生成器 options.holiday 的取值（见 vendor/map-seed/src/index.d.ts） */
export const HOLIDAY_VALUES = {
  None: null,
  Christmas: 'Christmas',
  Halloween: 'Halloween',
  AprilFools: 'AprilFools',
};

/** 场景状态：Facility=正在设施里（游戏进行中），NewMainMenu=主菜单，Loader=加载中 */
export const SCENE_PATTERN = /SceneLoaded \d+\. (Loader|Facility|NewMainMenu)/g;
export const GAME_SCENE = 'Facility';
export const MENU_SCENE = 'NewMainMenu';

/** 本局服务器：`Connection IP set to 1.2.3.4, port: 7777`（进服时打印，在种子行之前） */
export const SERVER_PATTERN = /Connection IP set to ([0-9a-fA-F.:]+), port: (\d+)/g;

export function defaultPlayerLogPath(env = process.env) {
  const home = env.USERPROFILE || env.HOME || homedir();
  return join(home, 'AppData', 'LocalLow', 'Northwood', 'SCPSL', 'Player.log');
}

/** Player.log 的滚动副本（游戏重启时旧的挪到这里） */
export function prevLogPathFor(logPath) {
  return join(dirname(logPath), 'Player-prev.log');
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

/**
 * 取最后一次出现的节日，并区分「日志里根本没有这一行」和「这一行是 None」。
 * v0.3.1 修复：旧实现里 None 也返回 null，watcher 用 `holiday !== null` 判断，
 * 结果节日从 Christmas 切回 None 时永远清不掉（整局都用节日图，直到重启）。
 * @returns {{found: boolean, value: string|null}}
 */
export function findHoliday(text) {
  if (typeof text !== 'string' || text.length === 0) return { found: false, value: null };
  let match;
  let found = null;
  HOLIDAY_PATTERN.lastIndex = 0;
  while ((match = HOLIDAY_PATTERN.exec(text)) !== null) found = match[1];
  if (found === null) return { found: false, value: null };
  return { found: true, value: HOLIDAY_VALUES[found] ?? null };
}

/** 取最后一次出现的节日（None → null，表示"无节日"）；"没有这一行"也返回 null */
export function parseHoliday(text) {
  return findHoliday(text).value;
}

/** 取最后一次加载的场景名（Facility / NewMainMenu / Loader） */
export function parseScene(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  let match;
  let found = null;
  SCENE_PATTERN.lastIndex = 0;
  while ((match = SCENE_PATTERN.exec(text)) !== null) found = match[1];
  return found;
}

/** 取最后一次连接的服务器 `ip:port` */
export function parseServer(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  let match;
  let found = null;
  SERVER_PATTERN.lastIndex = 0;
  while ((match = SERVER_PATTERN.exec(text)) !== null) found = `${match[1]}:${match[2]}`;
  return found;
}

/** 一次解析全部信号（读一次文本，多个正则各跑一遍；日志小，代价可忽略） */
export function parseSignals(text) {
  return {
    seed: parseSeed(text),
    holiday: parseHoliday(text),
    scene: parseScene(text),
    server: parseServer(text),
  };
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

export class LogWatcher extends EventEmitter {
  constructor({
    logPath = null,
    pollMs = 500,
    tailBytes = 65536,
    deepScanBytes = 32 * 1024 * 1024,
    deepScanCooldownMs = 5000,
  } = {}) {
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
    this.seedSource = null;
    /** 当前生效的信号快照（seed/holiday/scene/server 各自独立变化） */
    this.signals = { seed: null, holiday: null, scene: null, server: null };
    this.state = 'idle';
    this.lastError = null;
    this.lastReadAt = null;
    this.lastDeepScanAt = 0;
    this.lastDeepScanResult = null;
    /** v0.3.1：深扫时顺带解析的节日信号（{found,value}），用于尾部没有节日行时兜底 */
    this.lastDeepScanHoliday = null;
    /** v0.3.1：节日深扫兜底只做一次（每次启动最多读一遍大文件） */
    this.holidayDeepScanned = false;
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
      // v0.3.1：同一次读取顺手解析节日，避免为了节日再读一遍 32MB
      this.lastDeepScanHoliday = findHoliday(text);
    } catch (error) {
      this.lastError = error.code || error.message;
      this.lastDeepScanResult = null;
      this.lastDeepScanHoliday = null;
    }
    return this.lastDeepScanResult;
  }

  /**
   * v0.3.0 兜底：Player.log 里没有种子时，读滚动副本 Player-prev.log。
   * 游戏重启会覆盖 Player.log，上一局的种子只存在于 prev 里。
   * @returns {{seed: number, source: 'prev-log'}|null}
   */
  prevLogSeed() {
    const prev = prevLogPathFor(this.logPath);
    if (!existsSync(prev)) return null;
    try {
      // prev 是上一次完整会话，尺寸可控（本机实测 16.5KB），直接全量读
      const { text } = readTail(prev, this.deepScanBytes);
      const seed = parseSeed(text);
      return seed === null ? null : { seed, source: 'prev-log' };
    } catch (error) {
      this.lastError = error.code || error.message;
      return null;
    }
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

    // ── 非 seed 信号：尾部读到就更新（尾部窗口 64KB 足够覆盖最近一次场景/服务器变化）──
    const holidaySignal = findHoliday(tail.text);
    let holidayFound = holidaySignal.found;
    let holidayValue = holidaySignal.value;
    /**
     * v0.3.1 兜底：节日行和种子行一样会滑出 64KB 尾部（实测种子行能到 126KB 外）。
     * 尾部没这行、且当前还没有节日时，做**一次**深扫（复用 deepScan，顺手解析节日）。
     * 只做一次：日志里节日活动是低频变化，没必要每 500ms 去读 32MB。
     */
    if (!holidayFound && this.signals.holiday === null && !this.holidayDeepScanned) {
      this.holidayDeepScanned = true;
      this.deepScan({ force: true });
      if (this.lastDeepScanHoliday?.found) {
        holidayFound = true;
        holidayValue = this.lastDeepScanHoliday.value;
      }
    }
    // found=false（日志里没有这一行）≠ None（明确的"无节日"）：后者要能把旧值清掉
    if (holidayFound && holidayValue !== this.signals.holiday) {
      this.signals.holiday = holidayValue;
      this.emit('holiday', { holiday: holidayValue, at: Date.now() });
      this.emitStatus();
    }
    const scene = parseScene(tail.text);
    if (scene !== null && scene !== this.signals.scene) {
      this.signals.scene = scene;
      this.emit('scene', { scene, inGame: scene === GAME_SCENE, at: Date.now() });
      this.emitStatus();
    }
    const server = parseServer(tail.text);
    if (server !== null && server !== this.signals.server) {
      this.signals.server = server;
      this.emit('server', { server, at: Date.now() });
      this.emitStatus();
    }

    // ── 种子（原有逻辑 + prev 兜底）─────────────────────────
    let seed = parseSeed(tail.text);
    let source = 'log';
    if (seed === null && (this.currentSeed === null || force)) {
      const deep = this.deepScan({ force });
      if (deep !== null) seed = deep;
    }
    if (seed === null && (this.currentSeed === null || force)) {
      // 深扫也没有 → 上一会话的日志里找（来源明确标 prev-log，UI 才能如实告诉用户）
      const prev = this.prevLogSeed();
      if (prev) {
        seed = prev.seed;
        source = 'prev-log';
      }
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
    this.signals.seed = seed;
    /** 最近一次种子的来源（'log' / 'prev-log'），供 UI 如实展示 */
    this.seedSource = source;
    this.state = 'seedFound';
    this.lastError = null;
    this.emit('seed', { seed, source, at: Date.now() });
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
      /** 最近一次种子的来源 */
      seedSource: this.seedSource ?? null,
      /** v0.3.0 信号快照：状态条/智能显隐用 */
      signals: { ...this.signals },
      /** 当前场景是否在设施里（游戏进行中） */
      inGame: this.signals.scene === GAME_SCENE,
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

/* ── 兼容层：seed-watcher.js 的老名字继续可用（CLI/测试/selftest 都在用） ── */
export const SeedWatcher = LogWatcher;
