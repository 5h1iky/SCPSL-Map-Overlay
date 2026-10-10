/**
 * RouteGeometry：房间内部的"贴地形"路径。
 *
 * 背景（用户反馈）：路线以前是一串**房间中心点**连成的直角折线，
 * 在圆形焚化炉（HCZ_Wayside，中间是炉坑）这类房间里不贴形状，还会穿过灰色墙区。
 *
 * 模型：图标是**白色剪影蒙版**（不透明 = 可走地面，透明 = 墙 / 房外），
 * `data/room-walkable.json`（tools/extract-walkable.mjs 生成）存了每个图标的
 * 64×64 可走位图。路线在蒙版里做最短路 + 折线拉直，天然贴着地形走、不穿墙。
 *
 * 坐标约定（与 render.js 画贴图一致）：
 *   贴图以 outline.center 为中心、按 (rotationY + viewRotation) 顺时针旋转，
 *   画布 1 格 = 15 世界单位。所以"投影坐标 → 图标局部"就是平移后**反转**同一个角度。
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const WALKABLE_GRID = 64;
/** 图标画布 = 1 格 = 15 世界单位（与 room-shape.js 的 CELL 一致） */
export const ROOM_CELL = 15;
const HALF = ROOM_CELL / 2;

/** 环形房间（走廊绕中间的坑转圈）——路线要绕着走。用户确认：走"绕远侧"的优弧 */
const RING_ICONS = new Set(['HCZ_Wayside']);

const DEFAULT_DATA_PATH = fileURLToPath(new URL('../../data/room-walkable.json', import.meta.url));

let table = null;

