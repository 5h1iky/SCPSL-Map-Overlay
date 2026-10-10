/**
 * LayoutBuilder：GeneratedMap → RenderLayout（§6.3）。
 *
 * 渲染进程收到的已经是"画什么、画在哪"，不需要理解房间/连接器/种子。
 *
 * 投影约定（与生成器 room.render.zonePosition 一致，即游戏 SCP-079 UI 的手性）：
 *   screenX = maxX - worldX      （X 轴镜像）
 *   screenY = worldZ - minZ      （Z 轴直接下移）
 * 单分区视图直接用它；"全设施"视图把 LCZ / HCZ / EZ / 地表 各自投影后**纵向分带**堆叠
 * （因为 LCZ 与 HCZ 在世界坐标里 X 区间重叠，直接叠在一起会糊成一团）。
 */
import { ZONE_META, ZONE_ORDER } from '../shared/constants.js';
import { buildRoomOutline, CELL, CORRIDOR, ROOM_ICON_BASE } from './room-shape.js';
import { interiorPath } from './route-geometry.js';

const CELLBOX = { w: 15, h: 15 };
const BAND_GAP = 26; // 分带之间的空隙（世界单位）

/**
 * 方位（手性）—— 与游戏内 SCP-079 地图 / 社区地图工具一致
 *
 * 参考文章《从地图种子还原 SCP:SL 的整张设施地图》§8.1（作者用 7 个地标线性拟合，
 * 残差 ≤1px）：轻收容 `screenX=+x, screenY=-z`；重收容/办公 `screenX=-x, screenY=+z`。
 *
 * 社区工具（scpslmaps.fxdyj.com）的实现进一步给出完整规则：
 *   group = 'light'（仅轻收容） / 'core'（重收容 + 办公，合绘一张核心图）
 *   screen : light → (+x, −z)   core → (−x, +z)
 *   rotate : (rotY + (group==='core' ? 180 : 0)) * π/180
 *
 * ⚠️ 此前实现对**所有分区**用同一投影，且忽略 group 的 180° 视图旋转 —— 这是
 * 贴图方向对不上的根因。生成器自带的 render.zonePosition 是"180° 翻转过的预览
 * 坐标"（vendor README 明示），不能直接当作游戏内显示方向。
 */
const ZONE_MIRROR = {
  LightContainment: { fx: false, fz: true },
  HeavyContainment: { fx: true, fz: false },
  Entrance: { fx: true, fz: false },
  Surface: { fx: true, fz: false },
};

export function zoneBounds(rooms, zone) {
  const list = rooms.filter((r) => (r.zone?.name ?? 'Other') === zone);
  if (list.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const room of list) {
    minX = Math.min(minX, room.position.x);
    maxX = Math.max(maxX, room.position.x);
    minZ = Math.min(minZ, room.position.z);
    maxZ = Math.max(maxZ, room.position.z);
  }
  return {
    minX: minX - CELLBOX.w / 2,
    maxX: maxX + CELLBOX.w / 2,
    minZ: minZ - CELLBOX.h / 2,
    maxZ: maxZ + CELLBOX.h / 2,
    count: list.length,
  };
}

/** 单点投影：世界 → 分区局部（原点左上，Y 向下）。按分区取镜像约定 */
export function projectPoint(position, bounds, zone = 'LightContainment') {
  const m = ZONE_MIRROR[zone] ?? ZONE_MIRROR.LightContainment;
  const x = m.fx ? bounds.maxX - position.x : position.x - bounds.minX;
  const y = m.fz ? bounds.maxZ - position.z : position.z - bounds.minZ;
  return { x, y };
}

export function projectRoom(room, bounds, zone) {
  const half = { x: CELLBOX.w / 2, y: CELLBOX.h / 2 };
  const center = projectPoint(room.position, bounds, zone);
  return { x: center.x - half.x, y: center.y - half.y, w: CELLBOX.w, h: CELLBOX.h, center };
}

/**
 * 房间轮廓（方案 B）：中心块 + 朝向每个连接器的走廊臂。
 * 形状由**实际连接器**决定，不靠 shape 枚举硬编码（同一 shape 下不同 prefab 开口不同）。
 */
