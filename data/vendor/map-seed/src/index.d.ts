export interface EnumValue {
  name: string;
  value: number;
}

export interface Vector2 { x: number; y: number; }
export interface Vector3 { x: number; y: number; z: number; }
export interface Quaternion { x: number; y: number; z: number; w: number; }

export interface ConnectorInstance {
  index: number;
  runtimeType: string;
  localPosition: Vector3;
  localRotation: Quaternion;
  worldPosition: Vector3;
  worldRotation: Quaternion;
  direction: 'north' | 'east' | 'south' | 'west';
  connectedRoomIds: string[];
}

export interface GeneratedRoom {
  id: string;
  generation: { generatorIndex: number; spawnedIndex: number };
  atlasCell: Vector2 | null;
  prefabTemplateId: string;
  basePrefabTemplateId: string;
  prefabName: string;
  duplicateId: number;
  holidayResolution: 'base' | 'resolved' | 'serialized-null';
  zone: EnumValue;
  name: EnumValue;
  shape: EnumValue;
  position: Vector3;
  grid: Vector3;
  rotationY: number;
  rotation: Quaternion;
  adjacentRoomIds: string[];
  connectedRoomIds: string[];
  connectorInstances: ConnectorInstance[];
  render: {
    mapPosition: Vector2;
    zonePosition: Vector2;
    angleDeg: number;
    shape: string;
    label: string;
    iconKey: string;
  };
}

export interface GeneratedMap {
  schemaVersion: 1;
  type: 'scpsl-map';
  source: {
    gameVersion: string;
    buildType: string;
    rawSchemaVersion: number | null;
    activeHolidayInTemplate: EnumValue;
  };
  seed: number;
  holiday: EnumValue;
  gridScale: Vector3;
  rooms: GeneratedRoom[];
  zones: Array<{ zone: EnumValue; worldY: number; bounds: Record<string, number>; roomIds: string[] }>;
  spatialAdjacency: Array<{ from: string; to: string; kind: 'grid-adjacency' }>;
  connectorAdjacency: Array<{
    from: string;
    to: string;
    fromConnectorIndex: number;
    toConnectorIndex: number;
    distance: number;
    kind: 'connector';
  }>;
  atlasSelections: Array<Record<string, unknown>>;
  generationTrace: Array<Record<string, unknown>>;
  diagnostics: Record<string, unknown>;
}

export class MapGenerationError extends Error {
  context: Record<string, unknown>;
}

export class DotNetRandom {
  constructor(seed: number | string);
  sample(): number;
  next(maxValue: number): number;
  nextDouble(): number;
}

export function generateMap(seed: number | string, options?: { holiday?: 'None' | 'Christmas' | 'Halloween' | 'AprilFools' | number }): GeneratedMap;
export function getTemplateInfo(): {
  gameVersion: string;
  buildType: string;
  activeHoliday: string;
  rawSchemaVersion: number;
  generatorCount: number;
  roomTemplateCount: number;
  glyphCount: number;
  atlasCount: number;
};
