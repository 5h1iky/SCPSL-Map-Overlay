import { DotNetRandom, normalizeSeed } from './random.js';
import { MapGenerationError } from './errors.js';

const HOLIDAYS = Object.freeze({ None: 0, Christmas: 1, Halloween: 2, AprilFools: 3 });
const CHECKPOINT_ROOM_VALUE = 13;
const STRAIGHT_SHAPE_VALUE = 2;

export function generateFromTemplate(template, seed, options = {}) {
  const normalizedSeed = normalizeSeed(seed);
  const holiday = normalizeHoliday(options.holiday ?? template.game?.activeHoliday ?? 'None');
  const gridScale = template.gridScale ?? { x: 15, y: 100, z: 15 };
  const random = new DotNetRandom(normalizedSeed);
  const templates = template._roomById ?? new Map(template.roomTemplates.map((room) => [room.id, room]));
  const generatorResults = [];
  const generatedRooms = [];
  const generationTrace = [];
  const atlasSelections = [];

  const generators = template._generators ?? [...template.generators].sort((a, b) => a.index - b.index);
  for (const generator of generators) {
    if (generator.kind === 'atlas' || generator.kind === 'entrance') {
      const result = generateAtlas(generator, { random, templates, holiday, template, generatorResults, gridScale });
      generatorResults[generator.index] = result;
      generatedRooms.push(...result.rooms);
      generationTrace.push(...result.trace);
      atlasSelections.push(result.atlasSelection);
      continue;
    }
    if (generator.kind === 'single-room') {
      const result = generateSingleRoom(generator, { templates, holiday, gridScale });
      generatedRooms.push(result.room);
      generationTrace.push(result.trace);
      continue;
    }
    throw new MapGenerationError(`Unsupported generator kind: ${generator.kind}`, { generatorIndex: generator.index });
  }

  const rooms = generatedRooms.map((room, index) => ({
    ...room,
    id: `room-${String(index).padStart(3, '0')}`,
    adjacentRoomIds: [],
    connectedRoomIds: []
  }));
  const spatialAdjacency = connectSpatialNeighbors(rooms);
  const connectorAdjacency = connectRoomConnectors(rooms);
  const zones = buildZones(rooms, gridScale);
  const warnings = [];
  const exportedHoliday = normalizeHoliday(template.game?.activeHoliday ?? 'None');
  if (holiday.value !== exportedHoliday.value) {
    warnings.push(`Requested holiday ${holiday.name}; bundled template base was exported with ${exportedHoliday.name}. Available holiday variants were resolved where present.`);
  }

  return {
    schemaVersion: 1,
    type: 'scpsl-map',
    source: {
      gameVersion: template.game?.version ?? 'unknown',
      buildType: template.game?.buildType ?? 'unknown',
      rawSchemaVersion: template.schemaVersion ?? null,
      activeHolidayInTemplate: exportedHoliday
    },
    seed: normalizedSeed,
    holiday,
    gridScale,
    rooms,
    zones,
    spatialAdjacency,
    connectorAdjacency,
    atlasSelections,
    generationTrace,
    diagnostics: {
      roomCount: rooms.length,
      zoneCount: zones.length,
      adjacencyCount: spatialAdjacency.length,
      connectorCount: rooms.reduce((count, room) => count + room.connectorInstances.length, 0),
      connectorAdjacencyCount: connectorAdjacency.length,
      unpairedConnectorCount: rooms.reduce((count, room) => count + room.connectorInstances.filter((connector) => connector.connectedRoomIds.length === 0).length, 0),
      atlasCount: atlasSelections.length,
      generatorCount: generators.length,
      warnings
    }
  };
}

