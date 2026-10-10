import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Run each implementation in its own process so V8 optimizes it independently.
const modulePath = process.argv[2] ?? 'src/index.js';
const start = performance.now();
const { generateMap } = await import(pathToFileURL(resolve(modulePath)));
const imported = performance.now();
const first = generateMap(1062329959);
const initialized = performance.now();
const seeds = Array.from({ length: 1024 }, (_, i) => ((Math.imul(i + 1, 104729) >>> 0) % 2147483647) + 1);
let checksum = first.rooms.length;
for (let i = 0; i < 3000; i += 1) {
  checksum += generateMap(seeds[i % seeds.length], { holiday: i % 4 }).rooms.length;
}
const rounds = [];
for (let round = 0; round < 7; round += 1) {
  const before = performance.now();
  for (let i = 0; i < 3000; i += 1) {
    const map = generateMap(seeds[i % seeds.length], { holiday: i % 4 });
    checksum += map.rooms.length + map.connectorAdjacency.length;
  }
  rounds.push((performance.now() - before) / 3000);
}
rounds.sort((a, b) => a - b);
console.log(JSON.stringify({
  node: process.version,
  module: modulePath,
  importMs: imported - start,
  firstMapMs: initialized - imported,
  medianMsPerMap: rounds[3],
  mapsPerSecond: Math.round(1000 / rounds[3]),
  roundsMsPerMap: rounds,
  checksum
}, null, 2));
