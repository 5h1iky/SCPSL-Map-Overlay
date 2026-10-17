/**
 * Electron 主进程：应用生命周期、窗口、托盘、单实例锁、IPC（§8.1 / §15.1）。
 *
 * 分工原则（§5.2）：一切计算在主进程；渲染进程只收渲染就绪数据、只发 intent。
 *
 * ⚠️ electron 用**动态导入**：Electron 38 + Node 22 下内置 'electron' 是运行时构造的 CJS，
 * Node 的 cjs-module-lexer 静态分析不出命名导出，`import { app } from 'electron'` 直接
 * SyntaxError（2026-10-17 实测 `does not provide an export named 'BrowserWindow'`）。
 * 顶层 await 动态 import() 拿 default —— ESM 文档推荐模式，副作用仍先于 ready 事件。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const electron = await import('electron');
const {
  app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, Tray,
  dialog, nativeImage, screen, shell, desktopCapturer,
} = electron.default;

import { AppController } from './app-controller.js';
import { Logger } from './logger.js';
import { Settings } from './settings.js';
import { LogWatcher, defaultPlayerLogPath, validateSeed, prevLogPathFor } from './log-watcher.js';
import { readGameVersion, serverLogsRoot } from './version-guard.js';
import { detectConflicts, readGameBindings, registerHotkeys, defaultGameConfigDir, captureAccelerator } from './hotkeys.js';
import { HOTKEY_LABEL, ROUTE_PRESETS, STYLE, VIEW_LABEL, REPO_URL, RELEASES_URL } from '../shared/constants.js';
import { runVerify } from './verifier.js';
import { scheduleSelftest, selftestRequested } from './selftest.js';
import {
  findGameDisplay, shouldPollGameDisplay,
  DISPLAY_PROBE_INTERVAL_MS, DISPLAY_PROBE_BACKOFF_MS,
} from './game-window-finder.js';
import { describeSession } from './session-state.js';

/*
 * ⚠️ 启动前提：本机（装了 360 主动防御 ZhuDongFangYu）Chromium 沙箱起不来。
 *
 * 2026-10-06 对照实验结论：
 *   cmd + `--no-sandbox`            → 正常
 *   cmd + 不带该参数                 → 进程在**加载本脚本之前**就静默退出（无日志、无 userData）
 *   app.commandLine.appendSwitch    → 无效（沙箱初始化早于 JS）
 *   自举 spawn 再重启                → 无效（同上，JS 根本没跑）
 *   ELECTRON_DISABLE_SANDBOX=1      → **有效**（推荐用这一招，见 README「本机特殊情况」）
 *
 * 所以开关必须来自"进程启动时"，代码里补救不了。README 里给了三种可用启动方式：
 *   1) 桌面快捷方式（已带 --no-sandbox 参数）
 *   2) 用户级环境变量 ELECTRON_DISABLE_SANDBOX=1
 *   3) 兜底启动器 .cmd（走 WMI 在受限 Job 之外拉起，连 DSH 界面里的「打开」也能用）
 * 想彻底去掉这些绕路：把程序加进 360 的信任区，然后正常双击即可。
 */

const appRoot = app.getAppPath();
const dataDir = join(appRoot, 'data');
const generatorEntry = join(dataDir, 'vendor/map-seed/src/index.js');
const poiTablePath = join(dataDir, 'poi-map-14.2.7.json');
const iconManifestPath = join(dataDir, 'room-icons.json');
const preloadPath = join(appRoot, 'src/preload/overlay.cjs');

const COMPLIANCE_TEXT = `本工具做什么：
  · 只读取游戏自己写的日志（Player.log / ServerLogs）与按键配置文件（keybinding.txt / registry.txt）
  · 以置顶透明穿透窗口显示"基于种子的离线推算布局"
  · 只做静态布局 + 静态 POI 的路线计算

本工具不做什么：
  · 不读 / 不写游戏进程内存，不注入 DLL，不 hook
  · 不模拟键盘鼠标输入（包括不会自动帮你敲 seed）
  · 不修改 / 不拦截网络流量，不做代理
  · 不做"从我当前位置实时导航"（那需要游戏内坐标 → 只能读内存）
  · 文案与界面不使用"官方""SCP:SL 官方工具"，不使用官方 logo

公共服务器使用提醒：
  请自行确认所在服务器的规则是否允许使用外部地图辅助工具。
  本工具展示的是离线推算结果，不包含你的实时位置；是否使用由你自行判断并承担后果。`;

