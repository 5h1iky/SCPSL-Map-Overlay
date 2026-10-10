/**
 * HotkeyManager：注册全局热键 + 与游戏按键的冲突检测（§11.2）。
 *
 * 为什么默认用 Ctrl+数字（两键）：SCP:SL 大量占用字母键、F1–F12、Tab、Shift 组合（§11.1），
 * 但这些键都不带 Ctrl；Ctrl+数字 同时按只要两根手指，比原来的 Ctrl+Alt+数字 好按。
 * （更早的版本是三键 Ctrl+Alt+数字，老配置会被 migrateHotkeys 平滑迁移。）
 * 冲突检测读：
 *   %APPDATA%\SCP Secret Laboratory\keybinding.txt              （动作序号:KeyCode）
 *   %APPDATA%\SCP Secret Laboratory\registry.txt → CustomHotkeyDefinitions（AssignedKey）
 * 只能检测"基础键相同"，修饰键不明 —— 所以文案写"可能冲突"而不是"一定冲突"。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Unity KeyCode（只覆盖我们可能用到的） */
export const UNITY_KEYCODES = {
  0: 'None', 8: 'Backspace', 9: 'Tab', 13: 'Return', 27: 'Escape', 32: 'Space',
  48: 'Alpha0', 49: 'Alpha1', 50: 'Alpha2', 51: 'Alpha3', 52: 'Alpha4',
  53: 'Alpha5', 54: 'Alpha6', 55: 'Alpha7', 56: 'Alpha8', 57: 'Alpha9',
  96: 'Keypad0', 97: 'Keypad1', 98: 'Keypad2', 99: 'Keypad3', 100: 'Keypad4',
  101: 'Keypad5', 102: 'Keypad6', 103: 'Keypad7', 104: 'Keypad8', 105: 'Keypad9',
  127: 'Delete', 282: 'F1', 283: 'F2', 284: 'F3', 285: 'F4', 286: 'F5', 287: 'F6',
  288: 'F7', 289: 'F8', 290: 'F9', 291: 'F10', 292: 'F11', 293: 'F12',
  303: 'RightShift', 304: 'LeftShift', 305: 'RightControl', 306: 'LeftControl',
  307: 'RightAlt', 308: 'LeftAlt',
};
for (let i = 0; i < 26; i += 1) UNITY_KEYCODES[97 + i] = String.fromCharCode(97 + i);

const NAME_TO_CODE = Object.fromEntries(Object.entries(UNITY_KEYCODES).map(([code, name]) => [name.toLowerCase(), Number(code)]));
for (let i = 0; i <= 9; i += 1) NAME_TO_CODE[String(i)] = 48 + i;
NAME_TO_CODE.ctrl = 306;
NAME_TO_CODE.control = 306;
NAME_TO_CODE.alt = 308;
NAME_TO_CODE.shift = 304;
NAME_TO_CODE.esc = 27;
NAME_TO_CODE.enter = 13;
NAME_TO_CODE.space = 32;

export function defaultGameConfigDir(env = process.env) {
  const appData = env.APPDATA || join(env.USERPROFILE || homedir(), 'AppData', 'Roaming');
  return join(appData, 'SCP Secret Laboratory');
}

/** 'Control+Alt+1' → { modifiers: ['control','alt'], key: '1', keyCode: 49 } */
export function parseAccelerator(accelerator) {
  const parts = String(accelerator || '').split('+').map((p) => p.trim()).filter(Boolean);
  const key = parts.pop() ?? '';
  const modifiers = parts.map((p) => p.toLowerCase());
  const normalized = key.toLowerCase();
  const keyCode = normalized.startsWith('num') && normalized.length === 4
    ? NAME_TO_CODE[`keypad${normalized.slice(3)}`]
    : (NAME_TO_CODE[normalized] ?? null);
  return { raw: accelerator, modifiers, key, keyCode };
}

/* ── Electron accelerator 合法性 ────────────────────────────
   键名清单与官方 Accelerator 文档一致（大小写不敏感）：
   https://www.electronjs.org/docs/latest/api/accelerator */
const MODIFIER_TOKENS = new Set([
  'command', 'cmd', 'commandorcontrol', 'cmdorctrl', 'control', 'ctrl',
  'alt', 'option', 'altgr', 'shift', 'super', 'meta',
]);