function generateAtlas(generator, context) {
  const { random, templates, holiday, template, generatorResults, gridScale } = context;
  const atlases = generator._compiledAtlases ?? generator.atlases;
  const atlasIndex = random.next(atlases.length);
  const atlas = atlases[atlasIndex];
  const interpreted = interpretAtlas(atlas, random, template.glyphShapePairs ?? []);
  const baseCells = interpreted.map(cloneCell);
  const positionOffset = generator.kind === 'entrance'
    ? getEntranceOffset(generator, baseCells, generatorResults, gridScale)
    : { x: 0, y: 0, z: 0 };

  shuffle(interpreted, random);
  const spawned = new Map();
  const counts = new Uint16Array(template.roomTemplates.length);
  const rooms = [];
  const trace = [];

  for (let spawnedIndex = 0; spawnedIndex < interpreted.length; spawnedIndex += 1) {
    const cell = interpreted[spawnedIndex];
    const selected = selectRoom(generator, cell, templates, holiday, counts, spawned, random);
    const duplicateId = counts[selected.template._index];
    const position = {
      x: cell.coords.x * gridScale.x + positionOffset.x,
      y: generator.zoneHeight + positionOffset.y,
      z: cell.coords.y * gridScale.z + positionOffset.z
    };
    const rotationY = normalizeAngle(cell.rotationY + (generator.hardRotationOffset ?? 0));
    rooms.push(makeRoom({
      generator,
      spawnedIndex,
      atlasCell: cell.coords,
      selected,
      duplicateId,
      position,
      rotationY,
      gridScale
    }));
    spawned.set(cell._key, selected.template._index);
    counts[selected.template._index] = duplicateId + 1;
    trace.push({
      generatorIndex: generator.index,
      spawnedIndex,
      atlasIndex,
      atlasName: atlas.name,
      coords: { ...cell.coords },
      roomShape: cell.roomShape,
      specificRooms: cell.specificRooms,
      rotationY: cell.rotationY,
      chosenCandidateTemplateId: selected.template.id,
      baseCandidateTemplateId: selected.baseTemplate.id,
      holidayResolution: selected.resolution
    });
  }

  return {
    rooms,
    trace,
    baseCells,
    zoneHeight: generator.zoneHeight,
    atlasSelection: {
      generatorIndex: generator.index,
      zone: generator.targetZone,
      atlasIndex,
      atlasName: atlas.name,
      cellCount: baseCells.length
    }
  };
}

function generateSingleRoom(generator, { templates, holiday, gridScale }) {
  const baseTemplate = templates.get(generator.prefabTemplateId);
  const selected = resolveHoliday(baseTemplate, templates, holiday);
  const effectiveRotation = generator.effectiveRotation ?? normalizeQuaternion(generator.spawnRotation);
  const rotationY = generator.effectiveRotationY ?? quaternionToYaw(effectiveRotation);
  const room = makeRoom({
    generator,
    spawnedIndex: 0,
    atlasCell: null,
    selected: { ...selected, baseTemplate },
    duplicateId: 0,
    position: { ...generator.spawnPosition },
    rotationY,
    gridScale
  });
  return {
    room,
    trace: {
      generatorIndex: generator.index,
      spawnedIndex: 0,
      atlasIndex: null,
      atlasName: null,
      coords: null,
      roomShape: selected.template.shape,
      specificRooms: [],
      rotationY,
      chosenCandidateTemplateId: selected.template.id,
      baseCandidateTemplateId: baseTemplate.id,
      holidayResolution: selected.resolution
    }
  };
}

function interpretAtlas(atlas, random, pairs) {
  if (atlas.cells) {
    const minY = atlas.minY ?? Math.min(...atlas.cells.map((cell) => cell.coords.y));
    const maxY = atlas.maxY ?? Math.max(...atlas.cells.map((cell) => cell.coords.y));
    const stride = atlas.keyStride ?? maxY - minY + 3;
    return atlas.cells.map((cell) => ({
      coords: { ...cell.coords },
      roomShape: cell.roomShape,
      specificRooms: cell.specificRooms,
      rotationY: cell.rotations[random.next(cell.rotations.length)],
      _key: cell.key ?? cell.coords.x * stride + cell.coords.y,
      _keyStride: stride,
      _candidateKey: cell.candidateKey ?? `${enumValue(cell.roomShape)}:${cell.specificRooms.map(enumValue).join(',')}`
    }));
  }
  const bytes = Buffer.from(atlas.rgbaBase64, 'base64');
  const result = [];
  let step = 1;
  let startX = 0;
  let aligned = false;
  const getPixel = (x, y) => {
    const offset = (y * atlas.width + x) * 4;
    return { r: bytes[offset], g: bytes[offset + 1], b: bytes[offset + 2] };
  };

  for (let y = 0; y < atlas.height; y += step) {
    for (let x = startX; x < atlas.width; x += step) {
      const pixel = getPixel(x, y);
      const pair = pairs.find((candidate) =>
        Math.abs(candidate.color.r - pixel.r) <= 5 &&
        Math.abs(candidate.color.g - pixel.g) <= 5 &&
        Math.abs(candidate.color.b - pixel.b) <= 5
      );
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
        rotationY: pair.rotations[random.next(pair.rotations.length)]
      });
    }
  }
  return result;
}