let logger = null;
let settings = null;
let controller = null;
let watcher = null;
let overlayWindow = null;
let settingsWindow = null;
let tray = null;
let hotkeyReport = {};
let editMode = false;
/** 热键录入中：临时注销全局热键，避免按键被 RegisterHotKey 抢走（否则录不进去） */
let captureMode = false;
let versionTimer = null;

/* ── 单实例锁 ────────────────────────────────────────────── */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showSettingsWindow();
  });
}

app.commandLine.appendSwitch('disable-renderer-backgrounding');

/* ── 广播 ────────────────────────────────────────────────── */
function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function statusPayload() {
  const status = controller.status();
  const watcherStatus = watcher?.status() ?? null;
  return {
    status: {
      ...status,
      /** v0.3.1：设置页教程与悬浮窗状态条共用的这局状态（场景/服务器/节日/是否该敲 seed） */
      session: describeSession({ watcher: watcherStatus, seed: status.seed, seedSource: status.seedSource }),
      hotkeys: settings.data.hotkeys,
    },
    watcher: watcherStatus,
    hotkeyReport,
  };
}

function broadcastStatus() {
  broadcast('app:status', statusPayload());
}

/* ── 窗口 ────────────────────────────────────────────────── */
/** 覆盖层当前所在的显示器 id（v0.3.0 多显示器跟随用；null = 还没决定） */
let currentDisplayId = null;
/**
 * 下一次探测的定时器。v0.3.1 从 setInterval 改成**递归 setTimeout**：
 * 永远只有一轮在排队，不会出现「上一轮还没回来、下一轮又起一个 PowerShell」。
 */
let displayFollowTimer = null;
/** 同一时刻只允许一个探测在飞（v0.3.1：实测单次探测 2.1–2.4 秒，3 秒定时器必然叠加） */
let displayProbeInFlight = false;

function createOverlayWindow() {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;
  currentDisplayId = String(display.id);
  overlayWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    acceptFirstMouse: true,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.loadFile(join(appRoot, 'src/renderer/overlay/index.html'));
  overlayWindow.on('closed', () => { overlayWindow = null; });
  overlayWindow.webContents.on('did-finish-load', () => {
    overlayWindow.webContents.send('overlay:state', overlayState());
    if (controller?.lastLayout) overlayWindow.webContents.send('layout:ready', controller.lastLayout);
    overlayWindow.webContents.send('app:status', statusPayload());
  });
  return overlayWindow;
}

/**
 * v0.3.0：把覆盖层移到指定显示器（游戏窗口所在屏）。
 * 单显示器 / 同一个屏 / 找不到游戏 → 什么都不做（不乱跳）。
 *
 * v0.3.1：加 in-flight 锁。实测探测器单次 2.1–2.4 秒（PowerShell + Add-Type 编译 C#），
 * 原来 3 秒的 setInterval 会在探测没回来时再起一个进程，进程越叠越多 —— 这是鼠标卡顿的放大器。
 */
async function followGameDisplay({ force = false } = {}) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return null;
  if (!force && settings.data.overlay.display !== 'auto') return null;
  if (displayProbeInFlight) return null;
  displayProbeInFlight = true;
  try {
    const found = await findGameDisplay({ screenApi: screen });
    if (!found) return null;
    const targetId = String(found.display.id);
    if (targetId === currentDisplayId) return found.display;
    const { x, y, width, height } = found.display.bounds;
    overlayWindow.setBounds({ x, y, width, height });
    currentDisplayId = targetId;
    logger?.info?.('覆盖层跟随游戏窗口换屏', { displayId: targetId, label: found.display.label });
    // 换屏后 DPI 可能不同：让渲染进程重新量一次（overlay.js 的 dpr 轮询兜底）
    pushOverlayState();
    return found.display;
  } catch (error) {
    logger?.warn?.('跟随游戏显示器失败', { error: error.message });
    return null;
  } finally {
    displayProbeInFlight = false;
  }
}

/** 排下一轮探测。单屏 / 固定主屏时**不排**（v0.3.1 卡顿修复的关键）。 */
function scheduleDisplayProbe(delay = 0) {
  if (displayFollowTimer) {
    clearTimeout(displayFollowTimer);
    displayFollowTimer = null;
  }
  if (!settings) return;
  if (settings.data.overlay.display !== 'auto') return;
  if (screen.getAllDisplays().length <= 1) return;
  displayFollowTimer = setTimeout(runDisplayProbe, Math.max(0, delay));
  displayFollowTimer.unref?.();
}

