# scpsl-map-seed

Generate a deterministic SCP: Secret Laboratory map from a seed, entirely offline.

## Template source

The bundled raw templates were exported with the [`SCPSL_Template_export`](https://github.com/kldhsh123/SCPSL_Template_export) exporter. That repository contains the in-game plugin/exporter used to collect atlas data, room templates, and connector metadata; this package contains the resulting offline template data and deterministic generator.

## Install a tagged GitHub version

```bash
npm install kldhsh123/scpsl-map-seed#v1.0.1
```

## API

```js
import { generateMap } from '@scpsl-tools/map-seed';

const map = generateMap(1062329959);

console.log(map.rooms);              // rooms with world/render coordinates
console.log(map.zones);              // bounds and room IDs grouped by zone
console.log(map.connectorAdjacency); // actual connector-to-connector links
```

The generator returns both the atlas cell (`room.atlasCell`) and final world-space position (`room.position`). `room.render.angleDeg` matches the sign used by the game's SCP-079 UI. `spatialAdjacency` contains deterministic four-neighbor grid adjacency, not a claim about the final connector/door prefab.

## Input

`generateMap(seed, options?)` accepts:

- `seed`: a positive signed 32-bit integer (`1` to `2147483647`), as a number or a numeric string.
- `options.holiday` (optional): `None`, `Christmas`, `Halloween`, `AprilFools`, or the corresponding numeric enum value. If omitted, the bundled template's active holiday is used.

The holiday is independent of the seed: the same seed can produce the normal, Christmas, or Halloween room prefab variants. The current `14.2.7` export was based on `None`, but it includes the Christmas and Halloween variant references. A requested holiday is applied per room where a variant exists; rooms without a variant stay on their base prefab.

```js
const normal = generateMap(seed, { holiday: 'None' });
const christmas = generateMap(seed, { holiday: 'Christmas' });
const halloween = generateMap(seed, { holiday: 'Halloween' });
```

The package already contains the templates for SCP:SL `14.2.7 Release`.

## Output

The result is a JSON-serializable `GeneratedMap`:

- `source`, `seed`, `holiday`, and `gridScale` identify the template and coordinate units.
- `rooms` is a flat list. Each room has authoritative `position`/`rotationY`, grid coordinates, room name/shape, `adjacentRoomIds`, and `connectorInstances`.
- `room.connectorInstances` contains each opening's local/world position, world rotation, cardinal `direction`, and the room IDs reached through that connector.
- `connectorAdjacency` contains the 1:1 connector links used to establish real room connections. Its `distance` is the world-space distance between the two connector points and must be within the game's threshold of `1`.
- `zones` groups room IDs and provides world Y plus zone bounds. `room.render.zonePosition` is the 180-degree-flipped 2D position used by the current preview projection.
- `spatialAdjacency` is optional analysis data for four-neighbor grid cells. It must not be rendered as a door/link because grid neighbors can have no matching connector.
- `diagnostics` reports room, connector, linked-edge, and unpaired-connector counts.

Typical rendering flow:

```js
const map = generateMap(seed);
for (const room of map.rooms) {
  drawRoom(room.render.zonePosition, room.connectorInstances);
}
for (const edge of map.connectorAdjacency) {
  drawConnection(edge.from, edge.to);
}
```

Map templates are bundled inside the tagged package. Consumers only provide a seed. The package uses the bundled template's active holiday by default.

The published package contains precompiled atlas cells rather than the exporter's Base64 RGBA atlas images. When replacing the raw export, regenerate that runtime data with:

```bash
npm run compile:templates
```


## License

Copyright (c) kldhsh123. All rights reserved.

Licensed under the [Apache-2.0 License](LICENSE).
