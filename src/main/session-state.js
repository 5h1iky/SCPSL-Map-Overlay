/**
 * 会话状态（v0.3.1）：把 LogWatcher 的原始信号翻译成 UI 可以直接显示的文案。
 *
 * 为什么单独一个模块：
 *   - 设置页要显示「本局 / 上一局 / 还没读到种子」，覆盖层状态条要显示「设施中 · 服务器 · 节日」，
 *     两边需要的判断必须一致（否则一个说本局、一个说上一局）；
 *   - 纯函数、不依赖 Electron，可以单测锁住语义。
 *
 * 数据从哪来：LogWatcher.status() 的 signals（scene/server/holiday/seed）+ AppController 的 seedSource。
 */

/** 场景 → 中文与配色档（覆盖层状态条用 tone 选 CSS 类） */
export const SCENE_META = {
  Facility: { label: '设施中', tone: 'in-game' },
  NewMainMenu: { label: '主菜单', tone: 'menu' },
  Loader: { label: '加载中', tone: 'loading' },
};

export const HOLIDAY_LABEL = {
  Christmas: '圣诞活动',
  Halloween: '万圣节活动',
  AprilFools: '愚人节活动',
};

export const SEED_SOURCE_LABEL = {
  log: '本局日志',
  'prev-log': '上一局日志',
  manual: '手动',
  cli: 'CLI',
  test: '测试',
};

/**
 * @param {object} opts
 * @param {object|null} opts.watcher LogWatcher.status() 的结果（可为 null：启动早期还没建 watcher）
 * @param {number|null} opts.seed     当前布局用的种子
 * @param {string|null} opts.seedSource 'log' / 'prev-log' / 'manual' …
 * @returns {object} 可直接塞进 statusPayload 的 session 快照
 */
export function describeSession({ watcher = null, seed = null, seedSource = null } = {}) {
  const signals = watcher?.signals ?? {};
  const scene = signals.scene ?? watcher?.scene ?? null;
  const meta = SCENE_META[scene] ?? { label: '未检测', tone: 'unknown' };
  const server = signals.server ?? null;
  const holiday = signals.holiday ?? null;
  const source = seedSource ?? watcher?.seedSource ?? null;
  const currentSeed = seed ?? signals.seed ?? watcher?.currentSeed ?? null;
  const inGame = watcher?.inGame ?? scene === 'Facility';

  /**
   * 什么时候算「需要重新敲 seed」：
   *   1) 压根没读到种子；
   *   2) 读到的只是上一局日志（prev-log）里的种子 —— 本局还没敲过 seed。
   * 注意：'log' 来源也可能是上一局的种子（日志还留着），
   * 工具无法区分「这局的 seed」和「上局残留的 seed」，所以教程卡要常驻提醒。
   */
  const needsSeed = currentSeed === null || source === 'prev-log';

  let needSeedHint = null;
  if (currentSeed === null) needSeedHint = '还没读到种子 · 进游戏敲一次 seed';
  else if (source === 'prev-log') needSeedHint = '这是上一局的种子 · 进游戏敲一次 seed 才会更新';

  return {
    scene,
    sceneLabel: meta.label,
    sceneTone: meta.tone,
    inGame,
    server,
    holiday,
    holidayLabel: HOLIDAY_LABEL[holiday] ?? null,
    seed: currentSeed,
    seedSource: source,
    seedSourceLabel: SEED_SOURCE_LABEL[source] ?? null,
    needsSeed,
    needSeedHint,
  };
}