/**
 * 一轮探测。
 * 只有「多屏 + auto + 覆盖层可见」才会真正 fork PowerShell；
 * 隐藏时直接不排（重新显示时 setOverlayVisible 会立刻补一次）。
 */
async function runDisplayProbe() {
  displayFollowTimer = null;
  if (!settings) return;
  if (settings.data.overlay.display !== 'auto') return;
  if (screen.getAllDisplays().length <= 1) return;
  if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) return;
  const started = Date.now();
  let found = null;
  try {
    found = await followGameDisplay();
  } finally {
    // 探到游戏：30 秒后再看；没探到：退避到 2 分钟（游戏没开时没必要一直起进程）
    logger?.debug?.('显示器跟随探测', { ms: Date.now() - started, found: Boolean(found) });
    scheduleDisplayProbe(found ? DISPLAY_PROBE_INTERVAL_MS : DISPLAY_PROBE_BACKOFF_MS);
  }
}

/** 启动/关闭跟随探测（设置里的 display 开关 + 显示器增删时重判） */
function wireDisplayFollow() {
  if (displayFollowTimer) {
    clearTimeout(displayFollowTimer);
    displayFollowTimer = null;
  }
  if (!settings) return;
  if (settings.data.overlay.display !== 'auto') return;
  if (screen.getAllDisplays().length <= 1) {
    // 单屏：这条功能没有任何意义 → 一次 PowerShell 都不起
    logger?.info?.('单显示器：不启用游戏窗口跟随探测');
    return;
  }
  scheduleDisplayProbe(1200);
}

/** 切回 primary 模式：把覆盖层移回主屏（用户显式选的固定行为） */
function resetOverlayToPrimary() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.bounds;
  overlayWindow.setBounds({ x, y, width, height });
  currentDisplayId = String(display.id);
  pushOverlayState();
}

function overlayState() {
  return {
    visible: overlayWindow ? overlayWindow.isVisible() : false,
    opacity: settings.data.overlay.opacity,
    scale: controller?.scale ?? 1,
    scaleIndex: settings.data.overlay.scaleIndex,
    autoFit: settings.data.overlay.autoFit,
    anchor: settings.data.overlay.anchor,
    showLabels: settings.data.overlay.showLabels,
    /** 重要区域按分类上色（关掉 = 整张图同色剪影） */
    colorByCategory: settings.data.overlay.colorByCategory,
    /** v0.3.0：多显示器跟随开关（渲染端据此决定是否监听 dpr 变化） */
    display: settings.data.overlay.display,
    editMode,
    fitHeightRatio: STYLE.fitHeightRatio,
  };
}

