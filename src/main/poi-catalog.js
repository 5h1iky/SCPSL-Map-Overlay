/**
 * PoiCatalog：room.name → 语义 POI（§9.5 三级降级）。
 *
 *  1 级 exact     ：name 命中 poi-map-<版本>.json 的 rooms 表
 *  2 级 heuristic ：name 命中但需要 prefab 区分（HczCheckpointToEntranceZone 两半段）
 *                   或只命中 prefabOverrides
 *  3 级 manual    ：表里的 manual 段按 seed + 网格坐标写死
 *
 * 表随模板版本独立，代码里不写死任何房间语义（§8 建表流程）。
 */
import { readFileSync } from 'node:fs';

export function loadPoiTableFromFile(path) {
  return loadPoiTable(JSON.parse(readFileSync(path, 'utf8')));
}

export function loadPoiTable(raw) {
  const rooms = new Map();
  for (const entry of raw.rooms ?? []) rooms.set(entry.name, entry);
  const prefabs = new Map();
  for (const entry of raw.prefabOverrides ?? []) prefabs.set(entry.prefab, entry);
  return {
    schemaVersion: raw.schemaVersion ?? 1,
    version: raw.templateVersion ?? null,
    source: raw.source ?? '',
    notes: raw.notes ?? [],
    kinds: raw.kinds ?? {},
    rooms,
    prefabs,
    manual: raw.manual ?? [],
  };
}

const KIND_FALLBACK = { group: 'utility', color: '#9AA4B2', label: '' };

export function kindMeta(table, kind) {
  return table.kinds?.[kind] ?? KIND_FALLBACK;
}

/**
 * @returns {{pois: Array, missing: string[], stats: object}}
 */
export function classifyRooms(map, table) {
  const pois = [];
  const missing = new Set();
  let exact = 0;
  let heuristic = 0;
  let manual = 0;

  for (const room of map.rooms) {
    const name = room.name?.name ?? 'Unnamed';
    const prefab = room.prefabName ?? room.render?.iconKey ?? '';
    let entry = null;
    let confidence = null;

    if (name !== 'Unnamed' && table.rooms.has(name)) {
      entry = table.rooms.get(name);
      confidence = 'exact';
      exact += 1;
    }
    // prefab 覆盖优先于 name（同一 name 的两半段必须靠 prefab 区分）
    if (table.prefabs.has(prefab)) {
      const override = table.prefabs.get(prefab);
      if (!entry || override.kind !== entry.kind || override.label !== entry.label) {
        entry = override;
        confidence = 'heuristic';
        heuristic += 1;
        if (name !== 'Unnamed' && table.rooms.has(name)) exact -= 1;
      }
    }
    if (!entry) {
      const manualEntry = (table.manual ?? []).find((m) => matchesManual(m, map.seed, room));
      if (manualEntry) {
        entry = manualEntry;
        confidence = 'manual';
        manual += 1;
      }
    }
    if (!entry) {
      if (name !== 'Unnamed') missing.add(name);
      continue;
    }
    const meta = kindMeta(table, entry.kind);
    pois.push({
      id: `${entry.kind}:${room.id}`,
      kind: entry.kind,
      group: meta.group,
      color: meta.color,
      label: entry.label || meta.label || name,
      showLabel: entry.showLabel !== false,
      priority: entry.priority ?? 50,
      confidence,
      roomId: room.id,
      roomName: name,
      prefab,
      zone: room.zone?.name ?? 'Other',
      world: { ...room.position },
      grid: { ...room.grid },
      angleDeg: room.render?.angleDeg ?? 0,
      connectorCount: room.connectorInstances?.length ?? 0,
    });
  }

  pois.sort((a, b) => b.priority - a.priority || (a.roomId < b.roomId ? -1 : 1));

  return {
    pois,
    missing: [...missing].sort(),
    stats: { total: pois.length, exact, heuristic, manual },
  };
}

function matchesManual(entry, seed, room) {
  if (entry.seed !== undefined && entry.seed !== seed) return false;
  if (entry.grid && (entry.grid.x !== room.grid.x || entry.grid.z !== room.grid.z || entry.grid.y !== room.grid.y)) return false;
  if (entry.zone && entry.zone !== room.zone?.name) return false;
  return Boolean(entry.grid || entry.zone);
}

/**
 * 按选择器取候选（路线预设 + 用户自定义路线用）。
 *
 * 支持四种收窄条件，可叠加（详见 shared/constants.js 的 ROUTE_SELECTOR_FIELDS）：
 *   roomNames 精确房名 / prefabs 精确 prefab / kinds 类别 / zones 分区
 * ⚠️ 端点必须与种子无关才能存进配置，所以不能用 POI id（里面含每局都变的 roomId）。
 */
export function candidatesFor(pois, selector = {}) {
  const kinds = selector.kinds ?? null;
  const zones = selector.zones ?? null;
  const roomNames = selector.roomNames ?? null;
  const prefabs = selector.prefabs ?? null;
  const exclude = selector.excludeKinds ?? null;
  return pois.filter((poi) => {
    if (kinds && !kinds.includes(poi.kind)) return false;
    if (zones && !zones.includes(poi.zone)) return false;
    if (roomNames && !roomNames.includes(poi.roomName)) return false;
    if (prefabs && !prefabs.includes(poi.prefab)) return false;
    if (exclude && exclude.includes(poi.kind)) return false;
    return true;
  });
}

/**
 * 设置页可选的路线端点清单（**与种子无关**，没读到种子也能编辑）。
 *
 * 三种粒度：
 *   room:<name>    具体具名房间（最精确，推荐）
 *   prefab:<prefab> 具体 prefab（用来区分同名两半段，如 HCZ/EZ 检查点）
 *   kind:<kind>    整个类别（可能命中多个房间 → 规划时取最短路）
 */
export function listRouteTargets(table) {
  const targets = [];
  const kindLabel = (kind) => table.kinds?.[kind]?.label || kind;
  const seenRoom = new Set();
  for (const entry of table.rooms?.values?.() ?? []) {
    if (seenRoom.has(entry.name)) continue;
    seenRoom.add(entry.name);
    targets.push({
      id: `room:${entry.name}`,
      group: '具体房间',
      label: entry.label || kindLabel(entry.kind) || entry.name,
      sub: entry.name,
      selector: { roomNames: [entry.name] },
    });
  }
  for (const entry of table.prefabs?.values?.() ?? []) {
    if (seenRoom.has(entry.prefab)) continue;
    targets.push({
      id: `prefab:${entry.prefab}`,
      group: '具体房间',
      label: entry.label || kindLabel(entry.kind) || entry.prefab,
      sub: entry.prefab,
      selector: { prefabs: [entry.prefab] },
    });
  }
  for (const [kind, meta] of Object.entries(table.kinds ?? {})) {
    if (kind === 'Pocket') continue; // 口袋空间不与主设施连通，给路线端点没有意义
    targets.push({
      id: `kind:${kind}`,
      group: '按类别（任一）',
      label: meta?.label || kind,
      sub: kind,
      selector: { kinds: [kind] },
    });
  }
  return targets;
}
