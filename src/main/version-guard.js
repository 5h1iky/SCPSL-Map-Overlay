/**
 * VersionGuard：三份版本号比对（§13）。
 *  G 游戏版本 ← Player.log / ServerLogs\<端口>\Round *.txt 第 2 行
 *  T 模板版本 ← 生成器 getTemplateInfo().gameVersion
 *  P POI 表版本 ← poi-map-<版本>.json 文件名
 * 判定一律不阻止使用，只是明确告知（§13.2）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const VERSION_PATTERN = /Game version:\s*([0-9]+(?:\.[0-9]+)*)/;

export function parseGameVersion(text) {
  if (typeof text !== 'string') return null;
  const match = VERSION_PATTERN.exec(text);
  return match ? match[1] : null;
}

export function serverLogsRoot(env = process.env) {
  const appData = env.APPDATA || join(env.USERPROFILE || '', 'AppData', 'Roaming');
  return join(appData, 'SCP Secret Laboratory', 'ServerLogs');
}

/** 最新一份 Round 日志（按修改时间），没有返回 null */
export function latestRoundLog(root) {
  if (!existsSync(root)) return null;
  let best = null;
  for (const dir of safeReaddir(root)) {
    const full = join(root, dir);
    let entries;
    try {
      if (!statSync(full).isDirectory()) continue;
      entries = readdirSync(full).filter((name) => name.startsWith('Round ') && name.endsWith('.txt'));
    } catch {
      continue;
    }
    for (const name of entries) {
      const file = join(full, name);
      try {
        const mtime = statSync(file).mtimeMs;
        if (!best || mtime > best.mtime) best = { file, mtime };
      } catch { /* 忽略 */ }
    }
  }
  return best?.file ?? null;
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * 读游戏版本：优先 Player.log（更贴近当前会话），退回 ServerLogs 最新回合日志。
 * 读不到返回 { version: null, source: null }（§13.2 灰条）。
 */
export function readGameVersion({ playerLogPath = null, logsRoot = null } = {}) {
  if (playerLogPath && existsSync(playerLogPath)) {
    try {
      const head = readHead(playerLogPath, 64 * 1024);
      const version = parseGameVersion(head);
      if (version) return { version, source: 'Player.log', file: playerLogPath };
    } catch { /* 继续尝试 ServerLogs */ }
  }
  const root = logsRoot || serverLogsRoot();
  const file = latestRoundLog(root);
  if (file) {
    try {
      const head = readHead(file, 8 * 1024);
      const version = parseGameVersion(head);
      if (version) return { version, source: 'ServerLogs', file };
    } catch { /* 忽略 */ }
  }
  return { version: null, source: null, file: null };
}

function readHead(path, bytes) {
  const buffer = readFileSync(path);
  return buffer.subarray(0, Math.min(bytes, buffer.length)).toString('utf8');
}

export function normalizeVersion(version) {
  if (!version) return null;
  return String(version).replace(/\.+$/, '').trim();
}

/**
 * v0.3.4：游戏补丁版本兼容。
 * 地图模板只依赖 major.minor 的地图生成结构；14.2.7 → 14.2.8 这类补丁升级
 * 不应再标红。只有 major.minor 变化才视为模板可能不兼容。
 */
export function baseVersion(version) {
  const normalized = normalizeVersion(version);
  if (!normalized) return null;
  const parts = normalized.split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : parts[0];
}

export function compareBaseVersions(a, b) {
  const ba = baseVersion(a);
  const bb = baseVersion(b);
  if (!ba || !bb) return ba === bb ? 0 : 1;
  return compareVersions(ba, bb);
}

/** 主次版本比较：14.2.7 vs 14.2.7 → 0；14.3.0 > 14.2.7 → 1 */
export function compareVersions(a, b) {
  const pa = normalizeVersion(a)?.split('.').map(Number) ?? [];
  const pb = normalizeVersion(b)?.split('.').map(Number) ?? [];
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va > vb ? 1 : -1;
  }
  return 0;
}

/**
 * §13.2 判定表。
 * 返回 { level, code, text, stale }
 */
export function versionGate({ gameVersion, templateVersion, poiVersion }) {
  const g = normalizeVersion(gameVersion);
  const t = normalizeVersion(templateVersion);
  const p = normalizeVersion(poiVersion);
  if (!g) {
    return { level: 'info', code: 'GAME_VERSION_UNKNOWN', stale: false, text: '版本未知 · 按模板使用' };
  }
  if (!t) {
    return { level: 'warn', code: 'TEMPLATE_UNKNOWN', stale: true, text: '模板版本未知' };
  }
  if (compareBaseVersions(t, g) !== 0) {
    return {
      level: 'error',
      code: 'TEMPLATE_MISMATCH',
      stale: true,
      // 文案刻意压缩：状态栏空间有限，只保留两个关键版本号
      text: `模板 ${t} / 游戏 ${g}`,
    };
  }
  if (p && compareBaseVersions(p, t) !== 0) {
    return {
      level: 'warn',
      code: 'POI_TABLE_MISMATCH',
      stale: false,
      text: `POI ${p} / 模板 ${t}`,
    };
  }
  return { level: 'info', code: 'OK', stale: false, text: `v${g} · 兼容` };
}