/** 加载可走位图（幂等）；文件缺失时返回 null，调用方回退到"门口→中心→门口" */
export function loadWalkableTable(path = DEFAULT_DATA_PATH) {
  if (table && table.path === path) return table;
  if (!existsSync(path)) {
    table = { path, masks: new Map(), grid: WALKABLE_GRID };
    return table;
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const masks = new Map();
  for (const [name, base64] of Object.entries(raw.icons ?? {})) {
    masks.set(name, new Uint8Array(Buffer.from(base64, 'base64')));
  }
  table = { path, masks, grid: raw.grid ?? WALKABLE_GRID };
  return table;
}

function maskOf(mapIcon) {
  if (!mapIcon) return null;
  return loadWalkableTable().masks.get(mapIcon) ?? null;
}

function bitAt(mask, u, v) {
  const index = v * WALKABLE_GRID + u;
  return (mask[index >> 3] >> (index & 7)) & 1;
}

/* ── 坐标变换：投影(band 局部) ↔ 图标局部 ─────────────────── */
function toLocal(p, center, rotDeg) {
  const t = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return { x: cos * dx + sin * dy, y: -sin * dx + cos * dy };
}

function fromLocal(l, center, rotDeg) {
  const t = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  return { x: center.x + cos * l.x - sin * l.y, y: center.y + sin * l.x + cos * l.y };
}

const clampCell = (n) => Math.max(0, Math.min(WALKABLE_GRID - 1, n));
const cellOfLocal = (l) => ({
  u: clampCell(Math.floor(((l.x + HALF) / ROOM_CELL) * WALKABLE_GRID)),
  v: clampCell(Math.floor(((l.y + HALF) / ROOM_CELL) * WALKABLE_GRID)),
});
const cellCenterLocal = (cell) => ({
  x: ((cell.u + 0.5) / WALKABLE_GRID) * ROOM_CELL - HALF,
  y: ((cell.v + 0.5) / WALKABLE_GRID) * ROOM_CELL - HALF,
});
const walkableLocal = (mask, l) => {
  const { u, v } = cellOfLocal(l);
  return bitAt(mask, u, v) === 1;
};

/** 最近的可走格（门口可能正好落在墙缺口的透明像素上） */
function nearestWalkable(mask, cell) {
  if (bitAt(mask, cell.u, cell.v)) return cell;
  for (let radius = 1; radius < WALKABLE_GRID; radius += 1) {
    for (let dv = -radius; dv <= radius; dv += 1) {
      for (let du = -radius; du <= radius; du += 1) {
        if (Math.max(Math.abs(du), Math.abs(dv)) !== radius) continue;
        const u = clampCell(cell.u + du);
        const v = clampCell(cell.v + dv);
        if (bitAt(mask, u, v)) return { u, v };
      }
    }
  }
  return cell;
}

const NEIGHBORS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/** 蒙版内最短路（A*，8 邻接、禁止切角穿墙） */
function findPath(mask, start, goal) {
  const N = WALKABLE_GRID;
  const size = N * N;
  const dist = new Float64Array(size).fill(Infinity);
  const prev = new Int32Array(size).fill(-1);
  const done = new Uint8Array(size);
  const inOpen = new Uint8Array(size);
  const index = (u, v) => v * N + u;
  const startIndex = index(start.u, start.v);
  const goalIndex = index(goal.u, goal.v);
  const heuristic = (i) => {
    const du = Math.abs((i % N) - goal.u);
    const dv = Math.abs(Math.floor(i / N) - goal.v);
    return Math.max(du, dv) + (Math.SQRT2 - 1) * Math.min(du, dv);
  };
  dist[startIndex] = 0;
  const open = [startIndex];
  inOpen[startIndex] = 1;
  while (open.length) {
    let bestPos = 0;
    let bestScore = Infinity;
    for (let i = 0; i < open.length; i += 1) {
      const score = dist[open[i]] + heuristic(open[i]);
      if (score < bestScore) { bestScore = score; bestPos = i; }
    }
    const current = open.splice(bestPos, 1)[0];
    if (current === goalIndex) break;
    if (done[current]) continue;
    done[current] = 1;
    const u = current % N;
    const v = Math.floor(current / N);
    for (const [du, dv] of NEIGHBORS) {
      const nu = u + du;
      const nv = v + dv;
      if (nu < 0 || nv < 0 || nu >= N || nv >= N) continue;
      if (!bitAt(mask, nu, nv)) continue;
      // 对角移动不允许"擦角"穿墙
      if (du !== 0 && dv !== 0 && (!bitAt(mask, u + du, v) || !bitAt(mask, u, v + dv))) continue;
      const next = index(nu, nv);
      if (done[next]) continue;
      const nd = dist[current] + (du !== 0 && dv !== 0 ? Math.SQRT2 : 1);
      if (nd < dist[next]) {
        dist[next] = nd;
        prev[next] = current;
        if (!inOpen[next]) { open.push(next); inOpen[next] = 1; }
      }
    }
  }
  if (!Number.isFinite(dist[goalIndex])) return null;
  const path = [];
  for (let cur = goalIndex; cur !== -1; cur = prev[cur]) path.push(cur);
  path.reverse();
  return path.map((i) => ({ u: i % N, v: Math.floor(i / N) }));
}

/** 线段是否始终在可走区域内（每 0.08 世界单位采样一次；必须比格子 0.234 细，否则会漏检擦墙角） */
function lineClear(mask, a, b) {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(dist / 0.08));
  for (let i = 0; i <= steps; i += 1) {
    const p = {
      x: a.x + ((b.x - a.x) * i) / steps,
      y: a.y + ((b.y - a.y) * i) / steps,
    };
    if (!walkableLocal(mask, p)) return false;
  }
  return true;
}

/** 折线拉直（string pulling）：去掉拐来拐去的格子台阶，只留视线可达的拐点 */
function stringPull(points, mask) {
  if (points.length <= 2) return points;
  const out = [points[0]];
  let anchor = 0;
  while (anchor < points.length - 1) {
    let farthest = anchor + 1;
    for (let j = points.length - 1; j > anchor + 1; j -= 1) {
      if (lineClear(mask, points[anchor], points[j])) { farthest = j; break; }
    }
    out.push(points[farthest]);
    anchor = farthest;
  }
  return out;
}

function dedupe(points) {
  const out = [];
  for (const p of points) {
    const last = out.at(-1);
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) out.push(p);
  }
  return out;
}

/**
 * 两点之间"蒙版内绕行"的一段（图标局部坐标）：A* 最短路 + 折线拉直。
 * 只在直线段真的穿墙时才用它。
 */
function legPath(mask, a, b) {
  const startCell = nearestWalkable(mask, cellOfLocal(a));
  const goalCell = nearestWalkable(mask, cellOfLocal(b));
  const cells = findPath(mask, startCell, goalCell);
  if (!cells) return null;
  const pulled = stringPull(cells.map(cellCenterLocal), mask);
  return dedupe([a, ...pulled, b]);
}