const KEY_TOKENS = new Set([
  'plus', 'space', 'tab', 'capslock', 'numlock', 'scrolllock',
  'backspace', 'delete', 'insert', 'return', 'enter',
  'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
  'escape', 'esc', 'printscreen',
  'volumeup', 'volumedown', 'volumemute',
  'medianexttrack', 'mediaprevioustrack', 'mediastop', 'mediaplaypause',
  'numdec', 'numadd', 'numsub', 'nummult', 'numdiv',
]);
for (let i = 0; i <= 9; i += 1) { KEY_TOKENS.add(String(i)); KEY_TOKENS.add(`num${i}`); }
for (let i = 0; i < 26; i += 1) KEY_TOKENS.add(String.fromCharCode(97 + i));
for (let i = 1; i <= 24; i += 1) KEY_TOKENS.add(`f${i}`);
// 标点键直接用原字符（官方文档的 "Various Punctuation"）
for (const ch of ')!@#$%^&*(::;+=<,_->.?/~`[]|\\{}"') KEY_TOKENS.add(ch);

/** 单键 / 组合键的最大长度（用户要求 1–3 键） */
export const MAX_ACCEL_KEYS = 3;

/**
 * 校验 accelerator：1–3 键 = 0–2 个修饰键 + 恰好 1 个主键。
 * @returns {{ ok: boolean, reason: string|null, modifiers: string[], key: string|null, singleKey: boolean }}
 */
export function validateAccelerator(accelerator) {
  const fail = (reason) => ({ ok: false, reason, modifiers: [], key: null, singleKey: false });
  const raw = String(accelerator ?? '').trim();
  if (!raw) return fail('空的热键');
  const segments = raw.split('+');
  if (segments.some((t) => !t.trim())) return fail('组合键格式不对（多余的 +）');
  const tokens = segments.map((t) => t.trim());
  if (tokens.length > MAX_ACCEL_KEYS) return fail(`最多 ${MAX_ACCEL_KEYS} 键`);
  const modifiers = [];
  let key = null;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (MODIFIER_TOKENS.has(lower)) {
      modifiers.push(lower);
      if (modifiers.length > 2) return fail(`最多 2 个修饰键（总共 ${MAX_ACCEL_KEYS} 键以内）`);
      continue;
    }
    if (!KEY_TOKENS.has(lower)) return fail(`不支持的键：${token}`);
    if (key !== null) return fail('只能有一个主键');
    key = token;
  }
  if (key === null) return fail('还缺一个主键（不要只按修饰键）');
  return { ok: true, reason: null, modifiers, key, singleKey: modifiers.length === 0 };
}

/**
 * 把一次键盘录入翻译成 accelerator（供设置页录入用，主进程算、渲染进程只显示）。
 * @param {{ code: string, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean, metaKey?: boolean }} ev
 * @returns {{ action: 'set'|'cancel'|'clear'|'wait'|'reject', accelerator?: string, reason?: string, singleKey?: boolean }}
 */
export function captureAccelerator(ev) {
  const code = String(ev?.code ?? '');
  if (code === 'Escape') return { action: 'cancel' };
  if (code === 'Backspace' || code === 'Delete') return { action: 'clear' };
  if (/^(Control|Shift|Alt|Meta)(Left|Right)$/.test(code)) return { action: 'wait' };
  const key = acceleratorKeyOf(code);
  if (!key) return { action: 'reject', reason: `这个键不支持（${code || '未知'}）` };
  const modifiers = [];
  if (ev.ctrlKey) modifiers.push('Control');
  if (ev.altKey) modifiers.push('Alt');
  if (ev.shiftKey) modifiers.push('Shift');
  if (ev.metaKey) modifiers.push('Super');
  const accelerator = [...modifiers, key].join('+');
  const check = validateAccelerator(accelerator);
  if (!check.ok) return { action: 'reject', reason: check.reason };
  return { action: 'set', accelerator, singleKey: check.singleKey };
}

/** `event.code` → Electron accelerator 主键 token */
export function acceleratorKeyOf(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return CODE_TO_KEY[code] ?? null;
}