function outlineOf(room, bounds, bandOffset, iconTable, zone) {
  const outline = buildRoomOutline(room, iconTable);
  const project = (p) => {
    const q = projectPoint({ x: p.x, z: p.y }, bounds, zone);
    return { x: q.x + bandOffset.x, y: q.y + bandOffset.y };
  };
  const center = project(outline.center);
  return {
    center,
    half: outline.block.half,
    isEnd: outline.isEnd,
    dirs: outline.dirs,
    /** 官方房间图标名（SCP:SL wiki，CC BY-SA 3.0）；渲染进程据此画游戏内同款形状 */
    icon: outline.icon,
    /** 真实房间贴图名（如 LCZ_PC15 / HCZ_Wayside，来自权威 mapIcon 字段） */
    mapIcon: outline.mapIcon,
    /** 房间朝向（贴图按其旋转，与游戏/社区工具一致） */
    rotationY: room.rotationY ?? 0,
    /** 视图旋转：core 分区（重收容/办公）额外转 180°，与社区工具一致 */
    viewRotation: zone === 'HeavyContainment' || zone === 'Entrance' ? 180 : 0,
    /** 房间分类，决定贴图配色 */
    category: outline.category,
    roomName: outline.roomName,
    prefab: outline.prefab,
    arms: outline.arms.map((a) => ({ ...project(a), direction: a.direction, connected: a.connected })),
  };
}

function doorsOf(room, bounds, zone) {
  const center = projectPoint(room.position, bounds, zone);
  const doors = [];
  for (const connector of room.connectorInstances ?? []) {
    const p = projectPoint(connector.worldPosition, bounds, zone);
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    const axis = Math.abs(dx) >= Math.abs(dy) ? 'v' : 'h';
    doors.push({
      x: p.x,
      y: p.y,
      axis,
      direction: connector.direction ?? null,
      connected: (connector.connectedRoomIds ?? []).length,
      /** 这个门口通向哪些房间 id（路线几何要用它定位进/出门口） */
      to: connector.connectedRoomIds ?? [],
    });
  }
  return doors;
}

/**
 * @param {object} map GeneratedMap
 * @param {object} opts
 * @param {Array}  opts.pois          PoiCatalog 输出
 * @param {object} opts.route         planRoute 输出（可为 null）
 * @param {string} opts.viewZone      'All' | zone 名
 * @param {object} opts.banner        { level, text } | null
 * @param {number} opts.columns       全设施视图的分带列数（默认 2，排成网格而不是一条竖列）
 */