/** 环形房间：沿环走弧线（优弧 = 绕远侧，用户确认）。返回图标局部坐标点 */
function ringPath(mask, entryL, exitL, radius) {
  const a1 = Math.atan2(entryL.y, entryL.x);
  const a2 = Math.atan2(exitL.y, exitL.x);
  let minor = a2 - a1;
  while (minor <= -Math.PI) minor += Math.PI * 2;
  while (minor > Math.PI) minor -= Math.PI * 2;
  // 优弧：与劣弧反向、扫过角 > π
  const sweep = minor > 0 ? minor - Math.PI * 2 : minor + Math.PI * 2;
  const steps = Math.max(8, Math.ceil(Math.abs(sweep) / (Math.PI / 10)));
  const points = [entryL, { x: radius * Math.cos(a1), y: radius * Math.sin(a1) }];
  for (let i = 1; i <= steps; i += 1) {
    const angle = a1 + (sweep * i) / steps;
    points.push({ x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
  }
  points.push(exitL);
  return dedupe(points);
}

/** 环形走廊的平均半径（可走格到图标中心的平均距离） */
function ringRadiusOf(mask) {
  let sum = 0;
  let count = 0;
  for (let v = 0; v < WALKABLE_GRID; v += 1) {
    for (let u = 0; u < WALKABLE_GRID; u += 1) {
      if (!bitAt(mask, u, v)) continue;
      const c = cellCenterLocal({ u, v });
      sum += Math.hypot(c.x, c.y);
      count += 1;
    }
  }
  return count ? sum / count : ROOM_CELL * 0.28;
}

/**
 * 房间内部路径：进门口 → 贴合形状的内部路径 → 出门口。
 *
 * **骨架优先**（用户反馈）：正常路口（十字 / 丁字 / L 形）就走「门口 → 中心 → 门口」，
 * 在中心**直角转弯** —— 这既是真实走法，也不会斜切拐角穿墙。
 * 只有当某一段直线真的离开可走区域时（内墙缝隙、异形缺口等），才把**那一段**换成蒙版内绕行。
 * 环形房间（焚化炉）单独走环形弧线（优弧 / 绕远侧，用户确认）。
 *
 * @param {object} opts
 * @param {{x:number,y:number}} opts.center       房间中心（投影坐标，含分带偏移）
 * @param {number}  opts.rotationDeg              贴图旋转 = rotationY + viewRotation
 * @param {string}  opts.mapIcon                  贴图名（决定可走形状）；无贴图则纯骨架
 * @param {{x:number,y:number}|null} opts.entry   进门口坐标（投影坐标）；端点房间为 null
 * @param {{x:number,y:number}|null} opts.exit    出门口坐标
 * @returns {Array<{x:number,y:number}>} 投影坐标路径点（含 entry/exit）
 */
export function interiorPath({ center, rotationDeg = 0, mapIcon = null, entry = null, exit = null }) {
  const centerP = center ?? { x: 0, y: 0 };
  const rot = Number(rotationDeg) || 0;
  const entryL = entry ? toLocal(entry, centerP, rot) : null;
  const exitL = exit ? toLocal(exit, centerP, rot) : null;
  const mask = maskOf(mapIcon);

  let localPoints = null;
  if (mask && entryL && exitL && RING_ICONS.has(mapIcon)) {
    localPoints = ringPath(mask, entryL, exitL, ringRadiusOf(mask));
  } else if (mask && (entryL || exitL)) {
    // 骨架：门口 → 房间中心 → 门口（端点房间只有一端，中心自然成为起点/终点）。
    // 中心可走、且各段直线都不穿墙 → 用骨架（路口在中心**直角转弯**，符合真实走法）；
    // 否则（中心是坑 / 水域 / 内墙，如 HCZ_Testroom、HCZ_CrossingWater、HCZ_Nuke）→ 整段蒙版内绕行。
    const centerL = { x: 0, y: 0 };
    const skeleton = [entryL, centerL, exitL].filter(Boolean);
    const legsClear = skeleton.every((p, i) => i === 0 || lineClear(mask, skeleton[i - 1], p));
    const skeletonOk = walkableLocal(mask, centerL) && legsClear;
    const a = entryL ?? centerL;
    const b = exitL ?? centerL;
    localPoints = skeletonOk ? skeleton : (legPath(mask, a, b) ?? [a, b]);
  }
  if (!localPoints) {
    // 回退（Surface 等无贴图房间）：门口 → 中心 → 门口
    localPoints = [entryL, { x: 0, y: 0 }, exitL].filter(Boolean);
  }
  return dedupe(localPoints.map((l) => fromLocal(l, centerP, rot)));
}
