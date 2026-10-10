/**
 * 全局常量：分区、配色、POI 分类、默认设置、热键默认值。
 * 这里的数值全部来自方案 §10.2 视觉规范与 §11.1 热键规范。
 */

export const ZONES = ['LightContainment', 'HeavyContainment', 'Entrance', 'Surface', 'Other'];

export const ZONE_ORDER = ['LightContainment', 'HeavyContainment', 'Entrance', 'Surface'];

export const ZONE_META = {
  LightContainment: { short: 'LCZ', label: '轻收容区', tone: 'lcz', color: '#2A2F3A' },
  HeavyContainment: { short: 'HCZ', label: '重收容区', tone: 'hcz', color: '#3A2A24' },
  Entrance: { short: 'EZ', label: '办公区', tone: 'ez', color: '#24303A' },
  Surface: { short: 'SZ', label: '地表', tone: 'surface', color: '#24352A' },
  Other: { short: 'POCKET', label: '口袋空间', tone: 'other', color: '#2A2438' },
};

export const VIEWS = ['All', 'LightContainment', 'HeavyContainment', 'Entrance', 'Surface'];

export const VIEW_LABEL = {
  All: '全设施',
  LightContainment: '轻收容区 LCZ',
  HeavyContainment: '重收容区 HCZ',
  Entrance: '办公区 EZ',
  Surface: '地表',
};

/** 视觉规范（§10.2） */
export const STYLE = {
  panelBg: 'rgba(10,12,16,0.55)',
  panelBorder: 'rgba(255,255,255,0.15)',
  roomBorder: 'rgba(255,255,255,0.25)',
  door: 'rgba(255,255,255,0.55)',
  route: '#FFD400',
  routeGlowAlpha: 0.35,
  start: '#38D66B',
  end: '#FF4D4D',
  portal: '#4DA6FF',
  label: 'rgba(0,0,0,0.65)',
  font: 'Consolas, "Sarasa Mono SC", ui-monospace, monospace',
  scaleSteps: [0.8, 1.0, 1.3, 1.6],
  defaultScaleIndex: 1,
  defaultOpacity: 0.75,
  /** 地图高度 = 屏幕高度 × 该系数（auto-fit） */
  fitHeightRatio: 0.35,
};

/**
 * 默认全局热键（两键组合，§11.1）
 *
 * 早先用的是 Ctrl+Alt+数字（三键）—— 用户反馈"同时按三个键太麻烦"，已改为 Ctrl+数字。
 * Ctrl+数字 在 SCP:SL 里没有默认绑定（游戏用 1–5 切物品栏、Tab 看地图，都不带 Ctrl），
 * 冲突检测仍会读 keybinding.txt / registry.txt 再确认一次。
 */
export const DEFAULT_HOTKEYS = {
  toggle: 'Control+1',
  cycleView: 'Control+2',
  cycleRoute: 'Control+3',
  cycleScale: 'Control+4',
  rereadSeed: 'Control+5',
  editMode: 'Control+0',
};

/** 上一版默认热键 —— 仅用于把老配置平滑迁移到新的两键默认值 */
export const LEGACY_HOTKEYS = {
  toggle: 'Control+Alt+1',
  cycleView: 'Control+Alt+2',
  cycleRoute: 'Control+Alt+3',
  cycleScale: 'Control+Alt+4',
  rereadSeed: 'Control+Alt+5',
  editMode: 'Control+Alt+0',
};

export const HOTKEY_LABEL = {
  toggle: '显示 / 隐藏覆盖层',
  cycleView: '循环视图',
  cycleRoute: '循环路线预设',
  cycleScale: '循环缩放档位',
  rereadSeed: '强制重读种子',
  editMode: '编辑模式（取消穿透）',
};

