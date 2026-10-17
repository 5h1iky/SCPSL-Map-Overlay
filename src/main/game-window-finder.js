/**
 * GameWindowFinder：定位 SCP:SL 游戏窗口所在的显示器（v0.3.0 多显示器跟随）。
 *
 * 背景（HANDOVER §P1 F16）：覆盖层原来固定画在主屏；游戏在副屏时用户得扭头。
 *
 * ⚠️ 实现选型（2026-10-17 实测三轮，写下来免得后人再踩）：
 *   方案① desktopCapturer.getSources({types:['window']}) —— **Windows 上不可用**：
 *     WGC 后端返回的 source.display_id 恒为空字符串（实测 window 类型 0/4 个有值；
 *     screen 类型才有值）。拿不到显示器，此路不通。
 *   方案② Electron 38 主进程 import desktopCapturer —— ESM 下还踩了
 *     `does not provide an export named` 的坑（Node 22 cjs-module-lexer 分析不出
 *     内置 electron 的命名导出），且即使 import 成功也①的问题。
 *   方案③ **PowerShell + Win32（选定）**：`FindWindow('SCP: Secret Laboratory')`
 *     → `GetWindowRect` → `MonitorFromRect(MONITOR_DEFAULTTONEAREST)` → `GetMonitorInfo`
 *     拿显示器设备名（如 `\\.\DISPLAY1`），与 screen.getAllDisplays() 的 label 对应。
 *     实测：execFile + .ps1 文件方式跑通（-EncodedCommand 方式被引号嵌套坑过，
 *     勿再尝试）；本机没开游戏时正确返回 NOTFOUND。
 *     代价：每次探测 fork 一个 powershell（约 300-800ms）—— 3 秒轮询一次可接受。
 *
 * 匹配规则：标题以 `SCP: Secret Laboratory` 开头（Unity productName，与语言无关）。
 * 我们自己的窗口标题是"SCP:SL 地图工具 · 设置"，不会被误匹配（实测确认）。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 游戏窗口标题（Unity productName） */
export const GAME_WINDOW_TITLE = 'SCP: Secret Laboratory';

/**
 * 显示器选择（v0.3.1 重新设计）：**不再定时探测游戏窗口**。
 *
 * 为什么推翻 v0.3.0 的“自动跟随”：
 *   要判断游戏窗口在哪块屏，只能问系统（PowerShell + Win32），实测单次 2.1–2.4 秒；
 *   每 3 秒一次 = 系统几乎一直在起 PowerShell，鼠标周期性卡顿、磁盘/CPU 被打满。
 *   而“游戏换屏”是极低频事件 —— 让用户在设置里选一块屏就够，换屏时点一次「定位游戏窗口」。
 *
 * 这个纯函数负责把「用户选的 displayId」解析成 Electron display：
 *   找得到 → 用它；找不到（显示器拔了/换机器）→ 主显示器；再没有 → 第一个。
 * @param {Array<{id:number,isPrimary?:boolean}>} displays screen.getAllDisplays()
 * @param {number|null} displayId 设置里存的 id；null = 主显示器
 * @returns {object|null}
 */
export function pickDisplay(displays, displayId = null) {
  if (!Array.isArray(displays) || displays.length === 0) return null;
  if (displayId !== null && displayId !== undefined) {
    const wanted = String(displayId);
    const match = displays.find((d) => String(d.id) === wanted);
    if (match) return match;
  }
  return displays.find((d) => d.isPrimary) ?? displays[0] ?? null;
}

/** 标题是否就是游戏窗口（大小写不敏感的前缀匹配，兼容 [beta] 等后缀） */
export function isGameWindowTitle(title) {
  return String(title ?? '').toLowerCase().startsWith(GAME_WINDOW_TITLE.toLowerCase());
}

const PS1_PATH = join(dirname(fileURLToPath(import.meta.url)), 'game-monitor.ps1');

