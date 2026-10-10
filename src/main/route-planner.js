/**
 * RoutePlanner：connectorAdjacency → 图 → Dijkstra → 跨层切段（§9）。
 *
 *  节点 = 房间，边 = 真实连接器配对（distance ≤ 1）
 *  ⚠️ 绝不使用 spatialAdjacency（四邻网格 ≠ 有门）
 *
 * 14.2.7 的实测补充（方案 §9.4 的落地细节）：
 *  connectorAdjacency 是**分区内**连通的：LCZ(31) / HCZ(50) / EZ(22) 各自是一个连通分量，
 *  Surface 与 Pocket 是孤立点。分区之间的通路（检查点电梯、HCZ↔EZ 检查点两半、大门→地表）
 *  不在连接器数据里，必须由 buildPortalEdges() 按房名 + 网格/坐标就近补出来，
 *  并明确标成 kind:'portal'，以便在 UI 上写"乘电梯下到重收容区"这类提示，而不是假装有一条门。
 */
import { ZONE_TRANSITION_NOTE } from '../shared/constants.js';

export const PORTAL_WEIGHT = 15; // 与一个网格步长等价（gridScale.x/z = 15）

class MinHeap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(item) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent][0] <= a[i][0]) break;
      [a[parent], a[i]] = [a[i], a[parent]];
      i = parent;
    }
  }

  pop() {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < a.length && a[l][0] < a[smallest][0]) smallest = l;
        if (r < a.length && a[r][0] < a[smallest][0]) smallest = r;
        if (smallest === i) break;
        [a[smallest], a[i]] = [a[i], a[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * 分区之间的语义通路。全部按房名 + 坐标判定，不猜形状。
 * @returns {Array<{from:string,to:string,kind:'portal',label:string,note:string,weight:number}>}
 */
export function buildPortalEdges(map) {
  const rooms = map.rooms;
  const byName = (name) => rooms.filter((r) => r.name?.name === name);
  const byPrefab = (prefab) => rooms.filter((r) => r.prefabName === prefab);
  const portals = [];

  // ① LCZ 检查点 A/B ↔ HCZ 检查点 A/B：同一部电梯的上下两端
  for (const suffix of ['A', 'B']) {
    const upper = rooms.find((r) => r.name?.name === `LczCheckpoint${suffix}`);
    const lower = rooms.find((r) => r.name?.name === `HczCheckpoint${suffix}`);
    if (!upper || !lower) continue;
    portals.push({
      from: upper.id,
      to: lower.id,
      kind: 'portal',
      label: `检查点 ${suffix}`,
      note: ZONE_TRANSITION_NOTE['LightContainment>HeavyContainment'],
      weight: PORTAL_WEIGHT,
    });
  }

  // ② HCZ ↔ EZ 检查点：同一个 name 的两半段，用 prefab 分辨，按 z 就近配对
  const hczHalf = byPrefab('HCZ_EZ_Checkpoint Part');
  const ezHalf = byPrefab('EZ_HCZ_Checkpoint Part');
  for (const a of hczHalf) {
    let best = null;
    let bestD = Infinity;
    for (const b of ezHalf) {
      const d = Math.abs(a.position.z - b.position.z);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    if (!best) continue;
    portals.push({
      from: a.id,
      to: best.id,
      kind: 'portal',
      label: 'HCZ/EZ 检查点',
      note: ZONE_TRANSITION_NOTE['HeavyContainment>Entrance'],
      weight: PORTAL_WEIGHT,
    });
  }

  // ③ 大门 → 地表撤离点
  const outside = rooms.find((r) => r.name?.name === 'Outside');
  if (outside) {
    for (const gate of byName('EzGateA').concat(byName('EzGateB'))) {
      portals.push({
        from: gate.id,
        to: outside.id,
        kind: 'portal',
        label: '大门',
        note: ZONE_TRANSITION_NOTE['Entrance>Surface'],
        weight: PORTAL_WEIGHT,
      });
    }
  }

  // ④ 口袋空间是独立世界，只有 SCP-106 能进，不给路线边（保留在数据里但不连）
  return portals;
}

/**
 * 建图：无向。weight 默认用房间中心世界距离（网格步长 15），portal 用 PORTAL_WEIGHT。
 */
export function buildGraph(map, { portals = null, weightMode = 'centerDistance' } = {}) {
  const nodes = new Map();
  for (const room of map.rooms) {
    nodes.set(room.id, {
      id: room.id,
      zone: room.zone?.name ?? 'Other',
      name: room.name?.name ?? 'Unnamed',
      position: room.position,
    });
  }
  const edges = new Map();
  for (const id of nodes.keys()) edges.set(id, []);

  const addEdge = (from, to, weight, kind, extra = {}) => {
    if (!edges.has(from) || !edges.has(to)) return;
    edges.get(from).push({ to, weight, kind, ...extra });
    edges.get(to).push({ to: from, weight, kind, ...extra });
  };

  for (const edge of map.connectorAdjacency ?? []) {
    const a = nodes.get(edge.from);
    const b = nodes.get(edge.to);
    if (!a || !b) continue;
    const weight = weightMode === 'uniform' ? 1 : Math.max(distance(a.position, b.position), 1);
    addEdge(edge.from, edge.to, weight, 'connector', {
      fromConnectorIndex: edge.fromConnectorIndex,
      toConnectorIndex: edge.toConnectorIndex,
      distance: edge.distance,
    });
  }

  const portalList = portals ?? buildPortalEdges(map);
  for (const portal of portalList) {
    addEdge(portal.from, portal.to, portal.weight ?? PORTAL_WEIGHT, 'portal', {
      label: portal.label,
      note: portal.note,
    });
  }

  return { nodes, edges, portals: portalList };
}

/** 标准 Dijkstra + 惰性删除（房间数 < 200，二叉堆足够，<1ms） */
export function dijkstra(graph, source) {
  const dist = new Map();
  const prev = new Map();
  const prevEdge = new Map();
  for (const id of graph.nodes.keys()) dist.set(id, Infinity);
  if (!graph.nodes.has(source)) return { dist, prev, prevEdge, unreachable: true };
  dist.set(source, 0);
  const heap = new MinHeap();
  heap.push([0, source]);
  while (heap.size > 0) {
    const [d, u] = heap.pop();
    if (d > dist.get(u)) continue;
    for (const edge of graph.edges.get(u) ?? []) {
      const nd = d + edge.weight;
      if (nd < dist.get(edge.to)) {
        dist.set(edge.to, nd);
        prev.set(edge.to, u);
        prevEdge.set(edge.to, edge);
        heap.push([nd, edge.to]);
      }
    }
  }
  return { dist, prev, prevEdge, unreachable: false };
}

export function reconstructPath(prev, target) {
  const path = [];
  let cursor = target;
  const guard = new Set();
  while (cursor !== undefined && !guard.has(cursor)) {
    guard.add(cursor);
    path.push(cursor);
    cursor = prev.get(cursor);
  }
  return path.reverse();
}

export function shortestPath(graph, source, target) {
  if (source === target) return { path: [source], distance: 0 };
  const { dist, prev, unreachable } = dijkstra(graph, source);
  if (unreachable || !Number.isFinite(dist.get(target))) return { path: null, distance: Infinity };
  return { path: reconstructPath(prev, target), distance: dist.get(target) };
}

/** 一次 Dijkstra 解决全部候选（"最近电梯/最近检查点"必须按路径长度，§9.3） */
export function nearestTarget(graph, source, candidates) {
  const { dist, prev, unreachable } = dijkstra(graph, source);
  if (unreachable) return null;
  let best = null;
  let bestD = Infinity;
  for (const candidate of candidates) {
    const d = dist.get(candidate);
    if (d !== undefined && d < bestD) {
      bestD = d;
      best = candidate;
    }
  }
  if (best === null) return null;
  return { roomId: best, distance: bestD, path: reconstructPath(prev, best) };
}

/**
 * 按 zone 切段，并给出跨层提示（§9.4）。
 * @returns {Array<{zone:string, roomIds:string[], enterNote:string|null, portalLabel?:string}>}
 */
export function segmentByZone(map, roomPath, { portals = [] } = {}) {
  const zoneOf = new Map(map.rooms.map((r) => [r.id, r.zone?.name ?? 'Other']));
  const portalKey = new Map();
  for (const portal of portals) {
    portalKey.set(`${portal.from}>${portal.to}`, portal);
    portalKey.set(`${portal.to}>${portal.from}`, portal);
  }
  const segments = [];
  for (let i = 0; i < roomPath.length; i += 1) {
    const id = roomPath[i];
    const zone = zoneOf.get(id) ?? 'Other';
    const last = segments.at(-1);
    if (!last || last.zone !== zone) {
      const prevId = roomPath[i - 1];
      const portal = prevId ? portalKey.get(`${prevId}>${id}`) : null;
      const note = portal
        ? portal.note
        : (prevId ? ZONE_TRANSITION_NOTE[`${zoneOf.get(prevId)}>${zone}`] ?? null : null);
      segments.push({ zone, roomIds: [id], enterNote: note, portalLabel: portal?.label ?? null });
    } else {
      last.roomIds.push(id);
    }
  }
  return segments;
}

/**
 * 规划一条路线。
 * @returns {{ok:boolean, reason?:string, fromRoomId, toRoomId, roomPath, segments, distance, warnings:Array}}
 */
export function planRoute(map, graph, fromRoomId, toRoomId) {
  const warnings = [];
  if (!map.rooms.some((r) => r.id === fromRoomId)) return { ok: false, reason: '起点房间不存在' };
  if (!map.rooms.some((r) => r.id === toRoomId)) return { ok: false, reason: '终点房间不存在' };
  const { path, distance } = shortestPath(graph, fromRoomId, toRoomId);
  if (!path) {
    return { ok: false, reason: '该区域不连通', fromRoomId, toRoomId, warnings };
  }
  const segments = segmentByZone(map, path, { portals: graph.portals });
  const portalCount = countPortals(graph, path);
  if (portalCount > 0) warnings.push(`跨 ${portalCount} 处检查点/大门（需钥匙卡等级）`);
  return { ok: true, fromRoomId, toRoomId, roomPath: path, segments, distance, warnings, portalCount };
}

export function countPortals(graph, roomPath) {
  let count = 0;
  const portalPairs = new Set();
  for (const portal of graph.portals ?? []) {
    portalPairs.add(`${portal.from}>${portal.to}`);
    portalPairs.add(`${portal.to}>${portal.from}`);
  }
  for (let i = 1; i < roomPath.length; i += 1) {
    if (portalPairs.has(`${roomPath[i - 1]}>${roomPath[i]}`)) count += 1;
  }
  return count;
}

/** 路线上的 portal 跳转点（渲染时画虚线 + 提示） */
export function portalHops(graph, roomPath) {
  const map = new Map();
  for (const portal of graph.portals ?? []) {
    map.set(`${portal.from}>${portal.to}`, portal);
    map.set(`${portal.to}>${portal.from}`, portal);
  }
  const hops = [];
  for (let i = 1; i < roomPath.length; i += 1) {
    const portal = map.get(`${roomPath[i - 1]}>${roomPath[i]}`);
    if (portal) hops.push({ index: i, from: roomPath[i - 1], to: roomPath[i], label: portal.label, note: portal.note });
  }
  return hops;
}

export { MinHeap };
