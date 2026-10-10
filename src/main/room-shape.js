/**
 * RoomShape：房间轮廓（方案 B 核心）
 *
 * 背景（实测，见 research/形状化改造-验证与方案.md）
 * ─────────────────────────────────────────────────────────────
 * 1. 房间有三层"特征码"：shape 枚举（6 种，太粗）→ prefab 名（144 个）→ 连接器几何签名。
 *    **同一个 shape 下不同 prefab 的开口朝向不同**（如 Straight 有 4 种布局），
 *    所以不能靠 shape 硬编码形状 —— 必须以**实际连接器**为准。
 * 2. 因此本模块不"猜"形状，而是由权威数据生成：
 *      房间轮廓 = 中心块 + 朝向每个连接器的走廊臂
 *    相邻房间的臂在格子边界自然对接 → 形成连续走廊。
 * 3. 方位（手性）：实测确认游戏内 SCP-079 地图采用
 *       screenX = worldX - minX,  screenY = maxZ - worldZ
 *    而生成器自带的 render.zonePosition 是"180° 翻转过的预览坐标"（vendor README 明示），
 *    与游戏内实际显示差 180°。故本模块一律用上面的游戏约定。
 *
 * 输出的数据结构是"渲染就绪"的多边形/矩形组，渲染进程不理解房间/种子，只按坐标画。
 */

export const CELL = 15;        // gridScale.x/z：每个格子 15×15 世界单位
export const CORRIDOR = 7.5;   // 走廊净宽（连接器位于 ±7.5）
/**
 * 官方图标的画布尺寸（世界单位）。
 *
 * 实测结论：1024px 画布 ↔ **15 世界单位 = 正好 1 格**，房间居中。
 * 决定性证据（三条互相印证）：
 *   4RW 十字 1018px → 14.91 单位，正好占满 1 格 ✅（若按 32 单位会跨 2.1 格、臂插进邻居房间）
 *   ERN 端房 957px → 14.02 单位，块≈满格 ✅
 *   SRN 直廊短边 240px → 3.52 单位 = 走廊通道净宽；
 *       注意：门（连接器）在**格边界 ±7.5**，走廊通道比门距窄，两者不是同一个量。
 *   CNE 弯角中心偏移 194.5px → 2.85 单位，与几何推导 (7.5 − 3.52/2) / 2 = 2.87 吻合 ✅
 */
export const ROOM_ICON_BASE = CELL;

/** 端房画得饱满，走廊房画小核 —— 让"奇形怪状"的房间一眼能认出来 */
const BLOCK_INSET = 1.4;       // 端房块相对格子的内缩
const HUB_HALF = CORRIDOR / 2; // 走廊房枢纽半宽 = 走廊半宽（这样 Straight 才是"一条走廊"而不是方块）

export function isEndroom(shape) {
  return shape === 'Endroom' || shape === 'Undefined';
}

/**
 * 房间中心块的半边长（世界单位）。
 * 端房 ≈ 整格；走廊房只是一个小枢纽，靠臂连出去。
 */
export function blockHalfOf(room) {
  const shape = room.shape?.name ?? 'Undefined';
  return isEndroom(shape) ? CELL / 2 - BLOCK_INSET : HUB_HALF;
}

/**
 * 生成房间轮廓（一组矩形，cell 局部/世界单位；由调用方投影到屏幕）
 *
 * @param {object} room  GeneratedRoom（含 position / connectorInstances / shape / rotationY）
 * @returns {{ center:{x,y}, block:{half:number}, arms:Array<{x,y,direction,connected}>, isEnd:boolean }}
 *          坐标均为**世界坐标**，调用方再按分区投影。
 */
