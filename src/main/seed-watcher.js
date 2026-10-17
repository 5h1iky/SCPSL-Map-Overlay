/**
 * ⚠️ v0.3.0 起本模块只是兼容转发：真正的实现在 `log-watcher.js`（一次读尾提取
 * 种子/节日/场景/服务器四种信号）。保留这个文件是因为 CLI、测试、selftest、
 * 设置页都在 import 它；新代码请直接用 log-watcher.js。
 */
export {
  SEED_PATTERN, SEED_MIN, SEED_MAX,
  HOLIDAY_PATTERN, HOLIDAY_VALUES,
  SCENE_PATTERN, GAME_SCENE, MENU_SCENE,
  SERVER_PATTERN,
  defaultPlayerLogPath, prevLogPathFor,
  parseSeed, validateSeed, parseHoliday, parseScene, parseServer, parseSignals,
  readTail, LogWatcher, SeedWatcher,
} from './log-watcher.js';