function pushOverlayState() {
  broadcast('overlay:state', overlayState());
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) return settingsWindow;
  settingsWindow = new BrowserWindow({
    width: 1020,
    height: 760,
    show: false,
    title: 'SCP:SL 地图工具 · 设置',
    backgroundColor: '#0d1015',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow.loadFile(join(appRoot, 'src/renderer/settings/index.html'));
  settingsWindow.on('closed', () => {
    settingsWindow = null;
    // 录入热键途中关窗也要把全局热键恢复回去，否则热键一直失效
    if (captureMode) {
      captureMode = false;
      wireHotkeys();
    }
  });
  return settingsWindow;
}

function showSettingsWindow() {
  const win = createSettingsWindow();
  if (!win.isVisible()) win.show();
  win.focus();
}

/* ── 覆盖层显示控制 ──────────────────────────────────────── */
function setOverlayVisible(visible) {
  if (!overlayWindow) return;
  if (visible) {
    overlayWindow.showInactive();
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    // v0.3.1：隐藏期间不做跨进程探测，重新显示时立刻补一次（多屏才需要）
    if (settings?.data?.overlay?.display === 'auto' && screen.getAllDisplays().length > 1) {
      scheduleDisplayProbe(300);
    }
  } else {
    overlayWindow.hide();
  }
  pushOverlayState();
}

function toggleOverlay() {
  setOverlayVisible(!(overlayWindow?.isVisible() ?? false));
}

function setEditMode(enabled) {
  editMode = Boolean(enabled);
  if (!overlayWindow) return;
  overlayWindow.setIgnoreMouseEvents(!editMode, { forward: true });
  overlayWindow.setFocusable(editMode);
  pushOverlayState();
}

/* ── 种子流水线 ──────────────────────────────────────────── */
/**
 * v0.3.0：种子历史（设置里 seed.history，上限 20，同种子去重置顶）。
 * 与日志/手动来源无关，只要成功算出布局就记一笔。
 */
function recordSeedHistory(seed, source, server = null) {
  if (!settings?.data?.seed) return;
  const list = [...(settings.data.seed.history ?? [])];
  const entry = { seed, source, server, at: Date.now() };
  const rest = list.filter((e) => e?.seed !== seed);
  settings.patch('seed.history', [entry, ...rest].slice(0, 20));
}

function handleSeed(seed, source, { holiday = null } = {}) {
  if (!seed) return { ok: false, changed: false, error: '没有可用的种子' };
  const result = controller.setSeed(seed, source, holiday);
  if (result.ok) {
    logger.info('种子已切换', { seed, source, holiday: holiday ?? 'None', ms: result.ms, cached: result.cached });
    broadcast('seed:changed', { seed, source, holiday: holiday ?? null, at: Date.now() });
    // v0.3.0 行为修正：日志出现新种子 = 用户已经在玩新的一局，
    // 旧的手动固定值不再有意义（留着它会让下次启动回到过时布局）→ 自动清除。
    if (source !== 'manual' && settings.data.seed.manualOverride) {
      settings.patch('seed.manualOverride', null);
      logger.info('日志出现新种子，已清除过时的手动固定种子');
    }
    if (settings.data.seed.persistLastSeed) settings.patch('seed.lastSeed', seed);
    recordSeedHistory(seed, source, watcher?.signals?.server ?? null);
  } else {
    broadcast('layout:error', { code: 'GEN_FAILED', message: '布局生成失败', detail: result.error });
  }
  return result;
}

/* ── 托盘 ────────────────────────────────────────────────── */
function trayIcon() {
  const iconPath = join(appRoot, 'assets/icon.png');
  if (existsSync(iconPath)) {
    const image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) return image.resize({ width: 16, height: 16 });
  }
  return nativeImage.createEmpty();
}

function buildTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('SCP:SL 地图工具');
  refreshTrayMenu();
  tray.on('double-click', () => showSettingsWindow());
}

