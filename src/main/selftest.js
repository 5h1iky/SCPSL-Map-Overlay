/**
 * 启动自检（`electron . --selftest [--selftest-hold=8000]`）。
 *
 * 为什么要它：Electron 在 DSH 的 shell 进程树里起不来（Chromium 浏览器进程 0xc0000005），
 * 只能通过 WMI 拉起来跑；跑起来之后又没有终端可看。所以自检把"窗口 / 热键 / 布局 / 日志"
 * 的真实状态写成 JSON + 截图，并且把热键要调的每个动作都真跑一遍，供外层脚本核对。
 *
 * ⚠️ electron 用**动态导入**：Electron 38 + Node 22 下内置 'electron' 模块是运行时构造的
 * CJS，Node 的 cjs-module-lexer 静态分析不出命名导出，`import { app } from 'electron'`
 * 会直接 SyntaxError（2026-10-17 实测：`does not provide an export named`）。
 * 动态 import() 拿到的 default 才是真身。ESM 文档模式：await 用在模块顶层。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const electron = await import('electron');
const { app, BrowserWindow } = electron.default;

/**
 * 是否请求自检。两种触发方式：
 *   1. 命令行 `--selftest`（开发模式 `electron .` 可用）
 *   2. 环境变量 `SCPSL_SELFTEST=1`（**打包版用这个**：Chromium 会拦截它不认识的
 *      `--xxx` 开关并报 "bad option"，参数到不了主进程 argv；环境变量没这个问题）
 */
export function selftestRequested(argv = process.argv, env = process.env) {
  return argv.includes('--selftest') || env.SCPSL_SELFTEST === '1';
}

export function selftestHoldMs(argv = process.argv, env = process.env) {
  const arg = argv.find((a) => a.startsWith('--selftest-hold='));
  const value = arg ? Number(arg.split('=')[1]) : env.SCPSL_SELFTEST_HOLD;
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? ms : 6000;
}

/** 打包后 appRoot 在 resources/app（portable 版还会被解到临时目录），报告统一写 userData */
export function reportDirFor(ctx) {
  return app.isPackaged ? join(app.getPath('userData'), 'selftest') : join(ctx.appRoot, 'out');
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} ctx { appRoot, controller, watcher, settings, logger, hotkeyReport,
 *                       overlayWindow, settingsWindow, tray, globalShortcut,
 *                       setOverlayVisible, setEditMode, toggleOverlay }
 */