function selectRoom(generator, cell, templates, holiday, counts, spawned, random) {
  const special = cell.specificRooms.length !== 0;
  const weighted = [];
  let totalWeight = 0;

  let candidates = generator._compiledCandidates?.[holiday.value] ?? generator.compatibleRoomTemplateIds.map((baseId) => {
    const baseTemplate = templates.get(baseId);
    const resolved = resolveHoliday(baseTemplate, templates, holiday);
    return { template: resolved.template, baseTemplate, resolution: resolved.resolution };
  });
  const candidateSetCache = generator._candidateSets?.[holiday.value];
  if (candidateSetCache) {
    const candidateKey = cell._candidateKey ?? `${enumValue(cell.roomShape)}:${cell.specificRooms.map(enumValue).join(',')}`;
    const cached = candidateSetCache.get(candidateKey);
    if (cached) {
      candidates = cached;
    } else {
      candidates = candidates.filter(({ template: candidate }) =>
        special === Boolean(candidate.specialRoom) &&
        (!special || cell.specificRooms.some((name) => enumValue(name) === enumValue(candidate.name))) &&
        enumValue(candidate.shape) === enumValue(cell.roomShape)
      );
      candidateSetCache.set(candidateKey, candidates);
    }
  }
  for (const resolved of candidates) {
    const baseTemplate = resolved.baseTemplate;
    const candidate = resolved.template;
    const count = counts[candidate._index];
    if (count >= candidate.maxAmount) continue;
    if (!candidateSetCache) {
      const nameMatches = !special || cell.specificRooms.some((name) => enumValue(name) === enumValue(candidate.name));
      if (special !== Boolean(candidate.specialRoom) || !nameMatches || enumValue(candidate.shape) !== enumValue(cell.roomShape)) continue;
    }
    if (count < candidate.minAmount) {
      return { template: candidate, baseTemplate, resolution: resolved.resolution };
    }

    let weight = Math.fround(candidate.chanceMultiplier);
    let adjacentCount = 0;
    if (spawned instanceof Map) {
      adjacentCount += spawned.get(cell._key + cell._keyStride) === candidate._index ? 1 : 0;
      adjacentCount += spawned.get(cell._key - cell._keyStride) === candidate._index ? 1 : 0;
      adjacentCount += spawned.get(cell._key + 1) === candidate._index ? 1 : 0;
      adjacentCount += spawned.get(cell._key - 1) === candidate._index ? 1 : 0;
    } else {
      for (const previous of spawned) {
        const adjacent = (previous.coords.x === cell.coords.x && Math.abs(previous.coords.y - cell.coords.y) === 1) ||
          (previous.coords.y === cell.coords.y && Math.abs(previous.coords.x - cell.coords.x) === 1);
        if (previous.templateId === candidate.id && adjacent) adjacentCount += 1;
      }
    }
    for (let adjacent = 0; adjacent < adjacentCount; adjacent += 1) {
        weight = Math.fround(weight * Math.fround(candidate.adjacentChanceMultiplier));
    }
    totalWeight = Math.fround(totalWeight + weight);
    weighted.push({ template: candidate, baseTemplate, resolution: resolved.resolution, weight });
  }

  if (weighted.length === 0 || totalWeight === 0) {
    throw new MapGenerationError('No compatible room candidate', {
      generatorIndex: generator.index,
      zone: generator.targetZone,
      coords: cell.coords,
      shape: cell.roomShape
    });
  }
  const roll = random.nextDouble() * totalWeight;
  let accumulated = 0;
  for (const candidate of weighted) {
    accumulated = Math.fround(accumulated + candidate.weight);
    if (roll <= accumulated) return candidate;
  }
  throw new MapGenerationError('Weighted room selection failed', { generatorIndex: generator.index });
}

