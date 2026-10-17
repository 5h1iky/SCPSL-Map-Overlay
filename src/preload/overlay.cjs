/* preload：唯一出口，白名单 API（§5.2 / §7）。CJS 以兼容 sandbox。 */
const { contextBridge, ipcRenderer } = require('electron');

const M_TO_R = ['app:status', 'seed:changed', 'layout:ready', 'layout:error', 'route:changed', 'overlay:state', 'hotkey:conflict', 'log:line', 'export:requested'];

function subscribe(channel, callback) {
  if (!M_TO_R.includes(channel)) throw new Error(`未允许订阅的 channel: ${channel}`);
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  ready: () => ipcRenderer.send('intent:ready'),
  onStatus: (cb) => subscribe('app:status', cb),
  onSeed: (cb) => subscribe('seed:changed', cb),
  onLayout: (cb) => subscribe('layout:ready', cb),
  onRoute: (cb) => subscribe('route:changed', cb),
  onOverlayState: (cb) => subscribe('overlay:state', cb),
  onError: (cb) => subscribe('layout:error', cb),
  onHotkeyConflict: (cb) => subscribe('hotkey:conflict', cb),
  onLogLine: (cb) => subscribe('log:line', cb),
  /** v0.3.0：主进程请求导出 PNG（热键/设置页按钮触发） */
  onExportRequested: (cb) => subscribe('export:requested', cb),
  intent: {
    setView: (zone) => ipcRenderer.invoke('intent:setView', { zone }),
    cycleView: (direction = 1) => ipcRenderer.invoke('intent:cycleView', { direction }),
    setRoute: (target) => ipcRenderer.invoke('intent:setRoute', target),
    cycleRoute: (direction = 1) => ipcRenderer.invoke('intent:cycleRoute', { direction }),
    setScaleIndex: (index) => ipcRenderer.invoke('intent:setScaleIndex', { index }),
    cycleScale: (direction = 1) => ipcRenderer.invoke('intent:cycleScale', { direction }),
    setSeed: (seed) => ipcRenderer.invoke('intent:setSeed', { seed }),
    rereadSeed: () => ipcRenderer.invoke('intent:rereadSeed', {}),
    setOverlay: (patch) => ipcRenderer.invoke('intent:setOverlay', patch),
    setCapture: (enabled) => ipcRenderer.invoke('intent:setCapture', { enabled }),
    captureKey: (ev) => ipcRenderer.invoke('intent:captureKey', ev),
    exportPng: () => ipcRenderer.invoke('intent:exportPng', {}),
    /** v0.3.1：按游戏窗口定位一次（单次探测，不是轮询） */
    locateGameDisplay: () => ipcRenderer.invoke('intent:locateGameDisplay', {}),
    listPois: () => ipcRenderer.invoke('intent:listPois', {}),
    setPresets: (presets) => ipcRenderer.invoke('intent:setPresets', { presets }),
    verifyRun: (seeds) => ipcRenderer.invoke('verify:run', { seeds }),
    openLogFolder: () => ipcRenderer.invoke('intent:openLogFolder', {}),
    openExternal: (url) => ipcRenderer.invoke('intent:openExternal', { url }),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },
  app: {
    status: () => ipcRenderer.invoke('app:getStatus'),
    quit: () => ipcRenderer.invoke('app:quit'),
    pickLogFile: () => ipcRenderer.invoke('app:pickLogFile'),
    openSettings: () => ipcRenderer.invoke('app:openSettings'),
    setAutoStart: (enabled) => ipcRenderer.invoke('app:setAutoStart', { enabled }),
    /** v0.3.0：把渲染进程合成的 PNG dataURL 交给主进程存盘 */
    exportPng: (payload) => ipcRenderer.invoke('app:exportPng', payload ?? {}),
  },
};

contextBridge.exposeInMainWorld('mapOverlay', api);