export function buildRoomOutline(room, iconTable = null) {
  const center = { x: room.position.x, y: room.position.z };
  const half = blockHalfOf(room);
  const isEnd = isEndroom(room.shape?.name);
  const dirs = screenDirsOf(room);
  const arms = (room.connectorInstances ?? []).map((c) => ({
    x: c.worldPosition.x,
    y: c.worldPosition.z,
    direction: c.direction ?? null,
    connected: (c.connectedRoomIds ?? []).length,
  }));
  // 官方通用形状图标（无名走廊用）
  const icon = pickRoomIcon(room.shape?.name, dirs);
  // 真实房间贴图（具名房间用；数据来自权威 mapIcon 字段）
  const mapIcon = iconForRoom(room, iconTable);
  const category = categoryOfRoom(room, iconTable);
  return {
    center, block: { half }, arms, isEnd, dirs, icon, mapIcon, category,
    roomName: room.name?.name ?? 'Unnamed',
    prefab: room.prefabName ?? '',
    shape: room.shape?.name ?? 'Undefined',
  };
}

/**
 * 「房间 → 真实贴图」映射（方案 C：用官方房间图标贴图）
 *
 * 数据来源（可在 NOTICE.md 追溯）：
 *   SCP:SL 房间图标，Northwood Studios，CC BY-SA 3.0
 *   文件名取自社区地图工具返回的权威 `mapIcon` 字段
 *   （例：LczComputerRoom→LCZ_PC15、HczWaysideIncinerator→HCZ_Wayside、
 *         Hcz079/Hcz106→HCZ_EndLarge、Lcz173→LCZ_LargeEnd）
 *
 * ⚠️ 这是**贴图**，不是我手画的几何图形。渲染端按分类着色后 drawImage。
 */
export function iconForRoom(room, iconTable) {
  if (!iconTable) return null;
  const name = room.name?.name ?? 'Unnamed';
  const zone = room.zone?.name ?? 'LightContainment';

  // ① 具名房间：直接取权威 mapIcon。
  //    ⚠️ 少数房间名在**两个分区里各有一半**（如 HczCheckpointToEntranceZone：
  //    重收容侧是 HCZ_Tesla，办公侧是 EZ_Checkpoint），所以先查「分区|房间名」。
  const scoped = iconTable.byRoomZone?.[`${zone}|${name}`];
  if (scoped) return scoped;

  // ② 无名走廊（占全部房间的一半）：**必须按「分区 + 形状」取**，
  //    绝不能命中 byRoom['Unnamed'] 那一条 —— 否则所有走廊都拿到同一张贴图。
  if (name === 'Unnamed') return shapeIcon(zone, room.shape?.name, iconTable);

  const entry = iconTable.byRoom?.[name];
  if (entry?.mapIcon) return entry.mapIcon;

  // ③ 表里没登记的具名房间：退回形状贴图，而不是留空
  return shapeIcon(zone, room.shape?.name, iconTable);
}

/**
 * 「分区 + 形状」→ 形状贴图（无名走廊用）。
 * 数据来自权威 mapIcon 字段：LCZ_Straight / HCZ_Curve / EZ_Crossing …
 * 注意 `Undefined` 形状在模板里是"未分类的死角"，按 Straight 处理。
 */
export function shapeIcon(zone, shapeName, iconTable) {
  const table = iconTable?.shapeFallback?.[zone];
  if (!table) return null;
  const shape = shapeName ?? 'Straight';
  return table[shape] ?? table.Straight ?? null;
}

/** 房间分类（决定贴图配色），同样来自权威数据的 category 字段 */
export function categoryOfRoom(room, iconTable) {
  const name = room.name?.name ?? 'Unnamed';
  const zone = room.zone?.name ?? 'LightContainment';
  const scoped = iconTable?.byRoomZoneCategory?.[`${zone}|${name}`];
  if (scoped) return scoped;
  const entry = iconTable?.byRoom?.[name];
  if (entry?.category) return entry.category;
  return room.shape?.name === 'Endroom' ? 'deadend' : 'corridor';
}

/**
 * 「房间身份 → 专属绘制」—— 复刻社区实际在用的实现（slmaps.com）
 *
 * ⚠️ 这些形状不是我凭文字想象画出来的，是从 slmaps.com 的前端 bundle
 *    提取的真实绘制分支（每个房间一组 SVG 图元与参数）。
 *    参考文章《从地图种子还原 SCP:SL 的整张设施地图》§8.2 的描述与之吻合：
 *      「房间体的形状按类型区分……焚化炉是圆形」
 *
 * 单元格基准 = 100（与 slmaps 的 viewBox 一致），渲染端按格子缩放。
 */