export function buildLayout(map, opts = {}) {
  const {
    pois = [],
    route = null,
    viewZone = 'All',
    banner = null,
    includeZones = ZONE_ORDER,
    routeHighlight = true,
    columns = 2,
    iconManifest = null,
  } = opts;
  /** 房间→贴图映射表（含 byRoom / categories / shapeFallback） */
  const iconTable = iconManifest && iconManifest.byRoom ? iconManifest : null;

  const isAll = viewZone === 'All';
  const zones = isAll ? includeZones : [viewZone];

  // ① 每个分区先各自算局部投影（分区之间世界坐标不能直接混用）
  const entries = [];
  for (const zone of zones) {
    const bounds = zoneBounds(map.rooms, zone);
    if (!bounds) continue;
    entries.push({
      zone,
      bounds,
      w: bounds.maxX - bounds.minX,
      h: bounds.maxZ - bounds.minZ,
      x: 0,
      y: 0,
    });
  }

  // ② 排布：**按内容量分配空间**（用户反馈：地表只有 1 个房间却占掉 1/4 格子，全是空白）。
  //    主分区（房间多）继续用网格；零星分区（如地表）排成底部"附录条"，按自然尺寸横排，
  //    不再撑大网格。单分区视图不受影响（entries 只有 1 条 → 兜底整网格）。
  const MIN_MAJOR_ROOMS = 3;
  const majors = entries.filter((e) => e.bounds.count >= MIN_MAJOR_ROOMS);
  const minors = entries.filter((e) => e.bounds.count < MIN_MAJOR_ROOMS);
  const gridEntries = majors.length ? majors : entries;
  const stripEntries = majors.length ? minors : [];

  const cols = Math.max(1, Math.min(isAll ? columns : 1, gridEntries.length || 1));
  const rows = [];
  for (let i = 0; i < gridEntries.length; i += cols) rows.push(gridEntries.slice(i, i + cols));
  const colWidths = [];
  for (const row of rows) {
    row.forEach((entry, index) => {
      colWidths[index] = Math.max(colWidths[index] ?? 0, entry.w);
    });
  }
  const colX = [];
  colWidths.reduce((acc, width, index) => {
    colX[index] = acc;
    return acc + width + BAND_GAP;
  }, 0);

  const bands = [];
  const rooms = [];
  const projectedPois = [];
  const bandByZone = new Map();
  let offsetY = 0;

  for (const row of rows) {
    const rowHeight = Math.max(...row.map((entry) => entry.h));
    row.forEach((entry, index) => {
      entry.x = colX[index] + Math.max(0, (colWidths[index] - entry.w) / 2);
      entry.y = offsetY + Math.max(0, (rowHeight - entry.h) / 2);
    });
    offsetY += rowHeight + BAND_GAP;
  }

  // 附录条：零星分区顶对齐、左对齐网格起点、按自然尺寸横排
  let stripX = 0;
  for (const entry of stripEntries) {
    entry.x = stripX;
    entry.y = offsetY;
    stripX += entry.w + BAND_GAP;
  }

  const routeRoomIds = new Set(route?.roomPath ?? []);
  const poiByRoom = new Map();
  for (const poi of pois) {
    if (!poiByRoom.has(poi.roomId)) poiByRoom.set(poi.roomId, poi);
  }

  for (const entry of entries) {
    const { zone, bounds } = entry;
    const band = {
      zone,
      label: ZONE_META[zone]?.label ?? zone,
      short: ZONE_META[zone]?.short ?? zone,
      tone: ZONE_META[zone]?.tone ?? 'other',
      x: entry.x,
      y: entry.y,
      width: entry.w,
      height: entry.h,
    };
    bands.push(band);
    bandByZone.set(zone, band);

    for (const room of map.rooms) {
      if ((room.zone?.name ?? 'Other') !== zone) continue;
      if (room.name?.name === 'Pocket') continue; // 口袋空间不进地图（独立世界）
      const rect = projectRoom(room, bounds, zone);
      const poi = poiByRoom.get(room.id) ?? null;
      const outline = outlineOf(room, bounds, { x: band.x, y: band.y }, iconTable, zone);
      rooms.push({
        id: room.id,
        zone,
        tone: band.tone,
        x: rect.x + band.x,
        y: rect.y + band.y,
        w: rect.w,
        h: rect.h,
        cx: outline.center.x,
        cy: outline.center.y,
        /** 方案 B：房间轮廓（中心块 + 走廊臂），渲染进程据此画形状 */
        outline,
        angleDeg: room.render?.angleDeg ?? 0,
        shape: room.shape?.name ?? 'Undefined',
        roomName: room.name?.name ?? 'Unnamed',
        prefab: room.prefabName ?? '',
        doors: doorsOf(room, bounds, zone).map((door) => ({ ...door, x: door.x + band.x, y: door.y + band.y })),
        onRoute: routeHighlight && routeRoomIds.has(room.id),
        poiId: poi?.id ?? null,
        isStart: route?.fromRoomId === room.id,
        isEnd: route?.toRoomId === room.id,
      });
    }

    for (const poi of pois) {
      if (poi.zone !== zone) continue;
      const p = projectPoint(poi.world, bounds, zone);
      projectedPois.push({
        id: poi.id,
        kind: poi.kind,
        group: poi.group,
        color: poi.color,
        label: poi.label,
        showLabel: poi.showLabel,
        priority: poi.priority,
        confidence: poi.confidence,
        zone,
        roomId: poi.roomId,
        x: p.x + band.x,
        y: p.y + band.y,
        onRoute: routeRoomIds.has(poi.roomId),
      });
    }
  }

  const routeOut = route && route.ok ? buildRouteGeometry(route, map, bands, bandByZone, rooms) : null;
  const bounds = computeBounds(rooms, bands);

  return {
    seed: map.seed,
    holiday: map.holiday?.name ?? 'None',
    templateVersion: map.source?.gameVersion ?? null,
    viewZone,
    bands,
    bounds,
    cell: CELLBOX,
    corridor: CORRIDOR,
    /** 图标画布尺寸（世界单位）：渲染进程按此缩放官方房间图标 */
    iconBase: ROOM_ICON_BASE,
    icons: iconManifest ?? null,
    bandGap: BAND_GAP,
    rooms,
    pois: projectedPois,
    route: routeOut,
    banner,
    diagnostics: map.diagnostics ?? null,
  };
}

