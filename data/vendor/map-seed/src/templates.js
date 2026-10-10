import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MapGenerationError } from './errors.js';

const manifestPath = fileURLToPath(new URL('../data/manifest.json', import.meta.url));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const cache = new Map();

export function getDefaultVersion() {
  return manifest.defaultVersion;
}

export function getSupportedVersions() {
  return Object.keys(manifest.versions);
}

export function loadBundledTemplate(version = manifest.defaultVersion) {
  const fileName = manifest.versions[version];
  if (!fileName) {
    throw new MapGenerationError(`Unsupported game version: ${version}`, {
      supportedVersions: getSupportedVersions()
    });
  }
  if (!cache.has(version)) {
    const path = fileURLToPath(new URL(`../data/${fileName}`, import.meta.url));
    const template = JSON.parse(readFileSync(path, 'utf8'));
    validateTemplate(template, version);
    compileTemplate(template);
    cache.set(version, template);
  }
  return cache.get(version);
}

// Convert all seed-independent template work into compact lookup tables once.
// The raw export remains the source of truth; compiled fields are private runtime data.
function compileTemplate(template) {
  const roomById = new Map(template.roomTemplates.map((room) => [room.id, room]));
  for (let roomIndex = 0; roomIndex < template.roomTemplates.length; roomIndex += 1) {
    const room = template.roomTemplates[roomIndex];
    room._index = roomIndex;
    room._connectorTransforms = new Map();
    room._compiledHoliday = new Array(4);
    for (let holiday = 0; holiday < 4; holiday += 1) {
      const compiledResolution = room.holidayResolutions?.[holiday];
      if (compiledResolution) {
        const resolved = roomById.get(compiledResolution.templateId);
        if (!resolved) throw new MapGenerationError(`Missing holiday room template: ${compiledResolution.templateId}`);
        room._compiledHoliday[holiday] = { template: resolved, resolution: compiledResolution.resolution };
        continue;
      }
      const variant = (room.holidayVariants ?? []).find((item) => (item.holiday?.value ?? item.holiday) === holiday);
      if (!variant || variant.resultState === 'serialized-null' || !variant.templateId) {
        room._compiledHoliday[holiday] = { template: room, resolution: variant?.resultState === 'serialized-null' ? 'serialized-null' : 'base' };
      } else {
        const resolved = roomById.get(variant.templateId);
        if (!resolved) throw new MapGenerationError(`Missing holiday room template: ${variant.templateId}`);
        room._compiledHoliday[holiday] = { template: resolved, resolution: 'resolved' };
      }
    }
    room._compiledConnectors = template.compiledSchemaVersion
      ? room.connectorPoints
      : (room.connectorPoints ?? []).filter((point) => point.activeSelf !== false).map((point, fallbackIndex) => ({
        index: point.index ?? fallbackIndex,
        runtimeType: point.runtimeType ?? 'unknown',
        localPosition: { x: point.localPosition?.x ?? 0, y: point.localPosition?.y ?? 0, z: point.localPosition?.z ?? 0 },
        localRotation: normalizeQuaternion(point.localRotation)
      }));
  }
  for (const generator of template.generators) {
    if (generator.atlases) generator._compiledAtlases = generator.atlases.map((atlas) => compileAtlas(atlas, template.glyphShapePairs));
    if (generator.compatibleRoomTemplateIds) {
      generator._compiledCandidates = Array.from({ length: 4 }, (_, holiday) => generator.compatibleRoomTemplateIds.map((id) => {
        const baseTemplate = roomById.get(id);
        const resolved = baseTemplate._compiledHoliday[holiday];
        return { template: resolved.template, baseTemplate, resolution: resolved.resolution };
      }));
      generator._candidateSets = Array.from({ length: 4 }, () => new Map());
    }
  }
  template._roomById = roomById;
  template._generators = template.compiledSchemaVersion
    ? template.generators
    : [...template.generators].sort((a, b) => a.index - b.index);
  return template;
}

