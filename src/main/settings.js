/**
 * 设置：默认值 + JSON 落盘 + 合并。
 * 纯逻辑部分（mergeDefaults / validateSettings）与 IO 分离，便于单测。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_HOTKEYS, LEGACY_HOTKEYS, DEFAULT_VISIBLE_PRESETS, STYLE, ROUTE_SELECTOR_FIELDS } from '../shared/constants.js';
import { validateAccelerator } from './hotkeys.js';

export const DEFAULT_SETTINGS = {
  version: 2,
  hotkeys: { ...DEFAULT_HOTKEYS },
  overlay: {
    opacity: STYLE.defaultOpacity,
    scaleIndex: STYLE.defaultScaleIndex,
    autoFit: true,
    /** 相对屏幕左上角的归一化位置（0..1），默认放在屏幕中下部 */
    anchor: { x: 0.5, y: 0.62 },
    /**
     * 覆盖层显示器（v0.3.0）：'auto' = 跟随 SCP:SL 游戏窗口所在屏（默认），
     * 'primary' = 固定主屏（老行为）。
     */
    display: 'auto',
    visibleOnStart: false,
    showLabels: true,
    /** 重要区域（SCP / 核心 / 安保 / 检查点）按分类上色；关掉则整张图同色剪影 */
    colorByCategory: true,
    /** 全设施视图是否显示地表（地表只有 1 个房间，显示为底部附录条） */
    showSurfaceBand: true,
    /**
     * 智能显隐（v0.3.0，默认**关**）：进设施场景自动显示覆盖层，回主菜单自动隐藏。
     * 默认关是因为它"替用户做决定"；开了之后手动 Ctrl+1 仍然随时可用。
     */
    smartVisibility: false,
  },
  seed: {
    manualOverride: null,
    logPath: null,
    persistLastSeed: true,
    lastSeed: null,
    /** 种子历史（v0.3.0）：[{seed, source, server, at}]，上限 20，同种子去重置顶 */
    history: [],
  },
  presets: [...DEFAULT_VISIBLE_PRESETS],
  /** 用户自定义路线：[{id,label,from,to,enabled}]，端点是与种子无关的选择器 */
  customRoutes: [],
  lastZone: 'LightContainment',
  autoStart: false,
  logLevel: 'info',
  noticeAcknowledged: false,
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 深合并：以 defaults 为骨架，overlay 只接受已知字段，避免脏数据进内存 */
export function mergeDefaults(defaults, patch) {
  if (!isPlainObject(patch)) return structuredCloneSafe(defaults);
  const out = structuredCloneSafe(defaults);
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in out)) continue;
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeDefaults(out[key], value);
    else if (value !== undefined) out[key] = value;
  }
  return out;
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

export function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function normalizeSettings(input) {
  const s = mergeDefaults(DEFAULT_SETTINGS, input);
  s.overlay.opacity = clampNumber(s.overlay.opacity, 0.3, 1, DEFAULT_SETTINGS.overlay.opacity);
  s.overlay.scaleIndex = Math.round(clampNumber(s.overlay.scaleIndex, 0, STYLE.scaleSteps.length - 1, STYLE.defaultScaleIndex));
  s.overlay.anchor = {
    x: clampNumber(s.overlay.anchor?.x, 0, 1, DEFAULT_SETTINGS.overlay.anchor.x),
    y: clampNumber(s.overlay.anchor?.y, 0, 1, DEFAULT_SETTINGS.overlay.anchor.y),
  };
  s.overlay.colorByCategory = s.overlay.colorByCategory !== false;
  s.overlay.showSurfaceBand = s.overlay.showSurfaceBand !== false;
  if (!Array.isArray(s.presets) || s.presets.length === 0) s.presets = [...DEFAULT_VISIBLE_PRESETS];
  s.presets = s.presets.filter((id) => typeof id === 'string');
  if (s.seed.manualOverride !== null) {
    const n = Number(s.seed.manualOverride);
    s.seed.manualOverride = Number.isInteger(n) && n >= 1 && n <= 2147483647 ? n : null;
  }
  s.overlay.smartVisibility = Boolean(s.overlay.smartVisibility);
  /** v0.3.0：跟随游戏窗口所在屏（auto）/ 固定主屏（primary） */
  s.overlay.display = s.overlay.display === 'primary' ? 'primary' : 'auto';
  s.seed.history = normalizeSeedHistory(s.seed.history);
  s.hotkeys = sanitizeHotkeys(migrateHotkeys(s.hotkeys));
  s.customRoutes = normalizeCustomRoutes(s.customRoutes);
  s.autoStart = Boolean(s.autoStart);
  s.noticeAcknowledged = Boolean(s.noticeAcknowledged);
  return s;
}

/**
 * 老配置的热键迁移：**只有整套热键都还是上一版默认值**时才换成新的两键默认，
 * 用户自己改过的一律保留（不能覆盖用户的显式选择）。
 */
export function migrateHotkeys(hotkeys) {
  const current = { ...DEFAULT_HOTKEYS, ...(hotkeys ?? {}) };
  const isLegacy = Object.keys(LEGACY_HOTKEYS).every((action) => current[action] === LEGACY_HOTKEYS[action]);
  return isLegacy ? { ...DEFAULT_HOTKEYS } : current;
}