function getEntranceOffset(generator, cells, generatorResults, gridScale) {
  const hcz = generatorResults[generator.hczGeneratorIndex];
  if (!hcz) throw new MapGenerationError('Entrance generator requires HCZ to run first');
  const checkpoints = (items) => items.filter((cell) =>
    enumValue(cell.roomShape) === STRAIGHT_SHAPE_VALUE &&
    cell.specificRooms.some((room) => enumValue(room) === CHECKPOINT_ROOM_VALUE)
  );
  const hczPoints = checkpoints(hcz.baseCells);
  const entrancePoints = checkpoints(cells);
  if (hczPoints.length !== 2 || entrancePoints.length !== 2) {
    throw new MapGenerationError('HCZ/EZ require exactly two checkpoints', {
      hczCount: hczPoints.length,
      entranceCount: entrancePoints.length
    });
  }
  const centroid = (items, height) => ({
    x: items.reduce((sum, cell) => sum + cell.coords.x * gridScale.x, 0) / items.length,
    y: height,
    z: items.reduce((sum, cell) => sum + cell.coords.y * gridScale.z, 0) / items.length
  });
  const hczCenter = centroid(hczPoints, hcz.zoneHeight);
  const entranceCenter = centroid(entrancePoints, generator.zoneHeight);
  return {
    x: hczCenter.x - entranceCenter.x + (generator.hardPositionOffset?.x ?? 0),
    y: hczCenter.y - entranceCenter.y + (generator.hardPositionOffset?.y ?? 0),
    z: hczCenter.z - entranceCenter.z + (generator.hardPositionOffset?.z ?? 0)
  };
}

function makeRoom({ generator, spawnedIndex, atlasCell, selected, duplicateId, position, rotationY, gridScale }) {
  const angle = normalizeAngle(rotationY);
  return {
    id: null,
    generation: { generatorIndex: generator.index, spawnedIndex },
    atlasCell: atlasCell ? { ...atlasCell } : null,
    prefabTemplateId: selected.template.id,
    basePrefabTemplateId: selected.baseTemplate.id,
    prefabName: selected.template.prefabName,
    duplicateId,
    holidayResolution: selected.resolution,
    zone: generator.targetZone,
    name: selected.template.name,
    shape: selected.template.shape,
    position,
    grid: {
      x: Math.round(position.x / gridScale.x),
      y: Math.round(position.y / gridScale.y),
      z: Math.round(position.z / gridScale.z)
    },
    rotationY: angle,
    rotation: yawQuaternion(angle),
    connectedRoomIds: [],
    connectorInstances: makeConnectorInstances(selected.template, position, angle),
    render: {
      mapPosition: { x: -position.x, y: position.z },
      zonePosition: null,
      angleDeg: -angle,
      shape: selected.template.shape?.name ?? selected.template.shape,
      label: selected.template.name?.name ?? selected.template.name,
      iconKey: selected.template.prefabName
    }
  };
}

function makeConnectorInstances(template, position, rotationY) {
  const connectorCache = template._connectorTransforms;
  let compiled = connectorCache?.get(rotationY);
  if (!compiled) {
    const points = template._compiledConnectors ?? (template.connectorPoints ?? []).filter((point) => point.activeSelf !== false).map((point, fallbackIndex) => ({
      index: point.index ?? fallbackIndex,
      runtimeType: point.runtimeType ?? 'unknown',
      localPosition: { x: point.localPosition?.x ?? 0, y: point.localPosition?.y ?? 0, z: point.localPosition?.z ?? 0 },
      localRotation: normalizeQuaternion(point.localRotation)
    }));
    compiled = points.map((point) => {
      const worldOffset = rotateYaw(point.localPosition, rotationY);
      return {
        index: point.index,
        runtimeType: point.runtimeType,
        localPosition: point.localPosition,
        localRotation: point.localRotation,
        worldOffset,
        worldRotation: multiplyQuaternion(yawQuaternion(rotationY), point.localRotation),
        direction: directionFromOffset(worldOffset)
      };
    });
    connectorCache?.set(rotationY, compiled);
  }
  return compiled.map((point) => ({
    index: point.index,
    runtimeType: point.runtimeType,
    localPosition: { ...point.localPosition },
    localRotation: { ...point.localRotation },
    worldPosition: { x: position.x + point.worldOffset.x, y: position.y + point.localPosition.y, z: position.z + point.worldOffset.z },
    worldRotation: { ...point.worldRotation },
    direction: point.direction,
    connectedRoomIds: []
  }));
}