function compileAtlas(atlas, pairs) {
  if (atlas.cells) return atlas;
  const bytes = Buffer.from(atlas.rgbaBase64, 'base64');
  const result = [];
  let step = 1;
  let startX = 0;
  let aligned = false;
  const byColor = new Map(pairs.map((pair) => [`${pair.color.r},${pair.color.g},${pair.color.b}`, pair]));
  const findPair = (x, y) => {
    const offset = (y * atlas.width + x) * 4;
    const r = bytes[offset]; const g = bytes[offset + 1]; const b = bytes[offset + 2];
    return byColor.get(`${r},${g},${b}`) ?? pairs.find((candidate) =>
      Math.abs(candidate.color.r - r) <= 5 && Math.abs(candidate.color.g - g) <= 5 && Math.abs(candidate.color.b - b) <= 5);
  };
  for (let y = 0; y < atlas.height; y += step) {
    for (let x = startX; x < atlas.width; x += step) {
      const pair = findPair(x, y);
      if (!pair) continue;
      if (!aligned) {
        x += pair.centerOffset.x;
        y += pair.centerOffset.y;
        step = 3;
        startX = x % 3;
        aligned = true;
      }
      result.push({
        coords: { x: Math.floor(x / 3), y: Math.floor(y / 3) },
        roomShape: pair.shape,
        specificRooms: pair.specificRooms ?? [],
        rotations: pair.rotations
      });
    }
  }
  const minY = Math.min(...result.map((cell) => cell.coords.y));
  const maxY = Math.max(...result.map((cell) => cell.coords.y));
  const keyStride = maxY - minY + 3;
  for (const cell of result) {
    cell.key = cell.coords.x * keyStride + cell.coords.y;
    cell.candidateKey = `${cell.roomShape?.value ?? cell.roomShape}:${cell.specificRooms.map((room) => room?.value ?? room).join(',')}`;
  }
  return { name: atlas.name, keyStride, cells: result };
}

function normalizeQuaternion(quaternion = {}) {
  const length = Math.hypot(quaternion.x ?? 0, quaternion.y ?? 0, quaternion.z ?? 0, quaternion.w ?? 0);
  if (length === 0) return { x: 0, y: 0, z: 0, w: 1 };
  return { x: quaternion.x / length, y: quaternion.y / length, z: quaternion.z / length, w: quaternion.w / length };
}

export function validateTemplate(template, version = '<unknown>') {
  if (!template || !Array.isArray(template.generators) || !Array.isArray(template.roomTemplates)) {
    throw new MapGenerationError(`Invalid bundled template for ${version}`);
  }
  const ids = new Set(template.roomTemplates.map((room) => room.id));
  if (ids.size !== template.roomTemplates.length) {
    throw new MapGenerationError(`Duplicate room template id in ${version}`);
  }
  for (const pair of template.glyphShapePairs ?? []) {
    if (!Array.isArray(pair.rotations) || pair.rotations.length === 0) {
      throw new MapGenerationError(`Glyph ${pair.index} has no rotations`, { version });
    }
  }
  for (const generator of template.generators) {
    for (const id of generator.compatibleRoomTemplateIds ?? []) {
      if (!ids.has(id)) throw new MapGenerationError(`Missing room template: ${id}`, { version, generator: generator.index });
    }
    if (generator.prefabTemplateId && !ids.has(generator.prefabTemplateId)) {
      throw new MapGenerationError(`Missing single-room template: ${generator.prefabTemplateId}`, { version, generator: generator.index });
    }
    for (const atlas of generator.atlases ?? []) {
      if (Array.isArray(atlas.cells)) continue;
      const bytes = Buffer.from(atlas.rgbaBase64, 'base64');
      if (bytes.length !== atlas.width * atlas.height * 4) {
        throw new MapGenerationError(`Invalid atlas pixels: ${atlas.name}`, { version, generator: generator.index });
      }
    }
  }
  return template;
}