/**
 * 热键清洗：
 * - `''` = 用户清空 / 禁用该动作，合法；
 * - 非法组合（超过 3 键、只有一个修饰键、不支持的键）→ 清空；
 * - 重复组合保留先出现的动作，后来的清空（否则第二个注册必败）。
 * 设置页在保存前会先提示，这里是最后一道防线。
 */
export function sanitizeHotkeys(hotkeys) {
  const out = {};
  const seen = new Map();
  for (const action of Object.keys(DEFAULT_HOTKEYS)) {
    const value = String(hotkeys?.[action] ?? '').trim();
    if (!value) { out[action] = ''; continue; }
    const check = validateAccelerator(value);
    const key = value.toLowerCase();
    if (!check.ok || seen.has(key)) { out[action] = ''; continue; }
    seen.set(key, action);
    out[action] = value;
  }
  return out;
}

const SELECTOR_LIMIT = 40;
const MAX_CUSTOM_ROUTES = 40;

function normalizeSelector(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const field of ROUTE_SELECTOR_FIELDS) {
    const list = raw[field];
    if (!Array.isArray(list)) continue;
    const clean = [...new Set(list.filter((v) => typeof v === 'string' && v.length > 0 && v.length <= 80))].slice(0, SELECTOR_LIMIT);
    if (clean.length > 0) out[field] = clean;
  }
  return Object.keys(out).length > 0 ? out : null;
}

const SEED_HISTORY_LIMIT = 20;

/**
 * 种子历史清洗（v0.3.0）：只留合法条目，同种子去重（保留最新），按时间倒序，上限 20。
 * 脏数据（非整数种子、超长 server 字符串）直接丢，绝不进内存。
 */
export function normalizeSeedHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Map();
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const seed = Number(entry.seed);
    if (!Number.isInteger(seed) || seed < 1 || seed > 2147483647) continue;
    const server = typeof entry.server === 'string' && entry.server.length > 0 && entry.server.length <= 64
      ? entry.server : null;
    const source = typeof entry.source === 'string' && ['log', 'prev-log', 'manual', 'cli', 'test'].includes(entry.source)
      ? entry.source : null;
    const at = Number.isFinite(entry.at) ? entry.at : 0;
    const prev = seen.get(seed);
    if (prev) {
      // 同种子 = 同一局：合并而不是覆盖，server/source 别丢（后写的优先，但空值不顶掉非空）
      seen.set(seed, {
        seed,
        source: source ?? prev.source,
        server: server ?? prev.server,
        at: Math.max(at, prev.at),
      });
    } else {
      seen.set(seed, { seed, source, server, at });
    }
  }
  return [...seen.values()]
    .sort((a, b) => b.at - a.at)
    .slice(0, SEED_HISTORY_LIMIT);
}

/** 自定义路线的清洗：坏数据直接丢掉，绝不把脏东西带进内存 */
export function normalizeCustomRoutes(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 64 ? entry.id : null;
    const from = normalizeSelector(entry.from);
    const to = normalizeSelector(entry.to);
    if (!id || !from || !to || seen.has(id)) continue;
    seen.add(id);
    const label = typeof entry.label === 'string' && entry.label.trim().length > 0
      ? entry.label.trim().slice(0, 80)
      : `${id} → ${id}`;
    out.push({ id, label, from, to, enabled: entry.enabled !== false });
    if (out.length >= MAX_CUSTOM_ROUTES) break;
  }
  return out;
}

export class Settings {
  constructor(filePath, defaults = DEFAULT_SETTINGS) {
    this.filePath = filePath;
    this.defaults = defaults;
    this.data = normalizeSettings(null);
    this.loadError = null;
  }

  load() {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf8');
        this.data = normalizeSettings(JSON.parse(raw));
      }
    } catch (error) {
      this.loadError = error.message;
      this.data = normalizeSettings(null);
    }
    return this.data;
  }

  save() {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
      return true;
    } catch (error) {
      this.loadError = error.message;
      return false;
    }
  }

  /**
   * R→M 的设置写入：**深合并**后归一化再落盘，返回归一化后的结果。
   *
   * ⚠️ 这里曾经是浅合并（`{...this.data, ...patch}`）：设置页提交
   * `{ hotkeys: { toggle: 'F6' } }` 会把其余 5 个热键整个抹掉、回落默认，
   * 表现为"改第二个键时第一个键被重置"。嵌套对象必须递归合并（数组整体替换）。
   */
  set(patch) {
    this.data = normalizeSettings(mergeDefaults(this.data, isPlainObject(patch) ? patch : {}));
    this.save();
    return this.data;
  }

  patch(path, value) {
    const keys = path.split('.');
    const next = structuredCloneSafe(this.data);
    let cursor = next;
    for (let i = 0; i < keys.length - 1; i += 1) {
      if (!isPlainObject(cursor[keys[i]])) cursor[keys[i]] = {};
      cursor = cursor[keys[i]];
    }
    cursor[keys.at(-1)] = value;
    return this.set(next);
  }
}
