/**
 * AppController：唯一状态源（§5.2）。
 * 把「种子 → 生成 → POI → 图 → 路线 → RenderLayout」串成一条链，且**不依赖 Electron**，
 * 因此 CLI、对拍脚本、离屏出图工具都能直接复用同一条链路。
 *
 * 事件：
 *   'layout'  RenderLayout      需要重绘
 *   'seed'    {seed, source}    种子变化
 *   'status'  {…}               状态变化（视图/路线/版本闸门/诊断）
 *   'error'   {code, message, detail}
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { MapService } from './map-service.js';
import { classifyRooms, candidatesFor, loadPoiTableFromFile, kindMeta, listRouteTargets } from './poi-catalog.js';
import { buildGraph, buildPortalEdges, planRoute, nearestTarget, dijkstra, countPortals } from './route-planner.js';
import { buildLayout } from './layout-builder.js';
import { versionGate } from './version-guard.js';
import { ROUTE_PRESETS, VIEWS, VIEW_LABEL, STYLE, ZONE_META, ZONE_ORDER } from '../shared/constants.js';
import { basename } from 'node:path';

export class AppController extends EventEmitter {
  constructor({ generatorEntry, poiTablePath, iconManifestPath = null, logger = null, settings = null } = {}) {
    super();
    this.logger = logger;
    this.settings = settings;
    this.mapService = new MapService({ generatorEntry });
    this.poiTablePath = poiTablePath;
    this.poiTable = null;
    /** 官方房间图标清单（SCP:SL wiki，CC BY-SA 3.0）—— 交给渲染进程画形状 */
    this.iconManifestPath = iconManifestPath;
    this.iconManifest = null;
    this.gameVersion = null;
    this.gameVersionSource = null;

    this.seed = null;
    this.seedSource = null;
    /**
     * 当前节日（'Christmas' | 'Halloween' | 'AprilFools' | null）。
     * v0.3.0：从日志「Holiday type:」读出，随种子一起传给生成器 ——
     * 节日活动会改布局（vendor README），不传就会在活动期间算错图。
     */
    this.holiday = null;
    this.map = null;
    this.pois = [];
    this.poiStats = null;
    this.missingPois = [];
    this.graph = null;
    this.route = null;
    this.routePresetId = null;
    this.viewZone = settings?.data?.lastZone && VIEWS.includes(settings.data.lastZone) ? settings.data.lastZone : 'LightContainment';
    this.banner = null;
    this.lastLayout = null;
    this.lastGenerateMs = null;
    this.lastLayoutMs = null;
    /**
     * v0.3.2 护栏：Node EventEmitter 对**无监听器**的 'error' 事件直接 throw。
     * init() 在生成器不可用 / POI 表读取失败时会 emit('error')，而调用方
     * （bootstrap / verifier.runVerify）不一定来得及挂监听 —— 挂一个空监听兜底，
     * 让 emit('error') 永不炸掉调用链；关心错误的调用方照常再挂自己的监听即可。
     */
    this.on('error', () => {});
  }

  async init() {
    const info = await this.mapService.init();
    if (!this.mapService.available) {
      this.emit('error', { code: 'GENERATOR_UNAVAILABLE', message: '生成器不可用', detail: this.mapService.loadError });
      this.recomputeBanner();
      return { info: null };
    }
    try {
      this.poiTable = loadPoiTableFromFile(this.poiTablePath);
    } catch (error) {
      this.emit('error', { code: 'POI_TABLE_MISSING', message: 'POI 表读取失败', detail: error.message });
      this.poiTable = { rooms: new Map(), prefabs: new Map(), kinds: {}, manual: [], version: null };
    }
    // 房间图标清单：读不到就退回"块+臂"渲染，不影响可用性
    if (this.iconManifestPath) {
      try {
        this.iconManifest = JSON.parse(readFileSync(this.iconManifestPath, 'utf8'));
        this.logger?.info('房间图标清单就绪', {
          count: this.iconManifest.iconCount,
          license: this.iconManifest.license,
        });
      } catch (error) {
        this.iconManifest = null;
        this.logger?.warn?.('房间图标清单读取失败，退回块+臂渲染', { detail: error.message });
      }
    }
    this.recomputeBanner();
    this.logger?.info('生成器就绪', { ...info, poiTable: this.poiTable.version });
    return { info };
  }

  setGameVersion(version, source = null) {
    this.gameVersion = version;
    this.gameVersionSource = source;
    this.recomputeBanner();
  }

  recomputeBanner() {
    const templateVersion = this.mapService.info?.gameVersion ?? null;
    const poiVersion = this.poiTable?.version ?? null;
    const gate = versionGate({ gameVersion: this.gameVersion, templateVersion, poiVersion });
    this.banner = { level: gate.level, text: gate.text, code: gate.code };
    this.versionState = {
      game: this.gameVersion,
      gameSource: this.gameVersionSource,
      template: templateVersion,
      poi: poiVersion,
      match: gate.code === 'OK',
      stale: gate.stale,
    };
    this.emitStatus();
    return this.banner;
  }

  /**
   * 新种子：相同则完全不重绘（§8.2）。
   * v0.3.0：新增 holiday 参数（日志「Holiday type:」读出）。
   * 节日会改布局：同一颗种子 + 不同节日 = 不同的图，所以种子或节日任一变化都要重新生成。
   */
  setSeed(seed, source = 'log', holiday = null) {
    if (seed === null || seed === undefined) {
      this.emitStatus();
      return { changed: false, ok: false, error: '没有种子' };
    }
    const normalizedHoliday = holiday === 'None' ? null : holiday;
    const unchanged = seed === this.seed
      && this.map
      && (normalizedHoliday ?? null) === (this.holiday ?? null);
    if (unchanged) {
      // ⚠️ 必须带 ok:true —— 调用方（index.js handleSeed）按 result.ok 判成败，
      // 少了它"种子没变化"会被当成生成失败、每次强制重读都弹"布局生成失败"（v0.3.2 修复）。
      this.emitStatus();
      return { changed: false, ok: true };
    }
    const regenerate = this.map !== null;
    this.seed = seed;
    this.seedSource = source;
    this.holiday = normalizedHoliday ?? null;
    this.emit('seed', { seed, source, holiday: this.holiday, at: Date.now() });
    const generated = this.mapService.generate(seed, this.holiday);
    if (!generated.map) {
      this.map = null;
      this.lastLayout = null;
      this.emit('error', { code: 'GEN_FAILED', message: '布局生成失败', detail: generated.error });
      this.emitStatus();
      return { changed: true, ok: false, error: generated.error };
    }
    this.map = generated.map;
    this.lastGenerateMs = generated.ms;
    this.pois = [];
    this.graph = null;
    this.route = null;
    // 节日变化而种子相同时也要重算（走 rebuild 而不是 setSeed 的全流程）
    this.rebuild({ regeneratePois: true });
    return { changed: true, ok: true, cached: generated.cached, ms: generated.ms, regenerated: regenerate };
  }

  /** v0.3.0：节日变化（日志里「Holiday type:」更新）。种子相同也要重新生成。 */
  setHoliday(holiday) {
    const normalized = holiday === 'None' ? null : holiday ?? null;
    if (normalized === (this.holiday ?? null)) return false;
    if (this.seed === null || this.map === null) {
      this.holiday = normalized;
      return false;
    }
    this.holiday = normalized;
    const generated = this.mapService.generate(this.seed, this.holiday);
    if (!generated.map) {
      this.emit('error', { code: 'GEN_FAILED', message: '节日布局生成失败', detail: generated.error });
      this.emitStatus();
      return false;
    }
    this.map = generated.map;
    this.lastGenerateMs = generated.ms;
    this.pois = [];
    this.graph = null;
    this.route = null;
    this.rebuild({ regeneratePois: true });
    this.logger?.info?.('节日变化，已重新生成布局', { holiday: this.holiday, seed: this.seed });
    return true;
  }

  /** 重新分类 + 建图 + 选路线 + 出图 */
  rebuild({ regeneratePois = false } = {}) {
    if (!this.map) return null;
    if (regeneratePois || this.pois.length === 0) {
      const classified = classifyRooms(this.map, this.poiTable);
      this.pois = classified.pois;
      this.poiStats = classified.stats;
      this.missingPois = classified.missing;
      if (this.missingPois.length > 0) {
        this.logger?.warn('未映射的房间名', this.missingPois);
      }
    }
    this.graph = buildGraph(this.map);
    this.selectRoute(this.routePresetId ?? this.defaultPresetId());
    return this.lastLayout;
  }

  defaultPresetId() {
    const enabled = this.enabledPresets();
    return enabled[0]?.id ?? ROUTE_PRESETS[0].id;
  }

  /** 用户自定义路线（存于配置，端点是**与种子无关**的选择器） */
  customRoutes() {
    const list = this.settings?.data?.customRoutes;
    return Array.isArray(list) ? list : [];
  }

  /** 内置预设 + 自定义路线，统一成同一形状，后续逻辑不用分叉 */
  allRoutes() {
    return [...ROUTE_PRESETS, ...this.customRoutes()];
  }

  routeById(id) {
    return this.allRoutes().find((r) => r.id === id) ?? null;
  }

  /**
   * 参与「循环路线」的列表。
   * 自定义路线只要 enabled（默认开）就自动进入循环 —— 用户加了路线就应该能用热键切到。
   */
  enabledPresets() {
    const enabled = this.settings?.data?.presets ?? [];
    const builtin = ROUTE_PRESETS.filter((preset) => enabled.includes(preset.id));
    const custom = this.customRoutes().filter((route) => route.enabled !== false);
    const list = [...builtin, ...custom];
    return list.length > 0 ? list : [...ROUTE_PRESETS, ...custom];
  }

  /**
   * 设置页的「可作路线端点的点位」清单：来自 POI 表，**不依赖当前种子**
   * （没读到种子也能先把路线配好）。附带标记哪些在当前地图里真的出现了。
   */
  routeTargets() {
    if (!this.poiTable?.rooms) return [];
    const present = new Set();
    for (const poi of this.pois) {
      present.add(`room:${poi.roomName}`);
      if (poi.prefab) present.add(`prefab:${poi.prefab}`);
    }
    const zoneByRoomName = new Map(this.map?.rooms?.map((r) => [r.name?.name, r.zone?.name]) ?? []);
    return listRouteTargets(this.poiTable).map((target) => ({
      ...target,
      zone: zoneByRoomName.get(target.selector.roomNames?.[0]) ?? null,
      present: target.id.startsWith('kind:') ? true : present.has(target.id),
    }));
  }

  /**
   * 选路线：支持 presetId（内置预设或自定义路线的 id）或 {fromPoiId,toPoiId} 临时自定义。
   */
  selectRoute(target) {
    if (!this.map) return null;
    let resolved = null;
    if (typeof target === 'string' && this.routeById(target)) {
      resolved = this.planPreset(target);
      this.routePresetId = target;
    } else if (target && typeof target === 'object' && target.fromPoiId) {
      resolved = this.planCustom(target.fromPoiId, target.toPoiId);
      this.routePresetId = 'custom';
    } else if (target && typeof target === 'object' && (target.from || target.to)) {
      resolved = this.planSelector(target);
      this.routePresetId = resolved?.presetId ?? 'custom';
    } else {
      resolved = this.planPreset(this.defaultPresetId());
      this.routePresetId = resolved?.presetId ?? null;
    }
    this.route = resolved;
    this.buildLayoutNow();
    return resolved;
  }

  cycleRoute(direction = 1) {
    const list = this.enabledPresets();
    if (list.length === 0) return null;
    const currentIndex = list.findIndex((p) => p.id === this.routePresetId);
    const next = list[(currentIndex + direction + list.length) % list.length];
    return this.selectRoute(next.id);
  }

  setView(zone) {
    if (!VIEWS.includes(zone)) return this.lastLayout;
    this.viewZone = zone;
    this.settings?.patch('lastZone', zone);
    this.buildLayoutNow();
    this.emitStatus();
    return this.lastLayout;
  }

  cycleView(direction = 1) {
    const index = VIEWS.indexOf(this.viewZone);
    const next = VIEWS[(index + direction + VIEWS.length) % VIEWS.length];
    return this.setView(next);
  }

  setScaleIndex(index) {
    const clamped = Math.max(0, Math.min(STYLE.scaleSteps.length - 1, index));
    this.settings?.patch('overlay.scaleIndex', clamped);
    this.emitStatus();
    return clamped;
  }

  cycleScale(direction = 1) {
    const current = this.settings?.data?.overlay?.scaleIndex ?? STYLE.defaultScaleIndex;
    return this.setScaleIndex((current + direction + STYLE.scaleSteps.length) % STYLE.scaleSteps.length);
  }

  get scale() {
    const index = this.settings?.data?.overlay?.scaleIndex ?? STYLE.defaultScaleIndex;
    return STYLE.scaleSteps[index] ?? 1;
  }

  /** 预设路线解析：候选集合 → 最短路（多起点时全局取最小，§9.3） */
  planPreset(presetId) {
    const preset = this.routeById(presetId);
    if (!preset) return { ok: false, reason: `找不到路线 ${presetId}`, roomPath: [], segments: [], warnings: [] };
    const fromList = candidatesFor(this.pois, preset.from);
    const toList = candidatesFor(this.pois, preset.to);
    if (fromList.length === 0 || toList.length === 0) {
      return {
        ok: false,
        presetId: preset.id,
        presetLabel: preset.label,
        reason: `本局缺点位：起点 ${fromList.length} 个 / 终点 ${toList.length} 个`,
        roomPath: [], segments: [], warnings: [],
      };
    }
    const best = this.bestPair(fromList, toList);
    if (!best) {
      return { ok: false, presetId: preset.id, presetLabel: preset.label, reason: '该区域不连通', roomPath: [], segments: [], warnings: [] };
    }
    const route = planRoute(this.map, this.graph, best.fromRoom, best.toRoom);
    if (!route.ok) return { ...route, presetId: preset.id, presetLabel: preset.label };
    const fromPoi = fromList.find((p) => p.roomId === best.fromRoom) ?? null;
    const toPoi = toList.find((p) => p.roomId === best.toRoom) ?? null;
    return {
      ...route,
      presetId: preset.id,
      presetLabel: preset.label,
      presetHint: preset.hint,
      fromPoi,
      toPoi,
      fromLabel: fromPoi?.label ?? route.fromRoomId,
      toLabel: toPoi?.label ?? route.toRoomId,
      custom: preset.custom === true,
    };
  }

  /** 候选集合 × 候选集合 → 全局最短路的那一对（一次 Dijkstra 覆盖多个起点） */
  bestPair(fromList, toList) {
    const toRooms = new Set(toList.map((p) => p.roomId));
    let best = null;
    for (const fromPoi of fromList.slice(0, 8)) {
      const { dist } = dijkstra(this.graph, fromPoi.roomId);
      for (const toRoom of toRooms) {
        const d = dist.get(toRoom);
        if (d !== undefined && d < Infinity && (!best || d < best.distance)) {
          best = { fromRoom: fromPoi.roomId, toRoom, distance: d };
        }
      }
    }
    return best;
  }

  /** 直接按选择器规划（设置页试算 / 临时自定义用，不落盘） */
  planSelector({ from, to, label = null, id = 'custom' }) {
    const fromList = candidatesFor(this.pois, from ?? {});
    const toList = candidatesFor(this.pois, to ?? {});
    if (fromList.length === 0 || toList.length === 0) {
      return {
        ok: false,
        presetId: id,
        presetLabel: label ?? '自定义路线',
        reason: `本局缺点位：起点 ${fromList.length} 个 / 终点 ${toList.length} 个`,
        roomPath: [], segments: [], warnings: [],
      };
    }
    const best = this.bestPair(fromList, toList);
    if (!best) {
      return { ok: false, presetId: id, presetLabel: label ?? '自定义路线', reason: '该区域不连通', roomPath: [], segments: [], warnings: [] };
    }
    const route = planRoute(this.map, this.graph, best.fromRoom, best.toRoom);
    const fromPoi = fromList.find((p) => p.roomId === best.fromRoom) ?? null;
    const toPoi = toList.find((p) => p.roomId === best.toRoom) ?? null;
    return {
      ...route,
      presetId: id,
      presetLabel: label ?? `${fromPoi?.label ?? '?'} → ${toPoi?.label ?? '?'}`,
      fromPoi,
      toPoi,
      fromLabel: fromPoi?.label ?? route.fromRoomId,
      toLabel: toPoi?.label ?? route.toRoomId,
      custom: true,
    };
  }

  planCustom(fromPoiId, toPoiId) {
    const fromPoi = this.pois.find((p) => p.id === fromPoiId);
    const toPoi = this.pois.find((p) => p.id === toPoiId);
    if (!fromPoi || !toPoi) return { ok: false, reason: '自定义点位不存在', roomPath: [], segments: [], warnings: [] };
    const route = planRoute(this.map, this.graph, fromPoi.roomId, toPoi.roomId);
    return { ...route, presetId: 'custom', presetLabel: `${fromPoi.label} → ${toPoi.label}`, fromPoi, toPoi, fromLabel: fromPoi.label, toLabel: toPoi.label };
  }

  buildLayoutNow() {
    if (!this.map) return null;
    const started = Date.now();
    // 「全设施视图显示地表」开关：地表只有 1 个房间，关掉后排布更紧凑
    const showSurfaceBand = this.settings?.data?.overlay?.showSurfaceBand !== false;
    const includeZones = showSurfaceBand ? ZONE_ORDER : ZONE_ORDER.filter((z) => z !== 'Surface');
    this.lastLayout = buildLayout(this.map, {
      pois: this.pois,
      route: this.route,
      viewZone: this.viewZone,
      banner: this.banner,
      iconManifest: this.iconManifest,
      includeZones,
    });
    this.lastLayoutMs = Date.now() - started;
    this.emit('layout', this.lastLayout);
    this.emitStatus();
    return this.lastLayout;
  }

  /** 给 UI / 托盘用的状态快照 */
  status() {
    const zoneMeta = ZONE_META[this.viewZone];
    return {
      seed: this.seed,
      seedSource: this.seedSource,
      /** v0.3.0：当前节日（null=无）；活动期间布局不同，UI 要能看出来 */
      holiday: this.holiday,
      viewZone: this.viewZone,
      viewLabel: VIEW_LABEL[this.viewZone] ?? this.viewZone,
      viewShort: zoneMeta?.short ?? 'ALL',
      viewIndex: VIEWS.indexOf(this.viewZone),
      scaleIndex: this.settings?.data?.overlay?.scaleIndex ?? STYLE.defaultScaleIndex,
      scale: this.scale,
      route: this.route
        ? {
            presetId: this.route.presetId ?? null,
            presetLabel: this.route.presetLabel ?? null,
            ok: this.route.ok !== false,
            reason: this.route.reason ?? null,
            fromLabel: this.route.fromLabel ?? null,
            toLabel: this.route.toLabel ?? null,
            rooms: this.route.roomPath?.length ?? 0,
            distance: this.route.distance ?? null,
            portalCount: this.route.portalCount ?? 0,
            warnings: this.route.warnings ?? [],
          }
        : null,
      banner: this.banner,
      version: this.versionState ?? null,
      customRoutes: this.customRoutes().map((r) => ({ id: r.id, label: r.label, enabled: r.enabled !== false })),
      routeCycle: this.enabledPresets().map((r) => ({ id: r.id, label: r.label })),
      colorByCategory: this.settings?.data?.overlay?.colorByCategory !== false,
      diagnostics: this.map?.diagnostics ?? null,
      poiStats: this.poiStats,
      missingPois: this.missingPois,
      roomCount: this.map?.rooms?.length ?? 0,
      edgeCount: this.map?.connectorAdjacency?.length ?? 0,
      portalCount: this.graph?.portals?.length ?? 0,
      cache: this.mapService.stats(),
      timing: { generateMs: this.lastGenerateMs, layoutMs: this.lastLayoutMs },
      poiTableVersion: this.poiTable?.version ?? null,
      poiTableFile: this.poiTablePath ? basename(this.poiTablePath) : null,
      kindMeta: this.poiTable?.kinds ?? {},
    };
  }

  emitStatus() {
    this.emit('status', this.status());
  }
}

export { ROUTE_PRESETS, candidatesFor, nearestTarget, countPortals, buildPortalEdges, kindMeta };
