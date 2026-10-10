/**
 * 启动自检（`electron . --selftest [--selftest-hold=8000]`）。
 *
 * 为什么要它：Electron 在 DSH 的 shell 进程树里起不来（Chromium 浏览器进程 0xc0000005），
 * 只能通过 WMI 拉起来跑；跑起来之后又没有终端可看。所以自检把"窗口 / 热键 / 布局 / 日志"
 * 的真实状态写成 JSON + 截图，并且把热键要调的每个动作都真跑一遍，供外层脚本核对。
 */
import { app, BrowserWindow } from 'electron';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function selftestRequested(argv = process.argv) {
  return argv.includes('--selftest');
}

export function selftestHoldMs(argv = process.argv) {
  const arg = argv.find((a) => a.startsWith('--selftest-hold='));
  const value = arg ? Number(arg.split('=')[1]) : 6000;
  return Number.isFinite(value) ? value : 6000;
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

export { BrowserWindow };