/**
 * 路线端点选择器（自定义路线用）。
 *
 * 端点必须**与种子无关**才能存进配置：房间 id 每局都变，但 room.name / prefab / kind 不变。
 * 所以选择器支持四种收窄方式，可叠加：
 *   { roomNames: ['EzGateA'] }  精确到某个具名房间（最常用）
 *   { prefabs:   ['EZ_GateA'] } 精确到某个 prefab（区分 HCZ/EZ 检查点两半段）
 *   { kinds:     ['Gate'] }     按类别（可能命中多个房间 → 取最短路）
 *   { zones:     ['Entrance'] } 限定分区
 */
export const ROUTE_SELECTOR_FIELDS = ['roomNames', 'prefabs', 'kinds', 'zones'];

/** 选择器 → 可读文本（状态条、设置页用） */
export function describeSelector(selector, kindsMeta = null, fallback = '?') {
  if (!selector) return fallback;
  const names = selector.roomNames ?? [];
  const prefabs = selector.prefabs ?? [];
  const kinds = selector.kinds ?? [];
  if (names.length === 1) return names[0];
  if (prefabs.length === 1) return prefabs[0];
  if (kinds.length === 1) return kindsMeta?.[kinds[0]]?.label || kinds[0];
  if (names.length > 1) return `${names.length} 个房间`;
  if (kinds.length > 1) return kinds.map((k) => kindsMeta?.[k]?.label || k).join(' / ');
  return fallback;
}

/** 路线预设（§9.6，按 14.2.7 实际 POI 改写：电梯已不存在，改用检查点） */
export const ROUTE_PRESETS = [
  {
    id: 'dclass_to_914',
    label: 'D级牢房 → SCP-914',
    from: { kinds: ['ClassDCells'] },
    to: { kinds: ['Scp914'] },
    hint: '开局抢 914',
  },
  {
    id: '914_to_checkpoint',
    label: 'SCP-914 → 最近检查点',
    from: { kinds: ['Scp914'] },
    to: { kinds: ['CheckpointLczHcz'], nearest: true },
    hint: '带东西下重收容',
  },
  {
    id: 'dclass_to_checkpoint',
    label: 'D级牢房 → 最近检查点',
    from: { kinds: ['ClassDCells'] },
    to: { kinds: ['CheckpointLczHcz'], nearest: true },
    hint: '开局速冲',
  },
  {
    id: 'checkpoint_to_armory',
    label: '重收容检查点 → 重收军械库',
    from: { kinds: ['CheckpointLczHcz'], zones: ['HeavyContainment'] },
    to: { kinds: ['HczArmory'] },
    hint: '下重收先拿枪',
  },
  {
    id: 'dclass_to_gate',
    label: 'D级牢房 → 最近大门（撤离）',
    from: { kinds: ['ClassDCells'] },
    to: { kinds: ['Gate'], nearest: true },
    hint: '整条撤离路线',
  },
  {
    id: 'armory_to_gate',
    label: '重收军械库 → 最近大门',
    from: { kinds: ['HczArmory'] },
    to: { kinds: ['Gate'], nearest: true },
    hint: '拿完枪去撤离',
  },
];

export const DEFAULT_VISIBLE_PRESETS = [
  'dclass_to_914',
  '914_to_checkpoint',
  'dclass_to_checkpoint',
  'dclass_to_gate',
];

/** 跨层提示文案（§9.4） */
export const ZONE_TRANSITION_NOTE = {
  'LightContainment>HeavyContainment': '乘检查点电梯下到重收容区',
  'HeavyContainment>LightContainment': '乘检查点电梯上到轻收容区',
  'HeavyContainment>Entrance': '经检查点进入办公区',
  'Entrance>HeavyContainment': '经检查点返回重收容区',
  'Entrance>LightContainment': '经检查点返回轻收容区',
  'LightContainment>Entrance': '经检查点进入办公区',
  'Entrance>Surface': '出大门到地表撤离',
  'Surface>Entrance': '从地表回到办公区',
};

export const BANNER_LEVELS = { info: 'info', warn: 'warn', error: 'error' };
