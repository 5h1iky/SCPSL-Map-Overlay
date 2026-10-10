import { readFileSync, writeFileSync } from 'node:fs';

const sourcePath = new URL('../data/mapgen-raw-14.2.7.json', import.meta.url);
const outputPath = new URL('../data/mapgen-compiled-14.2.7.json', import.meta.url);
const source = JSON.parse(readFileSync(sourcePath, 'utf8'));

function enumValue(value) {
  return typeof value === 'object' && value !== null ? value.value : value;
}

function normalizeQuaternion(quaternion = {}) {
  const length = Math.hypot(quaternion.x ?? 0, quaternion.y ?? 0, quaternion.z ?? 0, quaternion.w ?? 0);
  if (length === 0) return { x: 0, y: 0, z: 0, w: 1 };
  return {
    x: quaternion.x / length,
    y: quaternion.y / length,
    z: quaternion.z / length,
    w: quaternion.w / length
  };
}

function decodeAtlas(atlas, pairs) {
  const bytes = Buffer.from(atlas.rgbaBase64, 'base64');
  const cells = [];
  let step = 1;
  let startX = 0;
  let aligned = false;

  for (let y = 0; y < atlas.height; y += step) {
    for (let x = startX; x < atlas.width; x += step) {
      const offset = (y * atlas.width + x) * 4;
      const r = bytes[offset];
      const g = bytes[offset + 1];
      const b = bytes[offset + 2];
      const pair = pairs.find((candidate) =>
        Math.abs(candidate.color.r - r) <= 5 &&
        Math.abs(candidate.color.g - g) <= 5 &&
        Math.abs(candidate.color.b - b) <= 5
      );
      if (!pair) continue;
      if (!aligned) {
        x += pair.centerOffset.x;
        y += pair.centerOffset.y;
        step = 3;
        startX = x % 3;
        aligned = true;
      }
      cells.push({
        coords: { x: Math.floor(x / 3), y: Math.floor(y / 3) },
        roomShape: pair.shape,
        specificRooms: pair.specificRooms ?? [],
        rotations: pair.rotations
      });
    }
  }
  const minY = Math.min(...cells.map((cell) => cell.coords.y));
  const maxY = Math.max(...cells.map((cell) => cell.coords.y));
  const keyStride = maxY - minY + 3;
  for (const cell of cells) {
    cell.key = cell.coords.x * keyStride + cell.coords.y;
    cell.candidateKey = `${enumValue(cell.roomShape)}:${cell.specificRooms.map(enumValue).join(',')}`;
  }
  return { name: atlas.name, keyStride, cells };
}

function compactRoom(room) {
  const holidayResolutions = Array.from({ length: 4 }, (_, holiday) => {
    const variant = (room.holidayVariants ?? []).find((item) => enumValue(item.holiday) === holiday);
    if (!variant) return { templateId: room.id, resolution: 'base' };
    if (variant.resultState === 'serialized-null' || !variant.templateId) {
      return { templateId: room.id, resolution: 'serialized-null' };
    }
    return { templateId: variant.templateId, resolution: 'resolved' };
  });
  return {
    id: room.id,
    prefabName: room.prefabName,
    name: room.name,
    shape: room.shape,
    specialRoom: room.specialRoom,
    minAmount: room.minAmount,
    maxAmount: room.maxAmount,
    chanceMultiplier: room.chanceMultiplier,
    adjacentChanceMultiplier: room.adjacentChanceMultiplier,
    connectorPoints: (room.connectorPoints ?? []).filter((point) => point.activeSelf !== false).map((point, fallbackIndex) => ({
      index: point.index ?? fallbackIndex,
      runtimeType: point.runtimeType ?? 'unknown',
      localPosition: { x: point.localPosition?.x ?? 0, y: point.localPosition?.y ?? 0, z: point.localPosition?.z ?? 0 },
      localRotation: normalizeQuaternion(point.localRotation)
    })),
    holidayResolutions
  };
}

function compactGenerator(generator) {
  const result = {
    index: generator.index,
    kind: generator.kind,
    targetZone: generator.targetZone
  };
  for (const key of ['zoneHeight', 'compatibleRoomTemplateIds', 'hczGeneratorIndex', 'hardPositionOffset', 'hardRotationOffset',
    'prefabTemplateId', 'spawnPosition', 'spawnRotation', 'effectiveRotation', 'effectiveRotationY']) {
    if (generator[key] !== undefined) result[key] = generator[key];
  }
  if (generator.atlases) result.atlases = generator.atlases.map((atlas) => decodeAtlas(atlas, source.glyphShapePairs));
  return result;
}

const compiled = {
  compiledSchemaVersion: 1,
  schemaVersion: source.schemaVersion,
  game: source.game,
  gridScale: source.gridScale,
  templateStats: {
    glyphCount: source.glyphShapePairs.length,
    roomTemplateCount: source.roomTemplates.length,
    atlasCount: source.generators.reduce((count, generator) => count + (generator.atlases?.length ?? 0), 0)
  },
  generators: source.generators.map(compactGenerator),
  roomTemplates: source.roomTemplates.map(compactRoom)
};

writeFileSync(outputPath, `${JSON.stringify(compiled)}\n`);
console.log(`Compiled ${compiled.templateStats.atlasCount} atlases to ${outputPath.pathname}`);