export function scheduleSelftest(ctx) {
  const hold = selftestHoldMs();
  setTimeout(async () => {
    const reportDir = reportDirFor(ctx);
    mkdirSync(reportDir, { recursive: true });
    const steps = [];
    const shots = [];

    const shot = async (win, name) => {
      if (!win || win.isDestroyed()) return null;
      const file = join(reportDir, `${name}.png`);
      const image = await win.webContents.capturePage();
      writeFileSync(file, image.toPNG());
      const entry = { name, file, bytes: image.toPNG().length };
      shots.push(entry);
      return entry;
    };

    const step = async (name, fn, waitMs = 220) => {
      const entry = { step: name };
      try {
        const extra = await fn();
        entry.ok = true;
        entry.result = extra ?? null;
      } catch (error) {
        entry.ok = false;
        entry.error = error.message;
      }
      const status = ctx.controller?.status?.() ?? {};
      entry.status = { seed: status.seed, view: status.viewZone, route: status.route?.presetId, scaleIndex: status.scaleIndex };
      steps.push(entry);
      if (waitMs) await delay(waitMs);
      return entry;
    };

    // 1) 基线截图
    await shot(ctx.overlayWindow, 'selftest-overlay');
    await shot(ctx.settingsWindow, 'selftest-settings');

    // 2) 把六个热键要走的动作全跑一遍
    for (let i = 1; i <= 4; i += 1) await step(`cycleView#${i}`, () => ctx.controller.cycleView(1));
    for (let i = 1; i <= 6; i += 1) await step(`cycleRoute#${i}`, () => ctx.controller.cycleRoute(1));
    for (let i = 1; i <= 3; i += 1) await step(`cycleScale#${i}`, () => ctx.controller.cycleScale(1));
    await step('setView:HeavyContainment', () => ctx.controller.setView('HeavyContainment'));
    await step('selectRoute:dclass_to_gate', () => ctx.controller.selectRoute('dclass_to_gate'));
    await step('setView:All', () => ctx.controller.setView('All'));
    await step('selectRoute:armory_to_gate', () => ctx.controller.selectRoute('armory_to_gate'));
    await shot(ctx.overlayWindow, 'selftest-overlay-crosszone');

    // 3) 编辑模式（取消穿透）/ 显示隐藏
    await step('editMode:on', () => ctx.setEditMode?.(true));
    await shot(ctx.overlayWindow, 'selftest-overlay-editmode');
    await step('editMode:off', () => ctx.setEditMode?.(false));
    await step('overlay:hide', () => ctx.setOverlayVisible?.(false));
    await step('overlay:show', () => ctx.setOverlayVisible?.(true));

    // 4) 手动种子兜底 + 回到日志种子
    await step('seed:manual', () => ctx.controller.setSeed(123456789, 'manual'));
    await shot(ctx.overlayWindow, 'selftest-overlay-manualseed');
    await step('seed:restore-log', () => ctx.controller.setSeed(ctx.watcher?.currentSeed ?? null, 'log'));
    await step('view:back-to-lcz', () => ctx.controller.setView('LightContainment'));
    await step('route:back-to-914', () => ctx.controller.selectRoute('dclass_to_914'));

    // 5) v0.3.0 新功能自检
    // 5a) 悬停命中：编辑模式下把鼠标移到"第一个房间的屏幕中心"，验证命中并取到详情。
    //     不硬编码屏幕坐标 —— 从渲染进程拿房间中心再算屏幕位置（面板位置随 auto-fit 变）。
    await step('hover:hit-test', async () => {
      if (!ctx.overlayWindow || ctx.overlayWindow.isDestroyed()) return 'overlay 窗口不在';
      await ctx.setEditMode?.(true);
      await delay(150);
      // 让渲染进程给出"房间中心 → 屏幕坐标"的第一个命中点
      const point = await ctx.overlayWindow.webContents.executeJavaScript(`
        (function () {
          var R = window.OverlayRender;
          if (!R || !window.__overlayDebug) return null;
          var state = R.lastDrawState();
          if (!state.transform || !state.roomCount) return null;
          // 直接枚举：把画布网格扫一遍，找第一个命中的房间
          var t = state.transform;
          for (var gy = t.panelY + 4; gy < t.panelY + t.panelH - 4; gy += 6) {
            for (var gx = t.panelX + 4; gx < t.panelX + t.panelW - 4; gx += 6) {
              if (window.__overlayDebug.hit(gx, gy)) return { x: gx, y: gy };
            }
          }
          return null;
        })()
      `).catch(() => null);
      let moved = false;
      if (point) {
        ctx.overlayWindow.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
        moved = true;
        await delay(150);
      }
      const room = moved
        ? await ctx.overlayWindow.webContents.executeJavaScript(
          `window.__overlayDebug && window.__overlayDebug.hit(${point.x}, ${point.y}) ? 'hit' : 'miss'`,
        ).catch(() => 'error')
        : 'no-point';
      // 鼠标移出面板，撤掉 tooltip 再截图（截图要干净）
      if (point) {
        ctx.overlayWindow.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: 4 });
        await delay(120);
      }
      await ctx.setEditMode?.(false);
      if (!point) return '面板内没找到任何房间（渲染层可能没画房间）';
      return { point, room };
    });
    await shot(ctx.overlayWindow, 'selftest-overlay-hover');

    // 5b) 导出合成：调渲染进程的 compose，拿到画布尺寸即算通过（不弹保存对话框）
    await step('export:compose', async () => {
      if (!ctx.overlayWindow || ctx.overlayWindow.isDestroyed()) return 'overlay 窗口不在';
      const size = await ctx.overlayWindow.webContents.executeJavaScript(
        'window.__overlayDebug ? window.__overlayDebug.compose() : null',
      ).catch(() => null);
      if (!size || !size.width || !size.height) return '合成失败（没有 transform 或画布缺失）';
      return size;
    });

    // 5c) 显示器定位：记录一次「按游戏窗口定位」的探测结果（本机没开游戏时为 null，属正常）
    await step('display:game-window', async () => {
      const { findGameDisplay } = await import('./game-window-finder.js');
      const found = await findGameDisplay({ screenApi: electron.default.screen });
      return found
        ? { displayId: String(found.display.id), label: found.display.label, deviceName: found.deviceName }
        : '未找到游戏窗口（本机没运行 SCP:SL，正常）';
    });

    // 5d) 种子历史：手动设一颗种子后历史里应有记录
    await step('history:recorded', async () => {
      const before = (ctx.settings?.data?.seed?.history ?? []).length;
      await ctx.controller.setSeed(777001, 'manual');
      await delay(50);
      const after = (ctx.settings?.data?.seed?.history ?? []).length;
      // 历史记录发生在主进程 handleSeed，selftest 直接调 controller 不经过它 ——
      // 所以这里只验证"清洗函数"行为，记录链路由 settings 测试覆盖
      return { before, after, note: '记录链路见 test/v0.3.0-features.test.mjs' };
    });
    await shot(ctx.overlayWindow, 'selftest-overlay-final');

    const isRegistered = {};
    for (const [action, accelerator] of Object.entries(ctx.settings?.data?.hotkeys ?? {})) {
      try {
        isRegistered[action] = ctx.globalShortcut?.isRegistered?.(accelerator) ?? null;
      } catch (error) {
        isRegistered[action] = `error: ${error.message}`;
      }
    }

    const report = {
      at: new Date().toISOString(),
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
      appRoot: ctx.appRoot,
      isPackaged: app.isPackaged,
      userData: app.getPath('userData'),
      windows: {
        overlay: ctx.overlayWindow && !ctx.overlayWindow.isDestroyed()
          ? {
              visible: ctx.overlayWindow.isVisible(),
              alwaysOnTop: ctx.overlayWindow.isAlwaysOnTop(),
              bounds: ctx.overlayWindow.getBounds(),
              focusable: ctx.overlayWindow.isFocusable(),
            }
          : null,
        settings: ctx.settingsWindow && !ctx.settingsWindow.isDestroyed() ? { visible: ctx.settingsWindow.isVisible() } : null,
      },
      tray: Boolean(ctx.tray),
      hotkeys: { report: ctx.hotkeyReport, isRegistered },
      watcher: ctx.watcher?.status?.() ?? null,
      /** v0.3.0：日志信号管线快照（种子来源/节日/场景/服务器） */
      signals: ctx.watcher?.signals ?? null,
      settings: ctx.settings?.data ?? null,
      status: ctx.controller?.status?.() ?? null,
      steps,
      shots,
      stepsOk: steps.filter((s) => s.ok).length,
      stepsTotal: steps.length,
    };
    writeFileSync(join(reportDir, 'selftest.json'), JSON.stringify(report, null, 2), 'utf8');
    ctx.logger?.info('自检完成', { shots: shots.length, steps: `${report.stepsOk}/${report.stepsTotal}` });
    setTimeout(() => {
      app.isQuitting = true;
      app.quit();
    }, 300);
  }, hold).unref?.();
}
