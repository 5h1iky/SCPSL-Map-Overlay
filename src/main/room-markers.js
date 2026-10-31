/**
 * RoomMarkers：房间级「特殊标志」表（v0.3.3）
 *
 * 背景（issue #1）：
 *   U 型房 / 管道房 / 斜坡房这类特殊走廊，在 14.2.7 的格子模型里**和普通走廊完全同形**
 *   （Straight / TShape 的开口位置一模一样），小地图只按 shape 画贴图就永远分不出来。
 *   它们唯一的区别是 prefabName（HCZ_Straight_C / HCZ_Straight_PipeRoom / HCZ_Intersection_Ramp），
 *   而 prefabName 是**跨种子稳定**的，所以可以安全地做成数据表，不写死每局的 roomId。
 *
 * 同一套机制顺带解决另一件事：轻收 / 重收两侧的 A、B 电梯间（LczCheckpointA/B、HczCheckpointA/B）
 * 在 HCZ 视图里原本 showLabel=false，等于没有标识 —— 这里给它们画 A / B 徽标。
 *
 * 与 POI 的分工：
 *   · POI   = 「这里是干什么的」（D 级牢房 / SCP-914 / 军械库…），参与路线端点与寻路；
 *   · 标志   = 「这是哪一间」（U 型房 / 管道房 / A 电梯…），纯显示层，不参与任何寻路。
 *   两者都来自数据表，代码里不写死任何房间语义。
 */
import { readFileSync } from 'node:fs';

/** 节日变体的 prefabName 会带这些后缀（"HCZ_Straight_C Christmas"），匹配前统一剥掉 */
const HOLIDAY_SUFFIXES = [' Christmas', ' Halloween', ' AprilFools'];

export function stripHolidaySuffix(prefabName) {
  let name = String(prefabName ?? '');
  for (const suffix of HOLIDAY_SUFFIXES) {
    if (name.endsWith(suffix)) {
      name = name.slice(0, -suffix.length);
      break;
    }
  }
  return name;
}

export function loadRoomMarkersFromFile(path) {
  return loadRoomMarkers(JSON.parse(readFileSync(path, 'utf8')));
}

export function loadRoomMarkers(raw = {}) {
  const markers = (raw.markers ?? []).map((entry) => ({
    id: entry.id,
    kind: entry.kind ?? 'special',
    label: entry.label ?? entry.id,
    short: entry.short ?? '',
    color: entry.color ?? '#FFC24D',
    priority: Number.isFinite(entry.priority) ? entry.priority : 50,
    roomNames: Array.isArray(entry.roomNames) ? entry.roomNames : [],
    prefabs: Array.isArray(entry.prefabs) ? entry.prefabs.map(stripHolidaySuffix) : [],
    zones: Array.isArray(entry.zones) ? entry.zones : null,
    showLabel: entry.showLabel !== false,
  }));
  return {
    schemaVersion: raw.schemaVersion ?? 1,
    version: raw.templateVersion ?? null,
    source: raw.source ?? '',
    notes: raw.notes ?? [],
    markers,
  };
}

/**
 * 命中规则：房名（room.name）或 prefab 任一命中即可；同一房间命中多条时取 priority 最高的。
 * @returns {{id,kind,label,short,color,priority,showLabel}|null}
 */
export function markerForRoom(table, room) {
  const list = table?.markers;
  if (!Array.isArray(list) || list.length === 0 || !room) return null;
  const name = room.name?.name ?? 'Unnamed';
  const prefab = stripHolidaySuffix(room.prefabName ?? room.render?.iconKey ?? '');
  const zone = room.zone?.name ?? null;
  let best = null;
  for (const marker of list) {
    if (marker.zones && !marker.zones.includes(zone)) continue;
    const hitName = name !== 'Unnamed' && marker.roomNames.includes(name);
    const hitPrefab = prefab !== '' && marker.prefabs.includes(prefab);
    if (!hitName && !hitPrefab) continue;
    if (!best || marker.priority > best.priority) best = marker;
  }
  if (!best) return null;
  return {
    id: best.id,
    kind: best.kind,
    label: best.label,
    short: best.short,
    color: best.color,
    priority: best.priority,
    showLabel: best.showLabel,
  };
}