const CODE_TO_KEY = {
  Space: 'Space', Tab: 'Tab', Enter: 'Return', NumpadEnter: 'Return',
  Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  CapsLock: 'Capslock', NumLock: 'Numlock', ScrollLock: 'Scrolllock', PrintScreen: 'PrintScreen',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
  MediaPlayPause: 'MediaPlayPause', MediaStop: 'MediaStop',
  MediaTrackNext: 'MediaNextTrack', MediaTrackPrevious: 'MediaPreviousTrack',
  AudioVolumeUp: 'VolumeUp', AudioVolumeDown: 'VolumeDown', AudioVolumeMute: 'VolumeMute',
};

/** 解析 keybinding.txt：形如 `0:323;1:324;2:32;…` */
export function parseKeybindingFile(text) {
  const codes = new Set();
  for (const chunk of String(text || '').split(';')) {
    const [, value] = chunk.split(':');
    const n = Number(value);
    if (Number.isInteger(n)) codes.add(n);
  }
  return codes;
}

/** 解析 registry.txt 里的 CustomHotkeyDefinitions（AssignedKey 列表） */
export function parseRegistryHotkeys(text) {
  const codes = new Set();
  const source = String(text || '');
  const marker = 'CustomHotkeyDefinitions::-%(|::';
  const index = source.indexOf(marker);
  if (index < 0) return codes;
  const payload = source.slice(index + marker.length).split('\n')[0];
  for (const match of payload.matchAll(/"AssignedKey":\s*(\d+)/g)) {
    codes.add(Number(match[1]));
  }
  return codes;
}

export function readGameBindings(configDir = defaultGameConfigDir()) {
  const result = { keybinding: new Set(), custom: new Set(), files: [], notes: [] };
  const keybindingPath = join(configDir, 'keybinding.txt');
  const registryPath = join(configDir, 'registry.txt');
  if (existsSync(keybindingPath)) {
    try {
      result.keybinding = parseKeybindingFile(readFileSync(keybindingPath, 'utf8'));
      result.files.push(keybindingPath);
    } catch (error) {
      result.notes.push(`keybinding.txt 读取失败：${error.message}`);
    }
  } else {
    result.notes.push('未找到 keybinding.txt');
  }
  if (existsSync(registryPath)) {
    try {
      result.custom = parseRegistryHotkeys(readFileSync(registryPath, 'utf8'));
      result.files.push(registryPath);
    } catch (error) {
      result.notes.push(`registry.txt 读取失败：${error.message}`);
    }
  } else {
    result.notes.push('未找到 registry.txt');
  }
  return result;
}

/**
 * 冲突判定：基础键相同即提示"可能冲突"。
 * @returns {{ [action: string]: { accelerator, keyCode, conflict: boolean, note: string|null } }}
 */
export function detectConflicts(hotkeys, bindings) {
  const report = {};
  for (const [action, accelerator] of Object.entries(hotkeys ?? {})) {
    const parsed = parseAccelerator(accelerator);
    const inKeybinding = parsed.keyCode !== null && bindings.keybinding.has(parsed.keyCode);
    const inCustom = parsed.keyCode !== null && bindings.custom.has(parsed.keyCode);
    const hit = inKeybinding || inCustom;
    report[action] = {
      accelerator,
      keyCode: parsed.keyCode,
      conflict: hit,
      note: hit
        ? `游戏里也绑定了 ${UNITY_KEYCODES[parsed.keyCode] ?? parsed.keyCode}${inCustom ? '（自定义热键）' : ''}，修饰键不同时应无影响`
        : null,
    };
  }
  return report;
}

/**
 * 注册全局热键。register 返回 false 必须显式提示，不能静默（§11.2）。
 * 空值 = 用户用 Del 清空 / 禁用了该动作，直接跳过不注册。
 * @param {{ globalShortcut: object, hotkeys: object, handlers: object, logger?: object }} deps
 */
export function registerHotkeys({ globalShortcut, hotkeys, handlers, logger = null }) {
  const results = {};
  for (const [action, accelerator] of Object.entries(hotkeys ?? {})) {
    const handler = handlers[action];
    if (!handler) continue;
    if (!String(accelerator ?? '').trim()) {
      results[action] = { accelerator: '', ok: true, disabled: true, error: null };
      continue;
    }
    let ok = false;
    let error = null;
    try {
      ok = globalShortcut.register(accelerator, handler);
    } catch (e) {
      error = e.message;
    }
    results[action] = { accelerator, ok, error: ok ? null : (error ?? '注册失败（可能被系统或其他程序占用）') };
    if (!ok) logger?.warn('热键注册失败', { action, accelerator, error });
  }
  return results;
}