function computeBounds(rooms, bands) {
  if (rooms.length === 0) {
    const width = Math.max(0, ...bands.map((b) => b.x + b.width));
    const height = Math.max(0, ...bands.map((b) => b.y + b.height));
    return { minX: 0, minY: 0, maxX: width, maxY: height, width, height };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const room of rooms) {
    minX = Math.min(minX, room.x);
    minY = Math.min(minY, room.y);
    maxX = Math.max(maxX, room.x + room.w);
    maxY = Math.max(maxY, room.y + room.h);
  }
  // 分带标题画在分带上方，这里给顶部留一点空间
  minY -= 10;
  maxY += 2;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * 路线几何：按分区切成折线；分带视图下每段用自己分带的坐标系（含分带网格偏移）。
 *
 * 每个途经房间的**房内路径**由 route-geometry 贴着贴图形状生成
 * （进门口 → 形状内路径 → 出门口；环形房间走环形弧线），不再是"房间中心点直连"，
 * 这样路线不会穿过灰色墙区、在异形房间（圆形焚化炉等）里也贴着地形走。
 * portal 跳转点单独输出，渲染成虚线 + 文字提示。
 */
function buildRouteGeometry(route, map, bands, bandByZone, layoutRooms = []) {
  const roomById = new Map(map.rooms.map((r) => [r.id, r]));
  const layoutById = new Map(layoutRooms.map((r) => [r.id, r]));

  const segments = [];
  for (const segment of route.segments ?? []) {
    const band = bandByZone.get(segment.zone);
    if (!band) continue;
    const points = [];
    const push = (p) => {
      const last = points.at(-1);
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) points.push(p);
    };
    for (let i = 0; i < segment.roomIds.length; i += 1) {
      const laid = layoutById.get(segment.roomIds[i]);
      if (!laid?.outline) continue;
      // 进/出门口：取该房间连向上一个/下一个房间的那个连接器（同一连接器两房间共享坐标，天然接上）
      const prevId = segment.roomIds[i - 1] ?? null;
      const nextId = segment.roomIds[i + 1] ?? null;
      const doors = laid.doors ?? [];
      const entryDoor = prevId ? doors.find((d) => (d.to ?? []).includes(prevId)) : null;
      const exitDoor = nextId ? doors.find((d) => (d.to ?? []).includes(nextId)) : null;
      for (const p of interiorPath({
        center: laid.outline.center,
        rotationDeg: (laid.outline.rotationY ?? 0) + (laid.outline.viewRotation ?? 0),
        mapIcon: laid.outline.mapIcon ?? null,
        entry: entryDoor ? { x: entryDoor.x, y: entryDoor.y } : null,
        exit: exitDoor ? { x: exitDoor.x, y: exitDoor.y } : null,
      })) {
        push(p);
      }
    }
    if (points.length === 0) continue;
    segments.push({
      zone: segment.zone,
      tone: band.tone,
      points,
      enterNote: segment.enterNote ?? null,
      portalLabel: segment.portalLabel ?? null,
      roomIds: segment.roomIds,
    });
  }

  const labelOf = (roomId) => {
    const room = roomById.get(roomId);
    return room ? room.name?.name ?? roomId : roomId;
  };

  return {
    ok: true,
    fromRoomId: route.fromRoomId,
    toRoomId: route.toRoomId,
    fromLabel: route.fromLabel ?? labelOf(route.fromRoomId),
    toLabel: route.toLabel ?? labelOf(route.toRoomId),
    presetId: route.presetId ?? null,
    presetLabel: route.presetLabel ?? null,
    distance: route.distance,
    warnings: route.warnings ?? [],
    portalCount: route.portalCount ?? 0,
    segments,
    start: segments[0]?.points[0] ?? null,
    end: segments.at(-1)?.points.at(-1) ?? null,
  };
}
