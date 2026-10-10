/**
 * MapService：生成器封装 + LRU 缓存 + 版本闸门（§8.4）。
 * 一切计算在主进程（§5.2）。生成器是 vendored 的 Node ESM 包，用 file:// 动态 import。
 */
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export class MapService {
  /**
   * @param {object} opts
   * @param {string} opts.generatorEntry 生成器入口文件绝对路径（data/vendor/map-seed/src/index.js）
   * @param {number} [opts.cacheSize] LRU 容量
   */
  constructor({ generatorEntry, cacheSize = 32 }) {
    this.generatorEntry = generatorEntry;
    this.cacheSize = cacheSize;
    this.cache = new Map();
    this.mod = null;
    this.info = null;
    this.loadError = null;
    this.lastDurationMs = null;
    this.hits = 0;
    this.misses = 0;
  }

  get available() {
    return this.mod !== null;
  }

  async init() {
    try {
      if (!this.generatorEntry || !existsSync(this.generatorEntry)) {
        throw new Error(`生成器入口不存在: ${this.generatorEntry}`);
      }
      const url = pathToFileURL(this.generatorEntry).href;
      this.mod = await import(url);
      this.info = this.mod.getTemplateInfo();
      this.loadError = null;
    } catch (error) {
      this.mod = null;
      this.info = null;
      this.loadError = error.message;
    }
    return this.info;
  }

  cacheKey(seed, holiday) {
    const version = this.info?.gameVersion ?? 'unknown';
    return `${version}|${holiday ?? this.info?.activeHoliday ?? 'None'}|${seed}`;
  }

  /**
   * 生成（带缓存）。失败返回 null，由调用方广播 layout:error。
   * @returns {{map: object|null, cached: boolean, ms: number, error?: string}}
   */
  generate(seed, holiday = null) {
    if (!this.mod) {
      return { map: null, cached: false, ms: 0, error: this.loadError ?? '生成器不可用' };
    }
    const key = this.cacheKey(seed, holiday);
    if (this.cache.has(key)) {
      this.hits += 1;
      const map = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, map);
      return { map, cached: true, ms: 0 };
    }
    this.misses += 1;
    const started = Date.now();
    try {
      const map = this.mod.generateMap(seed, holiday ? { holiday } : undefined);
      const ms = Date.now() - started;
      this.lastDurationMs = ms;
      this.cache.set(key, map);
      while (this.cache.size > this.cacheSize) {
        this.cache.delete(this.cache.keys().next().value);
      }
      return { map, cached: false, ms };
    } catch (error) {
      return { map: null, cached: false, ms: Date.now() - started, error: error.message, stack: error.stack };
    }
  }

  stats() {
    return { hits: this.hits, misses: this.misses, size: this.cache.size, lastDurationMs: this.lastDurationMs };
  }
}
