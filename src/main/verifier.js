/**
 * 对拍（§17 M0.5 / §2.3）：把 SCPSL_Template_export 导出的 snapshot 与离线生成结果逐项比对。
 *
 * 当前状态：本机没有 snapshot（没有 LabAPI 专用服），所以 runVerify 会明确报告"缺少样本"，
 * 而不是假报通过。等有 snapshot 时把文件丢进 test/fixtures/ 再跑即可。
 *
 * 比对项：房间数、每房间 name/shape/zone/网格坐标/世界坐标、连接器世界坐标、连接边集合双向一致。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const POS_TOLERANCE = 1e-3;

function gridKey(room) {
  const g = room.grid ?? room.mainCoords ?? null;
  const zone = room.zone?.name ?? room.zone;
  if (!g) return null;
  return `${zone}|${g.x},${g.y ?? 0},${g.z}`;
}

function near(a, b, tolerance = POS_TOLERANCE) {
  return Math.abs((a ?? 0) - (b ?? 0)) <= tolerance;
}

export function compareMapToSnapshot(map, snapshot) {
  const diffs = [];
  if (!snapshot?.rooms) {
    return { ok: false, diffs: [{ kind: 'format', message: 'snapshot 缺少 rooms 字段' }] };
  }
  if (Number(snapshot.seed) !== Number(map.seed)) {
    diffs.push({ kind: 'seed', message: `种子不一致：snapshot=${snapshot.seed} 生成=${map.seed}` });
  }
  if (map.rooms.length !== snapshot.rooms.length) {
    diffs.push({ kind: 'roomCount', message: `房间数不一致：snapshot=${snapshot.rooms.length} 生成=${map.rooms.length}` });
  }

  const byKey = new Map();
  for (const room of map.rooms) {
    const key = gridKey(room);
    if (key) byKey.set(key, room);
  }

  let matched = 0;
  for (const expected of snapshot.rooms) {
    const key = gridKey(expected);
    const actual = key ? byKey.get(key) : null;
    if (!actual) {
      diffs.push({ kind: 'missingRoom', message: `snapshot 房间 ${expected.id}（${key ?? '无网格坐标'}）在生成结果里找不到` });
      continue;
    }
    matched += 1;
    const nameA = actual.name?.name ?? actual.name;
    const nameE = expected.name?.name ?? expected.name;
    if (nameA !== nameE) diffs.push({ kind: 'roomName', message: `${key} name 不一致：${nameE} vs ${nameA}` });
    const shapeA = actual.shape?.name ?? actual.shape;
    const shapeE = expected.shape?.name ?? expected.shape;
    if (shapeA !== shapeE) diffs.push({ kind: 'roomShape', message: `${key} shape 不一致：${shapeE} vs ${shapeA}` });
    if (!near(actual.position.x, expected.position.x) || !near(actual.position.y, expected.position.y) || !near(actual.position.z, expected.position.z)) {
      diffs.push({ kind: 'position', message: `${key} 世界坐标不一致：${JSON.stringify(expected.position)} vs ${JSON.stringify(actual.position)}` });
    }
    if (!near(actual.rotationY ?? 0, expected.rotationY ?? 0, 0.01)) {
      diffs.push({ kind: 'rotation', message: `${key} rotationY 不一致：${expected.rotationY} vs ${actual.rotationY}` });
    }
    const expectedConnectors = expected.connectorInstances ?? [];
    if (expectedConnectors.length !== (actual.connectorInstances ?? []).length) {
      diffs.push({ kind: 'connectorCount', message: `${key} 连接器数量不一致：${expectedConnectors.length} vs ${actual.connectorInstances.length}` });
    } else {
      for (let i = 0; i < expectedConnectors.length; i += 1) {
        const e = expectedConnectors[i].worldPosition;
        const a = actual.connectorInstances[i].worldPosition;
        if (!near(a.x, e.x) || !near(a.y, e.y) || !near(a.z, e.z)) {
          diffs.push({ kind: 'connectorPosition', message: `${key} 连接器#${i} 世界坐标不一致` });
        }
      }
    }
  }

  // 连接边双向一致：用网格坐标表示的边集合比对
  const idToKey = new Map();
  for (const room of map.rooms) idToKey.set(room.id, gridKey(room));
  const generatedEdges = new Set();
  for (const edge of map.connectorAdjacency ?? []) {
    const a = idToKey.get(edge.from);
    const b = idToKey.get(edge.to);
    if (a && b) generatedEdges.add([a, b].sort().join(' -- '));
  }
  const expectedEdges = new Set();
  const snapshotIdToKey = new Map(snapshot.rooms.map((room) => [room.id, gridKey(room)]));
  for (const room of snapshot.rooms) {
    for (const other of room.connectedRoomIds ?? []) {
      const a = gridKey(room);
      const b = snapshotIdToKey.get(other);
      if (a && b) expectedEdges.add([a, b].sort().join(' -- '));
    }
  }
  for (const edge of expectedEdges) {
    if (!generatedEdges.has(edge)) diffs.push({ kind: 'missingEdge', message: `snapshot 有连接但生成结果没有：${edge}` });
  }
  for (const edge of generatedEdges) {
    if (!expectedEdges.has(edge)) diffs.push({ kind: 'extraEdge', message: `生成结果有连接但 snapshot 没有：${edge}` });
  }

  return {
    ok: diffs.length === 0,
    diffs,
    summary: {
      seed: map.seed,
      snapshotRooms: snapshot.rooms.length,
      generatedRooms: map.rooms.length,
      matchedRooms: matched,
      snapshotEdges: expectedEdges.size,
      generatedEdges: generatedEdges.size,
    },
  };
}

export function findSnapshots(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^mapgen-snapshot-.*\.json$/i.test(name))
    .map((name) => join(dir, name));
}

/**
 * @param {{ appRoot: string, seeds?: number[]|null, fixturesDir?: string }} options
 */