/**
 * PowerShell 探测输出 → 结构化对象。
 * @param {string} stdout ps1 的输出：`设备名|L,T,R,B` / NOTFOUND / NORECT / NOINFO
 * @returns {{found:boolean, deviceName?:string, rect?:object, reason?:string}}
 */
export function parseMonitorOutput(stdout) {
  const line = String(stdout ?? '').trim().split('\n')[0].trim();
  if (!line) return { found: false, reason: 'EMPTY' };
  if (line === 'NOTFOUND') return { found: false, reason: 'NOTFOUND' };
  if (line === 'NORECT') return { found: false, reason: 'NORECT' };
  if (line === 'NOINFO') return { found: false, reason: 'NOINFO' };
  const bar = line.indexOf('|');
  if (bar < 0) return { found: false, reason: 'BAD_FORMAT' };
  const deviceName = line.slice(0, bar);
  const nums = line.slice(bar + 1).split(',').map((n) => Number(n.trim()));
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) return { found: false, reason: 'BAD_RECT' };
  return {
    found: true,
    deviceName,
    rect: { left: nums[0], top: nums[1], right: nums[2], bottom: nums[3] },
  };
}

/**
 * 探测游戏窗口所在显示器（fork powershell，约 300-800ms）。
 * @returns {Promise<{deviceName:string, rect:object}|null>} 没找到/失败返回 null
 */
export async function findGameWindow() {
  if (!existsSync(PS1_PATH)) return null;
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1_PATH],
      { timeout: 15000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(null); // PowerShell 不存在/超时/被拦 → 静默回退（=不跟随）
          return;
        }
        const parsed = parseMonitorOutput(stdout);
        resolve(parsed.found ? { deviceName: parsed.deviceName, rect: parsed.rect } : null);
      },
    );
  });
}

/**
 * 设备名 → Electron display 对象。
 * screen.getAllDisplays() 的 label 就是设备名（实测 `\\.\DISPLAY1` 形式一致）。
 * @returns {object|null} 匹配不上返回 null（保守：不动比乱跳好）
 */
export function resolveDisplay(displays, deviceName) {
  if (!Array.isArray(displays) || !deviceName) return null;
  // Windows 设备名形如 `\\.\DISPLAY1`（前缀 4 字符：\ \ . \）；screen 的 label 同形式。
  // 剥掉前缀后比较，并容忍大小写差异。缺前缀的纯 `DISPLAY1` 也能匹配。
  const norm = (s) => String(s ?? '').replace(/^\\\\\.\\/, '').toUpperCase();
  const target = norm(deviceName);
  return displays.find((d) => norm(d.label) === target) ?? null;
}

/**
 * 一步到位：游戏窗口当前所在的显示器（找不到游戏 → null）。
 * @param {object} [opts]
 * @param {object} [opts.screenApi] 由主进程注入 Electron 的 screen（避免在函数里 import 'electron'）
 * @returns {Promise<{display: object, deviceName: string, rect: object}|null>}
 */
export async function findGameDisplay({ screenApi = null } = {}) {
  const found = await findGameWindow();
  if (!found) return null;
  /**
   * ⚠️ Electron 38 + Node 22：动态 import('electron') 的命名导出不可靠
   * （HANDOVER-0.3.0 §1：内置 electron 是运行时构造的 CJS，cjs-module-lexer 分析不出来）。
   * 所以优先用调用方注入的 screen；只有单测/独立调用才回退动态 import，
   * 且回退时走 .default（与主进程同一套取法）。
   */
  let screen = screenApi;
  if (!screen) {
    const electron = await import('electron');
    screen = electron.default?.screen ?? electron.screen ?? null;
  }
  if (!screen) return null;
  const display = resolveDisplay(screen.getAllDisplays(), found.deviceName);
  if (!display) return null;
  return { display, deviceName: found.deviceName, rect: found.rect };
}