function connectSpatialNeighbors(rooms) {
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const room of rooms) {
    if (room.zone.value === 4 || room.zone.value === 5) continue;
    if (room.grid.z < minZ) minZ = room.grid.z;
    if (room.grid.z > maxZ) maxZ = room.grid.z;
  }
  const stride = maxZ - minZ + 3;
  const byZone = new Map();
  for (const room of rooms) {
    if (room.zone.value === 4 || room.zone.value === 5) continue;
    let byCell = byZone.get(room.zone.value);
    if (!byCell) {
      byCell = new Map();
      byZone.set(room.zone.value, byCell);
    }
    byCell.set(room.grid.x * stride + room.grid.z, room);
  }
  const edges = [];
  for (const room of rooms) {
    if (room.zone.value === 4 || room.zone.value === 5) continue;
    const byCell = byZone.get(room.zone.value);
    const key = room.grid.x * stride + room.grid.z;
    const east = byCell.get(key + stride);
    const west = byCell.get(key - stride);
    const north = byCell.get(key + 1);
    const south = byCell.get(key - 1);
    if (east) room.adjacentRoomIds.push(east.id);
    if (west) room.adjacentRoomIds.push(west.id);
    if (north) room.adjacentRoomIds.push(north.id);
    if (south) room.adjacentRoomIds.push(south.id);
    room.adjacentRoomIds.sort();
    for (const neighborId of room.adjacentRoomIds) {
      if (room.id < neighborId) edges.push({ from: room.id, to: neighborId, kind: 'grid-adjacency' });
    }
  }
  return edges;
}

function connectRoomConnectors(rooms) {
  const connectors = [];
  for (let roomIndex = 0; roomIndex < rooms.length; roomIndex += 1) {
    const room = rooms[roomIndex];
    for (let connectorOrder = 0; connectorOrder < room.connectorInstances.length; connectorOrder += 1) {
      connectors.push({ room, connector: room.connectorInstances[connectorOrder], roomIndex, connectorOrder });
    }
  }
  connectors.sort((a, b) => a.connector.worldPosition.x - b.connector.worldPosition.x ||
    a.roomIndex - b.roomIndex || a.connectorOrder - b.connectorOrder);
  const candidates = [];
  let windowStart = 0;
  for (let index = 0; index < connectors.length; index += 1) {
    const current = connectors[index];
    const position = current.connector.worldPosition;
    while (position.x - connectors[windowStart].connector.worldPosition.x > 1) windowStart += 1;
    for (let previousIndex = windowStart; previousIndex < index; previousIndex += 1) {
      const previous = connectors[previousIndex];
      if (previous.roomIndex === current.roomIndex) continue;
      const otherPosition = previous.connector.worldPosition;
      if (Math.abs(position.y - otherPosition.y) > 1 || Math.abs(position.z - otherPosition.z) > 1) continue;
      const squared = distanceSquared(position, otherPosition);
      if (squared <= 1) {
        const from = previous.roomIndex < current.roomIndex ? previous : current;
        const to = previous.roomIndex < current.roomIndex ? current : previous;
        candidates.push({
          room: from.room,
          connector: from.connector,
          roomIndex: from.roomIndex,
          connectorOrder: from.connectorOrder,
          otherRoom: to.room,
          otherConnector: to.connector,
          otherRoomIndex: to.roomIndex,
          otherConnectorOrder: to.connectorOrder,
          distance: Math.sqrt(squared)
        });
      }
    }
  }
  candidates.sort((a, b) => a.distance - b.distance ||
    a.roomIndex - b.roomIndex || a.connectorOrder - b.connectorOrder ||
    a.otherRoomIndex - b.otherRoomIndex || a.otherConnectorOrder - b.otherConnectorOrder);
  const paired = new Set();
  const edges = [];
  for (const candidate of candidates) {
    if (paired.has(candidate.connector) || paired.has(candidate.otherConnector)) continue;
    paired.add(candidate.connector);
    paired.add(candidate.otherConnector);
    candidate.room.connectedRoomIds.push(candidate.otherRoom.id);
    candidate.otherRoom.connectedRoomIds.push(candidate.room.id);
    candidate.connector.connectedRoomIds.push(candidate.otherRoom.id);
    candidate.otherConnector.connectedRoomIds.push(candidate.room.id);
    edges.push({
      from: candidate.room.id,
      to: candidate.otherRoom.id,
      fromConnectorIndex: candidate.connector.index,
      toConnectorIndex: candidate.otherConnector.index,
      distance: candidate.distance,
      kind: 'connector'
    });
  }
  for (const room of rooms) {
    room.connectedRoomIds.sort();
    for (const connector of room.connectorInstances) connector.connectedRoomIds.sort();
  }
  return edges;
}