export async function runVerify({ appRoot, seeds = null, fixturesDir = null } = {}) {
  const dir = fixturesDir ?? join(appRoot, 'test/fixtures');
  const files = findSnapshots(dir);
  if (files.length === 0) {
    return {
      ok: null,
      skipped: true,
      text: [
        '对拍未执行：没有找到 snapshot 样本。',
        `把 SCPSL_Template_export 导出的 mapgen-snapshot-<版本>-seed-<种子>.json 放进：${dir}`,
        '',
        '生成 snapshot 的步骤（需要一台装了 LabAPI 的 SCP:SL 专用服）：',
        '  1. 把 SCPSL_Template_export.dll 放进 %APPDATA%/SCP Secret Laboratory/LabAPI/plugins/global/',
        '  2. 启动服务器并让它生成地图；插件会写出 mapgen-snapshot-*.json',
        '  3. 把文件拷到 test/fixtures/ 后重跑本对拍',
        '',
        '注意：没有对拍 ≠ 生成器正确。本工具当前属于"未经 ground truth 验证"的状态，',
        '      界面上会明确标注这一点（版本闸门只比较版本号，不能证明布局一致）。',
      ].join('\n'),
    };
  }
  const { AppController } = await import('./app-controller.js');
  const controller = new AppController({
    generatorEntry: join(appRoot, 'data/vendor/map-seed/src/index.js'),
    poiTablePath: join(appRoot, 'data/poi-map-14.2.7.json'),
  });
  await controller.init();

  const lines = [];
  let allOk = true;
  let compared = 0;
  for (const file of files) {
    const snapshot = JSON.parse(readFileSync(file, 'utf8'));
    if (seeds && !seeds.includes(Number(snapshot.seed))) continue;
    const generated = controller.mapService.generate(Number(snapshot.seed));
    if (!generated.map) {
      lines.push(`✗ ${file}：生成失败 ${generated.error}`);
      allOk = false;
      continue;
    }
    const result = compareMapToSnapshot(generated.map, snapshot);
    compared += 1;
    lines.push(`${result.ok ? '✓' : '✗'} seed ${snapshot.seed}：房间 ${result.summary.matchedRooms}/${result.summary.snapshotRooms} 匹配，边 ${result.summary.generatedEdges}/${result.summary.snapshotEdges}`);
    if (!result.ok) {
      allOk = false;
      for (const diff of result.diffs.slice(0, 20)) lines.push(`    [${diff.kind}] ${diff.message}`);
      if (result.diffs.length > 20) lines.push(`    …其余 ${result.diffs.length - 20} 条省略`);
    }
  }
  if (compared === 0) {
    return { ok: null, skipped: true, text: `找到 ${files.length} 个 snapshot，但没有匹配指定种子的样本。` };
  }
  return { ok: allOk, skipped: false, compared, text: lines.join('\n') };
}