/**
 * ⚠️ 已废弃：以下 `bodySpecOf` 是**早期错误的产物** ——
 * 它用代码手画几何图形（圆/菱形/矩形）冒充房间形状，而不是使用官方贴图。
 * 保留仅为兼容旧引用，渲染路径已不再调用它。
 * 正确做法见 `iconForRoom()` + `assets/room-icons/*.png`（真实贴图）。
 */
export const DEPRECATED_handDrawnShapes = true;

/** 每个具名房间的专属尺寸（slmaps 的 Bi 表）——仅作历史参考 */
export const ROOM_BODY_SIZE = {
  Glassroom: [74, 70], Armory: [72, 72], 914: [76, 68], 173: [68, 74],
  ComputerRoom: [64, 70], ClassDSpawn: [94, 48], Toilets: [86, 50],
  Greenhouse: [50, 88], 330: [54, 54],
  CheckpointA: [80, 50], CheckpointB: [80, 50], CheckpointToEntranceZone: [80, 50],
};

/**
 * 分区投影（游戏内 SCP-079 地图约定）
 *   screenX = worldX - minX
 *   screenY = maxZ - worldZ
 * 与 render.zonePosition 差 180°（zonePosition 是"翻转过的预览坐标"）。
 */
export function makeProjector(bounds) {
  const { minX, maxZ } = bounds;
  return (p) => ({ x: p.x - minX, y: maxZ - p.y });
}

export function zoneBoundsOf(rooms) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const r of rooms) {
    minX = Math.min(minX, r.position.x - CELL / 2);
    maxX = Math.max(maxX, r.position.x + CELL / 2);
    minZ = Math.min(minZ, r.position.z - CELL / 2);
    maxZ = Math.max(maxZ, r.position.z + CELL / 2);
  }
  return { minX, maxX, minZ, maxZ, w: maxX - minX, h: maxZ - minZ };
}

/**
 * 官方房间图标选择（SCP:SL 官方 wiki，CC BY-SA 3.0，游戏内 079/106 地图所用图形）
 *
 * 命名规则（实测破译，12 种子 / 1198 房间 100% 覆盖、0 越界）：
 *   ER{d}     端房 Endroom（大块，单开口）
 *   CD{d}     死巷走廊（细长，单开口）
 *   SRN/SRW   直廊（南北 / 东西贯通）
 *   C{a}{b}   弯角（两相邻开口，字母序 N→S→E→W）
 *   TR{d}     丁字（d = 单臂方向）
 *   4RW       十字（四开口）
 *
 * 方位：与投影 screenY = maxZ - worldZ 一致 → dz>0 是屏幕上方 = N。
 */
const DIR_ORDER = ['N', 'S', 'E', 'W'];

/** 由实际连接器推出屏幕开口方向集合 */
export function screenDirsOf(room) {
  const set = new Set();
  for (const c of room.connectorInstances ?? []) {
    const dx = c.worldPosition.x - room.position.x;
    const dz = c.worldPosition.z - room.position.z;
    if (Math.abs(dx) >= Math.abs(dz)) set.add(dx > 0 ? 'E' : 'W');
    else set.add(dz > 0 ? 'N' : 'S');
  }
  return DIR_ORDER.filter((d) => set.has(d));
}

export function pickRoomIcon(shapeName, dirs) {
  const d = dirs.join('');
  const n = dirs.length;
  if (n === 4) return '4RW';
  if (n === 3) {
    const missing = DIR_ORDER.find((x) => !dirs.includes(x));
    const stem = { N: 'S', S: 'N', E: 'W', W: 'E' }[missing];
    return `TR${stem}`;
  }
  if (n === 2) {
    if (d === 'NS' || d === 'SN') return 'SRN';
    if (d === 'EW' || d === 'WE') return 'SRW';
    return `C${d}`;
  }
  if (n === 1) {
    const isBlock = shapeName === 'Endroom' || shapeName === 'Undefined';
    return `${isBlock ? 'ER' : 'CD'}${d}`;
  }
  return null;
}