function buildZones(rooms, gridScale) {
  const grouped = new Map();
  for (const room of rooms) {
    if (!grouped.has(room.zone.value)) grouped.set(room.zone.value, []);
    grouped.get(room.zone.value).push(room);
  }
  return [...grouped.values()].map((zoneRooms) => {
    const xs = zoneRooms.map((room) => room.position.x);
    const zs = zoneRooms.map((room) => room.position.z);
    const bounds = {
      minX: Math.min(...xs), maxX: Math.max(...xs),
      minZ: Math.min(...zs), maxZ: Math.max(...zs)
    };
    bounds.width = bounds.maxX - bounds.minX + gridScale.x;
    bounds.height = bounds.maxZ - bounds.minZ + gridScale.z;
    for (const room of zoneRooms) {
      room.render.zonePosition = {
        x: bounds.maxX - room.position.x,
        y: room.position.z - bounds.minZ
      };
    }
    return {
      zone: zoneRooms[0].zone,
      worldY: zoneRooms[0].position.y,
      bounds,
      roomIds: zoneRooms.map((room) => room.id)
    };
  }).sort((a, b) => a.zone.value - b.zone.value);
}

function resolveHoliday(baseTemplate, templates, holiday) {
  if (baseTemplate._compiledHoliday) return baseTemplate._compiledHoliday[holiday.value];
  const variant = (baseTemplate.holidayVariants ?? []).find((item) => enumValue(item.holiday) === holiday.value);
  if (!variant) return { template: baseTemplate, resolution: 'base' };
  if (variant.resultState === 'serialized-null' || !variant.templateId) {
    return { template: baseTemplate, resolution: 'serialized-null' };
  }
  const template = templates.get(variant.templateId);
  if (!template) throw new MapGenerationError(`Missing holiday room template: ${variant.templateId}`);
  return { template, resolution: 'resolved' };
}

function normalizeHoliday(value) {
  if (typeof value === 'number') {
    const name = Object.keys(HOLIDAYS).find((key) => HOLIDAYS[key] === value);
    if (!name) throw new RangeError(`Unknown holiday value: ${value}`);
    return { name, value };
  }
  if (!Object.hasOwn(HOLIDAYS, value)) throw new RangeError(`Unknown holiday: ${value}`);
  return { name: value, value: HOLIDAYS[value] };
}

function shuffle(items, random) {
  for (let i = items.length; i > 1;) {
    i -= 1;
    const index = random.next(i + 1);
    [items[i], items[index]] = [items[index], items[i]];
  }
}

function cloneCell(cell) {
  return { ...cell, coords: { ...cell.coords }, specificRooms: [...cell.specificRooms] };
}

function enumValue(value) {
  return typeof value === 'object' && value !== null ? value.value : value;
}

function normalizeAngle(value) {
  const angle = value % 360;
  return angle < 0 ? angle + 360 : angle;
}

function rotateYaw(vector, angle) {
  const radians = angle * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: cos * vector.x + sin * vector.z,
    y: vector.y ?? 0,
    z: -sin * vector.x + cos * vector.z
  };
}

function directionFromOffset(offset) {
  if (Math.abs(offset.x) >= Math.abs(offset.z)) return offset.x >= 0 ? 'east' : 'west';
  return offset.z >= 0 ? 'north' : 'south';
}

function distanceSquared(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function multiplyQuaternion(a, b) {
  return normalizeQuaternion({
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  });
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

function quaternionToYaw(quaternion) {
  const q = normalizeQuaternion(quaternion);
  return normalizeAngle(Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z)) * 180 / Math.PI);
}

function yawQuaternion(angle) {
  const halfRadians = angle * Math.PI / 360;
  return { x: 0, y: Math.sin(halfRadians), z: 0, w: Math.cos(halfRadians) };
}