function refreshTrayMenu() {
  if (!tray) return;
  const status = controller.status();
  const seed = status.seed ?? '—';
  // v0.3.0：最近种子子菜单（top 5，点击即切）
  const history = (settings.data.seed.history ?? []).slice(0, 5);
  const seedHistoryMenu = history.length > 0
    ? [
      { label: '最近的种子', enabled: false },
      ...history.map((entry) => ({
        label: `${entry.seed}${entry.server ? `（${entry.server}）` : ''}`,
        click: () => handleSeed(entry.seed, 'manual', { holiday: watcher?.signals?.holiday ?? null }),
      })),
    ]
    : [{ label: '最近的种子（空）', enabled: false }];
  const menu = Menu.buildFromTemplate([
    { label: `显示 / 隐藏覆盖层${settings.data.hotkeys.toggle ? `（${settings.data.hotkeys.toggle}）` : ''}`, click: () => toggleOverlay() },
    { label: `当前种子：${seed}（点击复制）`, click: () => { if (status.seed) clipboard.writeText(String(status.seed)); } },
    { label: `本局服务器：${watcher?.signals?.server ?? '—'}`, enabled: false },
    { label: `场景：${watcher?.signals?.scene === 'Facility' ? '🎮 游戏进行中' : watcher?.signals?.scene === 'NewMainMenu' ? '🏠 主菜单' : '—'}`, enabled: false },
    ...seedHistoryMenu,
    { type: 'separator' },
    { label: `视图：${VIEW_LABEL[status.viewZone] ?? status.viewZone}`, enabled: false },
    { label: `路线：${status.route?.presetLabel ?? '无'}`, enabled: false },
    { type: 'separator' },
    { label: '设置…', click: () => showSettingsWindow() },
    { label: '重新读取种子', click: () => { watcher?.readNow({ force: true }); } },
    { label: '导出当前地图 PNG', click: () => requestExportPng() },
    { label: '编辑模式（取消鼠标穿透）', type: 'checkbox', checked: editMode, click: (item) => setEditMode(item.checked) },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

/* ── IPC ─────────────────────────────────────────────────── */
function registerIpc() {
  ipcMain.on('intent:ready', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    win.webContents.send('app:status', statusPayload());
    win.webContents.send('overlay:state', overlayState());
    if (controller.lastLayout) win.webContents.send('layout:ready', controller.lastLayout);
  });

  ipcMain.handle('app:getStatus', () => ({
    ...statusPayload(),
    settings: settings.data,
    meta: {
      hotkeyLabels: HOTKEY_LABEL,
      presets: ROUTE_PRESETS,
      /** 自定义路线可选的端点清单（与种子无关，随时可编辑） */
      routeTargets: controller.routeTargets(),
      /** 类别短名（自定义路线列表里显示 kind 用） */
      kindLabels: Object.fromEntries(Object.entries(controller.poiTable?.kinds ?? {}).map(([k, v]) => [k, v?.label || k])),
      scaleSteps: STYLE.scaleSteps,
      complianceText: COMPLIANCE_TEXT,
      settingsPath: settings.filePath,
      defaultLogPath: defaultPlayerLogPath(),
      noticeAcknowledged: settings.data.noticeAcknowledged,
      appVersion: app.getVersion(),
      /** v0.3.1：设置页「GitHub 仓库」按钮用；主进程白名单里也只认这两个地址 */
      repoUrl: REPO_URL,
      releasesUrl: RELEASES_URL,
      dataDir,
    },
  }));

  ipcMain.handle('settings:get', () => settings.data);
  ipcMain.handle('settings:set', (_event, patch) => {
    const hotkeysChanged = Boolean(patch?.hotkeys);
    const noticeJustAcknowledged = patch?.noticeAcknowledged === true && !settings.data.noticeAcknowledged;
    const routesChanged = patch?.customRoutes !== undefined;
    const presetsChanged = patch?.presets !== undefined;
    settings.set(patch ?? {});
    logger?.setLevel(settings.data.logLevel);
    if (hotkeysChanged && !captureMode) {
      globalShortcut.unregisterAll();
      wireHotkeys();
    }
    if (noticeJustAcknowledged) {
      // 读完须知就先把覆盖层亮出来，用户才知道这东西长什么样
      settings.patch('overlay.visibleOnStart', true);
      setOverlayVisible(true);
    }
    // 改了自定义路线：立刻在当前种子上重算（用户改完就能看到效果）
    if ((routesChanged || presetsChanged) && controller.map) {
      const stillThere = controller.routePresetId && controller.routeById(controller.routePresetId);
      controller.selectRoute(stillThere ? controller.routePresetId : controller.defaultPresetId());
    }
    applySettingsSideEffects();
    broadcastStatus();
    return { settings: settings.data, ...statusPayload() };
  });

  ipcMain.handle('intent:setView', (_event, { zone }) => { controller.setView(zone); return statusPayload(); });
  ipcMain.handle('intent:cycleView', (_event, { direction = 1 } = {}) => { controller.cycleView(direction); return statusPayload(); });
  ipcMain.handle('intent:setRoute', (_event, target) => { controller.selectRoute(target?.presetId ?? target); return statusPayload(); });
  ipcMain.handle('intent:cycleRoute', (_event, { direction = 1 } = {}) => { controller.cycleRoute(direction); return statusPayload(); });
  ipcMain.handle('intent:setScaleIndex', (_event, { index }) => { controller.setScaleIndex(index); pushOverlayState(); return statusPayload(); });
  ipcMain.handle('intent:cycleScale', (_event, { direction = 1 } = {}) => { controller.cycleScale(direction); pushOverlayState(); return statusPayload(); });
  ipcMain.handle('intent:setSeed', (_event, { seed }) => {
    const value = validateSeed(seed);
    if (!value) return { ...statusPayload(), error: '种子必须是 1 – 2147483647 的整数' };
    settings.patch('seed.manualOverride', value);
    handleSeed(value, 'manual', { holiday: watcher?.signals?.holiday ?? null });
    return statusPayload();
  });
  ipcMain.handle('intent:rereadSeed', () => {
    watcher.readNow({ force: true });
    return statusPayload();
  });
  ipcMain.handle('intent:setOverlay', (_event, patch = {}) => {
    if (patch.toggleVisible) toggleOverlay();
    if (patch.opacity !== undefined) settings.patch('overlay.opacity', patch.opacity);
    if (patch.autoFit !== undefined) settings.patch('overlay.autoFit', patch.autoFit);
    if (patch.showLabels !== undefined) settings.patch('overlay.showLabels', patch.showLabels);
    if (patch.colorByCategory !== undefined) settings.patch('overlay.colorByCategory', patch.colorByCategory);
    if (patch.smartVisibility !== undefined) settings.patch('overlay.smartVisibility', Boolean(patch.smartVisibility));
    const bandChanged = patch.showSurfaceBand !== undefined
      && Boolean(patch.showSurfaceBand) !== settings.data.overlay.showSurfaceBand;
    if (patch.showSurfaceBand !== undefined) settings.patch('overlay.showSurfaceBand', Boolean(patch.showSurfaceBand));
    if (patch.anchor) settings.patch('overlay.anchor', patch.anchor);
    if (patch.scaleIndex !== undefined) settings.patch('overlay.scaleIndex', patch.scaleIndex);
    if (patch.editMode !== undefined) setEditMode(patch.editMode);
    // 全设施视图的地表开关会影响分带排布 → 重新出图
    if (bandChanged) controller.buildLayoutNow();
    // 显示器跟随开关变了 → 起停轮询（primary 模式立即换回主屏）
    if (patch.display !== undefined && patch.display !== settings.data.overlay.display) {
      settings.patch('overlay.display', patch.display === 'primary' ? 'primary' : 'auto');
      wireDisplayFollow();
      if (patch.display === 'primary') resetOverlayToPrimary();
    }
    pushOverlayState();
    return { settings: settings.data, ...statusPayload() };
  });

  /** 热键录入：进入时临时注销全局热键（否则按键被 RegisterHotKey 抢走，录不进去） */
  ipcMain.handle('intent:setCapture', (_event, { enabled } = {}) => {
    const next = Boolean(enabled);
    if (next === captureMode) return statusPayload();
    captureMode = next;
    if (captureMode) globalShortcut.unregisterAll();
    else wireHotkeys();
    return statusPayload();
  });

  /** 热键录入：把一次按键翻译成 accelerator（判定逻辑在 hotkeys.js，可单测） */
  ipcMain.handle('intent:captureKey', (_event, ev) => captureAccelerator(ev ?? {}));
  /** v0.3.0：设置页的「导出 PNG」按钮 —— 转告 overlay 渲染进程去合成（与热键同路） */
  ipcMain.handle('intent:exportPng', () => { requestExportPng(); return { ok: true }; });
  ipcMain.handle('intent:setPresets', (_event, { presets }) => {
    settings.patch('presets', Array.isArray(presets) && presets.length > 0 ? presets : settings.defaults.presets);
    return { settings: settings.data, ...statusPayload() };
  });
  ipcMain.handle('intent:listPois', () => controller.pois);
  ipcMain.handle('intent:openLogFolder', () => {
    shell.openPath(join(app.getPath('userData'), 'logs'));
  });
  /**
   * v0.3.1：外部链接收成**白名单**。
   * 原来任何 http(s) URL 都会直接 shell.openExternal —— 渲染进程一旦被注入，
   * 就等于拿到一个"任意 URL 打开器"。现在只允许 README 与仓库/Releases 两个地址。
   */
  ipcMain.handle('intent:openExternal', (_event, { url } = {}) => {
    if (url === 'README.md') {
      shell.openPath(join(appRoot, 'README.md'));
      return { ok: true };
    }
    if (url === REPO_URL || url === RELEASES_URL) {
      shell.openExternal(url);
      return { ok: true };
    }
    logger?.warn?.('拒绝打开未授权链接', { url: String(url ?? '').slice(0, 200) });
    return { ok: false, error: 'URL_NOT_ALLOWED' };
  });

  ipcMain.handle('app:quit', () => { app.isQuitting = true; app.quit(); });
  ipcMain.handle('app:pickLogFile', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 Player.log',
      defaultPath: defaultPlayerLogPath(),
      properties: ['openFile'],
      filters: [{ name: '日志', extensions: ['log', 'txt'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  /**
   * v0.3.0 导出 PNG：渲染进程把主画布 + 状态条合成 dataURL 传上来，主进程负责
   * 「存哪」（保存对话框 + 落盘）。文件名带种子/视图/日期，方便分享时对得上局。
   */
  ipcMain.handle('app:exportPng', async (_event, { dataUrl, suggestedName } = {}) => {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
      return { ok: false, error: '渲染进程没有给出有效的 PNG 数据' };
    }
    const status = controller.status();
    const defaultName = suggestedName
      || `scpsl-map-${status.seed ?? 'noseed'}-${status.viewZone ?? 'All'}-${new Date().toISOString().slice(0, 10)}.png`;
    const result = await dialog.showSaveDialog(settingsWindow ?? overlayWindow ?? null, {
      title: '导出地图 PNG',
      defaultPath: join(app.getPath('pictures') || app.getPath('home'), defaultName),
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
      const buffer = Buffer.from(dataUrl.split(',')[1], 'base64');
      writeFileSync(result.filePath, buffer);
      logger.info('导出 PNG', { file: result.filePath, bytes: buffer.length });
      return { ok: true, file: result.filePath, bytes: buffer.length };
    } catch (error) {
      logger.warn('导出 PNG 失败', { error: error.message });
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('app:openSettings', () => { showSettingsWindow(); });
  ipcMain.handle('app:setAutoStart', (_event, { enabled }) => {
    settings.patch('autoStart', Boolean(enabled));
    applyAutoStart();
    return settings.data;
  });

  ipcMain.handle('verify:run', async (_event, { seeds = null } = {}) => {
    const report = await runVerify({ appRoot, seeds });
    return report;
  });
}

function applyAutoStart() {
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(settings.data.autoStart), path: process.execPath, args: [] });
  } catch (error) {
    logger?.warn('开机自启设置失败', { error: error.message });
  }
}

function applySettingsSideEffects() {
  if (watcher && watcher.logPath !== (settings.data.seed.logPath || defaultPlayerLogPath())) {
    watcher.setLogPath(settings.data.seed.logPath || defaultPlayerLogPath());
    watcher.readNow({ force: true });
  }
  applyAutoStart();
  pushOverlayState();
}

/* ── 热键 ────────────────────────────────────────────────── */
/**
 * v0.3.0：触发热键导出。主进程发 `export:requested`，overlay 渲染进程合成
 * 面板区域的 dataURL 回传（走 app:exportPng handler 落盘）。
 * 覆盖层隐藏时也能导（用离屏数据合成），但窗口不存在就无能为力。
 */
function requestExportPng() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    logger?.warn('导出失败：覆盖层窗口不存在');
    return;
  }
  overlayWindow.webContents.send('export:requested');
}

function wireHotkeys() {
  const bindings = readGameBindings(defaultGameConfigDir());
  const conflicts = detectConflicts(settings.data.hotkeys, bindings);
  const registration = registerHotkeys({
    globalShortcut,
    hotkeys: settings.data.hotkeys,
    handlers: {
      toggle: () => toggleOverlay(),
      cycleView: () => controller.cycleView(1),
      cycleRoute: () => controller.cycleRoute(1),
      cycleScale: () => { controller.cycleScale(1); pushOverlayState(); },
      rereadSeed: () => { watcher.readNow({ force: true }); },
      editMode: () => setEditMode(!editMode),
      exportPng: () => requestExportPng(),
    },
    logger,
  });
  hotkeyReport = {};
  for (const action of Object.keys(settings.data.hotkeys)) {
    hotkeyReport[action] = {
      accelerator: settings.data.hotkeys[action],
      ok: registration[action]?.ok ?? false,
      disabled: registration[action]?.disabled ?? false,
      error: registration[action]?.error ?? null,
      conflict: conflicts[action]?.conflict ?? false,
      note: conflicts[action]?.note ?? null,
    };
  }
  broadcast('hotkey:conflict', hotkeyReport);
  if (bindings.notes.length) logger.info('按键配置读取情况', bindings.notes);
  const failed = Object.entries(hotkeyReport).filter(([, r]) => r.ok === false);
  if (failed.length) logger.warn('有热键注册失败', failed.map(([k, v]) => `${k}: ${v.error}`));
}

/* ── 启动 ────────────────────────────────────────────────── */
async function bootstrap() {
  settings = new Settings(join(app.getPath('userData'), 'settings.json'));
  settings.load();
  logger = new Logger(join(app.getPath('userData'), 'logs'), { level: settings.data.logLevel });
  logger.info('启动', { version: app.getVersion(), electron: process.versions.electron, settings: settings.filePath });

  controller = new AppController({ generatorEntry, poiTablePath, iconManifestPath, logger, settings });
  const init = await controller.init();
  if (!init.info) {
    broadcast('layout:error', { code: 'GENERATOR_UNAVAILABLE', message: '生成器不可用', detail: controller.mapService.loadError });
  }
  controller.on('layout', (layout) => broadcast('layout:ready', layout));
  controller.on('status', () => { broadcastStatus(); refreshTrayMenu(); });
  controller.on('error', (payload) => broadcast('layout:error', payload));

  const game = readGameVersion({ playerLogPath: settings.data.seed.logPath || defaultPlayerLogPath(), logsRoot: serverLogsRoot() });
  controller.setGameVersion(game.version, game.source);
  logger.info('版本闸门', controller.banner);

  createOverlayWindow();
  createSettingsWindow();
  buildTray();
  registerIpc();
  wireHotkeys();

  // v0.3.1：显示器热插拔 / 分辨率变化 → 重新判断要不要跟随（监听只注册一次，
  // 否则每次改设置都会叠加一个监听器 —— v0.3.0 的旧写法有这个问题）。
  screen.on('display-metrics-changed', () => { wireDisplayFollow(); });
  screen.on('display-added', () => { wireDisplayFollow(); });
  screen.on('display-removed', () => { wireDisplayFollow(); });
  wireDisplayFollow();

  watcher = new LogWatcher({ logPath: settings.data.seed.logPath || defaultPlayerLogPath() });
  watcher.on('seed', ({ seed, source }) => handleSeed(seed, source, { holiday: watcher.signals.holiday }));
  watcher.on('holiday', ({ holiday }) => {
    // 节日活动会改布局：种子不变也要重新生成（app-controller.setHoliday）
    const changed = controller.setHoliday(holiday);
    if (changed) broadcast('layout:ready', controller.lastLayout);
    broadcastStatus();
  });
  watcher.on('scene', ({ scene, inGame }) => {
    logger.info('场景切换', { scene, inGame });
    // 智能显隐（v0.3.0，默认关）：进设施自动亮覆盖层，回主菜单自动隐藏。
    // 用户没开这个开关时不做任何事 —— 手动 Ctrl+1 永远优先。
    if (settings.data.overlay.smartVisibility && overlayWindow) {
      if (inGame && !overlayWindow.isVisible()) setOverlayVisible(true);
      else if (!inGame && overlayWindow.isVisible()) setOverlayVisible(false);
    }
    broadcastStatus();
  });
  watcher.on('server', ({ server }) => {
    logger.info('本局服务器', { server });
    broadcastStatus();
  });
  watcher.on('status', () => broadcastStatus());
  watcher.start();
  logger.info('LogWatcher 启动', watcher.status());

  if (settings.data.seed.manualOverride) {
    handleSeed(settings.data.seed.manualOverride, 'manual', { holiday: watcher.signals.holiday });
  } else {
    const seed = watcher.tick();
    if (seed) handleSeed(seed, watcher.seedSource ?? 'log', { holiday: watcher.signals.holiday });
  }

  if (settings.data.overlay.visibleOnStart) setOverlayVisible(true);
  if (!settings.data.noticeAcknowledged) showSettingsWindow();

  versionTimer = setInterval(() => {
    const next = readGameVersion({ playerLogPath: settings.data.seed.logPath || defaultPlayerLogPath(), logsRoot: serverLogsRoot() });
    if (next.version !== controller.gameVersion) {
      controller.setGameVersion(next.version, next.source);
      controller.buildLayoutNow();
    }
  }, 60_000);
  versionTimer.unref?.();

  if (selftestRequested()) {
    setOverlayVisible(true);
    showSettingsWindow();
    scheduleSelftest({
      appRoot, controller, watcher, settings, logger, hotkeyReport,
      overlayWindow, settingsWindow, tray, globalShortcut,
      setOverlayVisible, setEditMode, toggleOverlay,
    });
  }
}

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  // 托盘常驻：关掉设置窗口不退出（显式注册监听即可阻止默认退出行为）
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  watcher?.stop();
  if (versionTimer) clearInterval(versionTimer);
});

app.on('before-quit', () => {
  app.isQuitting = true;
});

process.on('uncaughtException', (error) => {
  logger?.error('未捕获异常', { message: error.message, stack: error.stack });
});
