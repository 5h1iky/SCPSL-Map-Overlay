/* 覆盖层 Canvas 渲染（经典脚本，无构建步骤）。
 * 输入只有主进程算好的 RenderLayout —— 这里不做任何业务判断（§5.2）。
 */
(function () {
  'use strict';

  const ZONE_FILL = {
    lcz: '#2A2F3A',
    hcz: '#3A2A24',
    ez: '#24303A',
    surface: '#24352A',
    other: '#2A2438',
  };

  /**
   * 房间图标的着色（对齐游戏内 SCP-079 地图：亮蓝实心）。
   * 图标源是 1024px 白蒙版，缩到几十像素时会发暗发糊，两个补救：
   *   1) 着色时用 imageSmoothingQuality='high'，并在放大画布上着色再缩（抗锯齿）
   *   2) 覆盖层用较高的不透明度（0.88），既像游戏又能看见底下画面
   */
  const ZONE_ROOM_FILL = {
    lcz: 'rgba(74,138,232,0.88)',
    hcz: 'rgba(96,120,220,0.88)',
    ez: 'rgba(64,158,200,0.88)',
    surface: 'rgba(78,180,128,0.88)',
    other: 'rgba(126,106,196,0.88)',
  };

  /** 图标边缘高光（游戏内房间有亮色描边） */
  const ZONE_ROOM_EDGE = {
    lcz: 'rgba(150,196,255,0.85)',
    hcz: 'rgba(158,178,255,0.85)',
    ez: 'rgba(140,214,255,0.85)',
    surface: 'rgba(140,230,180,0.85)',
    other: 'rgba(180,164,255,0.85)',
  };

  const C = {
    panelBg: 'rgba(8,10,14,0.62)',
    panelBgPreview: 'rgba(8,10,14,0.94)',
    panelBorder: 'rgba(255,255,255,0.16)',
    roomBorder: 'rgba(255,255,255,0.22)',
    roomBorderRoute: 'rgba(255,214,0,0.65)',
    door: 'rgba(255,255,255,0.5)',
    route: '#FFD400',
    start: '#38D66B',
    end: '#FF4D4D',
    portal: '#7FB6FF',
    chipBg: 'rgba(0,0,0,0.68)',
    chipText: '#FFFFFF',
    dim: '#9AA4B2',
    band: 'rgba(255,255,255,0.10)',
  };

  const FONT = '11px Consolas, "Sarasa Mono SC", ui-monospace, monospace';
  const FONT_SMALL = '10px Consolas, "Sarasa Mono SC", ui-monospace, monospace';
  const FONT_BAND = 'bold 12px Consolas, "Sarasa Mono SC", ui-monospace, monospace';
  const FONT_ROOM = 'bold 10px Consolas, "Sarasa Mono SC", ui-monospace, monospace';
  const PAD = 16;

  /**
   * 房间图标贴图（SCP:SL 房间图标，Northwood Studios，CC BY-SA 3.0）
   *
   * ⚠️ 使用**真实贴图**（assets/room-icons/<mapIcon>.png，256×256 蒙版），
   *    不再用代码手画几何图形。mapIcon 取自权威字段，例如：
   *      LczComputerRoom → LCZ_PC15      HczWaysideIncinerator → HCZ_Wayside
   *      Hcz079 / Hcz106 → HCZ_EndLarge  Lcz173 → LCZ_LargeEnd
   *
   * 着色：按房间分类（scp/core/security/checkpoint/…）重新着色（符合 CC BY-SA 的修改声明）。
   */
  const iconCache = new Map();
  const iconTintCache = new Map();

  function loadIcons(iconNames) {
    if (!Array.isArray(iconNames)) return;
    for (const name of iconNames) {
      if (iconCache.has(name)) continue;
      const img = new Image();
      img.src = `../../../assets/room-icons/${encodeURIComponent(name)}.png`;
      iconCache.set(name, { img, ready: false, failed: false });
      img.onload = () => {
        const rec = iconCache.get(name);
        if (rec) rec.ready = true;
        if (typeof window.__onIconLoaded === 'function') window.__onIconLoaded();
      };
      img.onerror = () => {
        const rec = iconCache.get(name);
        if (rec) rec.failed = true;
      };
    }
  }

  /** 贴图着色（超采样 2× 抗锯齿）。
   *  层内必须**不透明**：UNION 依赖"重叠处颜色相同"，半透明叠加会变深、露出接缝。 */
  function tintedTexture(name, color) {
    const rec = iconCache.get(name);
    if (!rec || !rec.ready) return null;
    const key = `${name}|${color}`;
    if (iconTintCache.has(key)) return iconTintCache.get(key);
    const img = rec.img;
    const SS = 2;
    const w = (img.naturalWidth || 256) * SS;
    const h = (img.naturalHeight || 256) * SS;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const c2 = cv.getContext('2d');
    c2.imageSmoothingEnabled = true;
    c2.imageSmoothingQuality = 'high';
    c2.drawImage(img, 0, 0, w, h);
    c2.globalCompositeOperation = 'source-in';
    c2.fillStyle = color;
    c2.fillRect(0, 0, w, h);
    iconTintCache.set(key, cv);
    return cv;
  }

  /** 贴图合并层（整层一次性合成用）。跨帧复用，避免每帧新建整屏 canvas。 */
  let textureLayerCache = null;
  function textureLayer(cssWidth, cssHeight, dpr) {
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));
    if (!textureLayerCache || textureLayerCache.canvas.width !== w || textureLayerCache.canvas.height !== h) {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      textureLayerCache = { canvas, ctx: canvas.getContext('2d') };
    }
    return textureLayerCache;
  }

  function roundRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function chip(ctx, text, x, y, { align = 'center', baseline = 'middle', font = FONT, color = C.chipText, bg = C.chipBg, pad = 5 } = {}) {
    ctx.font = font;
    const w = ctx.measureText(text).width + pad * 2;
    const h = 16;
    let left = x - w / 2;
    if (align === 'left') left = x;
    if (align === 'right') left = x - w;
    let top = y - h / 2;
    if (baseline === 'top') top = y;
    if (baseline === 'bottom') top = y - h;
    if (bg) {
      ctx.fillStyle = bg;
      roundRect(ctx, left, top, w, h, 4);
      ctx.fill();
    }
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, left + pad, top + h / 2 + 0.5);
    return { x: left, y: top, w, h };
  }

  /** 一维墙段：从 a 到 b，挖掉 gaps（世界→屏幕已换算） */
  function wallRuns(a, b, gaps) {
    const runs = [];
    let cursor = a;
    const sorted = gaps.slice().sort((p, q) => p - q);
    for (const gap of sorted) {
      const g0 = gap[0];
      const g1 = gap[1];
      if (g1 <= cursor) continue;
      if (g0 > cursor) runs.push([cursor, Math.min(g0, b)]);
      cursor = Math.max(cursor, g1);
    }
    if (cursor < b) runs.push([cursor, b]);
    return runs.filter(([s, e]) => e - s > 0.4);
  }

  function computeTransform({ layout, cssWidth, cssHeight, scale = 1, autoFit = true, anchor = { x: 0.5, y: 0.62 }, fitHeightRatio = 0.35, frozen = null }) {
    const bounds = layout.bounds;
    const bw = Math.max(bounds.width, 1);
    const bh = Math.max(bounds.height, 1);
    if (!autoFit && frozen) {
      /**
       * v0.3.2 修复：冻结的只有**尺寸**（k/面板长宽），位置仍按 anchor 重算。
       * 旧实现把整个 frozen 原样返回 —— 编辑模式拖动 / 右键复位在关掉「自动适配」后
       * 完全无效（anchor 改了、落盘了，画面却一像素不动，等下次重算又突然跳位）。
       */
      const { k, panelW, panelH } = frozen;
      const cx = cssWidth * anchor.x;
      const cy = cssHeight * anchor.y;
      const panelX = Math.min(Math.max(cx - panelW / 2, 4), Math.max(4, cssWidth - panelW - 4));
      const panelY = Math.min(Math.max(cy - panelH / 2, 4), Math.max(4, cssHeight - panelH - 4));
      return {
        k, panelX, panelY, panelW, panelH,
        originX: panelX + PAD - bounds.minX * k,
        originY: panelY + PAD - bounds.minY * k,
        cssWidth, cssHeight,
      };
    }
    const targetH = Math.max(120, cssHeight * fitHeightRatio * scale);
    // 高度优先，同时限制宽度不超过屏幕的 46%（否则细长布局会横跨整个屏幕挡住视野）
    const maxPanelW = Math.max(220, cssWidth * 0.46);
    const kByHeight = (targetH - PAD * 2) / bh;
    const kByWidth = (maxPanelW - PAD * 2) / bw;
    const k = Math.min(kByHeight, kByWidth);
    const panelW = bw * k + PAD * 2;
    const panelH = bh * k + PAD * 2;
    const cx = cssWidth * anchor.x;
    const cy = cssHeight * anchor.y;
    const panelX = Math.min(Math.max(cx - panelW / 2, 4), Math.max(4, cssWidth - panelW - 4));
    const panelY = Math.min(Math.max(cy - panelH / 2, 4), Math.max(4, cssHeight - panelH - 4));
    return { k, panelX, panelY, panelW, panelH, originX: panelX + PAD - bounds.minX * k, originY: panelY + PAD - bounds.minY * k, cssWidth, cssHeight };
  }

  function toScreen(point, t) {
    return { x: t.originX + point.x * t.k, y: t.originY + point.y * t.k };
  }

  /**
   * 主绘制。
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} opts { layout, transform, opacity, showLabels, preview, hoverRoomId }
   */
  /** 最近一次绘制的屏幕空间房间几何 + 变换（v0.3.0：悬停命中检测、导出合成用） */
  let lastRoomGeom = [];
  let lastTransform = null;

  function draw(ctx, opts) {
    const { layout, transform: t, opacity = 0.75, showLabels = true, preview = false } = opts;
    lastTransform = t;
    ctx.save();
    ctx.setTransform(opts.dpr || 1, 0, 0, opts.dpr || 1, 0, 0);
    ctx.clearRect(0, 0, t.cssWidth, t.cssHeight);
    ctx.globalAlpha = Math.max(0.15, Math.min(1, opacity));

    // ── 面板 ────────────────────────────────────────────────
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 4;
    ctx.fillStyle = preview ? C.panelBgPreview : C.panelBg;
    roundRect(ctx, t.panelX, t.panelY, t.panelW, t.panelH, 10);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = C.panelBorder;
    ctx.lineWidth = 1;
    roundRect(ctx, t.panelX + 0.5, t.panelY + 0.5, t.panelW - 1, t.panelH - 1, 10);
    ctx.stroke();

    ctx.save();
    roundRect(ctx, t.panelX, t.panelY, t.panelW, t.panelH, 10);
    ctx.clip();

    // ── 分带标题与分隔线（全设施视图） ───────────────────────
    if (layout.bands.length > 1) {
      for (const band of layout.bands) {
        const x0 = t.originX + band.x * t.k;
        const y0 = t.originY + band.y * t.k;
        const w = band.width * t.k;
        // 每条分带画一个淡框 + 左上角标题，网格排布时一眼能分清哪块是哪个区
        ctx.strokeStyle = C.band;
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(x0) - 4.5, Math.round(y0) - 4.5, Math.round(w) + 9, Math.round(band.height * t.k) + 9);
        ctx.font = FONT_BAND;
        ctx.fillStyle = 'rgba(255,255,255,0.42)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`${band.label} ${band.short}`, x0, y0 - 6);
      }
    }

    const labelBoxes = [];
    const hasRoute = Boolean(layout.route && layout.route.ok);

    // ── 房间（方案 B+：优先画官方房间图标）────────────────────
    // 图标来自 SCP:SL 官方 wiki（CC BY-SA 3.0, by Northwood Studios），
    // 即游戏内 SCP-079 / SCP-106 地图使用的图形。渲染时按分区色重新着色。
    const roomGeom = [];
    const hasOutline = layout.rooms.some((r) => r.outline);
    const iconManifest = layout.icons ?? null;
    if (iconManifest?.icons) loadIcons(iconManifest.icons);
    const iconBase = layout.iconBase || 32;

    if (hasOutline) {
      const my = Math.max(0.15, Math.min(1, opacity));
      const alphaOf = (room) => my * (hasRoute && !room.onRoute ? 0.72 : 1);

      // ① 真实房间贴图（SCP:SL 房间图标，CC BY-SA 3.0）
      //
      //    分层规则（对齐社区地图工具的观感）：
      //      · **重要区域**（SCP 收容 / 核心 / 安保 / 检查点）用**分类色**，一眼能认出来
      //      · 其余（走廊 / 功能 / 人员 / 死路）用**统一灰**，保持整体剪影干净
      //      · 每个颜色**单独一层**：层内重叠同色 → 并成连续剪影；
      //        层间不叠加（后画的盖住先画的），所以不会出现"半透明叠深"的脏边
      //      · 层内必须**不透明**，目标透明度只在整层合成时施加一次
      //
      //    贴图本身已含走廊形状（如 LCZ_Curve 是带圆角的 L 形），故不再额外画走廊臂。
      const cats = iconManifest?.categories ?? null;
      const colorByCategory = opts.colorByCategory !== false && opts.byCategory !== false;
      const NEUTRAL_COLOR = '#D6DCE8';
      const colorFor = (cat) => {
        if (!colorByCategory) return NEUTRAL_COLOR;
        const meta = cats?.[cat];
        return meta?.accent && meta?.color ? meta.color : NEUTRAL_COLOR;
      };

      let textureDrawn = 0;
      /** 贴图用不上的房间（未解码 / 清单里没有）→ 逐个退回块+臂，避免地图上留洞 */
      const fallbackRooms = [];
      const useTextures = Boolean(iconManifest?.icons) && iconCacheReady() && iconBase > 0;

      if (useTextures) {
        const layer = textureLayer(t.cssWidth, t.cssHeight, opts.dpr || 1);
        const lc = layer.ctx;
        const scale = opts.dpr || 1;

        // 按颜色分桶；贴图没就绪的直接进回退队列
        const buckets = new Map();
        for (const room of layout.rooms) {
          const o = room.outline;
          if (!o) continue;
          const tinted = o.mapIcon ? tintedTexture(o.mapIcon, colorFor(o.category ?? 'corridor')) : null;
          if (!tinted) {
            fallbackRooms.push(room);
            continue;
          }
          const color = colorFor(o.category ?? 'corridor');
          let bucket = buckets.get(color);
          if (!bucket) { bucket = []; buckets.set(color, bucket); }
          bucket.push({ room, o, tinted });
        }

        // 统一灰先画，彩色的后画：重叠处让"重要区域"压在上面
        const ordered = [...buckets.entries()].sort((a, b) => (a[0] === NEUTRAL_COLOR ? -1 : b[0] === NEUTRAL_COLOR ? 1 : 0));

        for (const [, list] of ordered) {
          lc.setTransform(1, 0, 0, 1, 0, 0);
          lc.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
          lc.setTransform(scale, 0, 0, scale, 0, 0);
          for (const { room, o, tinted } of list) {
            const sizePx = iconBase * t.k;
            const cx = t.originX + o.center.x * t.k;
            const cy = t.originY + o.center.y * t.k;
            // 朝向：rotY 与"视图旋转"（core 分区 +180°）**都在 outline 里**。
            // 早期版本在渲染端读 room.rotationY（顶层没有这个字段）→ 恒为 0 → 贴图不旋转。
            const rot = ((o.rotationY + o.viewRotation) * Math.PI) / 180;
            if (rot) {
              lc.save();
              lc.translate(cx, cy);
              lc.rotate(rot);
              lc.drawImage(tinted, -sizePx / 2, -sizePx / 2, sizePx, sizePx);
              lc.restore();
            } else {
              lc.drawImage(tinted, cx - sizePx / 2, cy - sizePx / 2, sizePx, sizePx);
            }
            roomGeom.push({ room, x: cx - sizePx / 2, y: cy - sizePx / 2, w: sizePx, h: sizePx, cx, cy, half: sizePx / 2 });
            textureDrawn += 1;
          }
          ctx.save();
          ctx.globalAlpha = my;
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawImage(layer.canvas, 0, 0);
          ctx.restore();
        }
      } else {
        for (const room of layout.rooms) if (room.outline) fallbackRooms.push(room);
      }
      ctx.globalAlpha = my;

      // ①b 贴图不可用时的回退：走廊臂 + 中心块
      if (fallbackRooms.length) {
        const armWidth = Math.max(2, (layout.corridor ?? 7.5) * t.k);
        ctx.lineCap = 'butt';
        for (const room of fallbackRooms) {
          const o = room.outline;
          if (!o) continue;
          const cx = t.originX + o.center.x * t.k;
          const cy = t.originY + o.center.y * t.k;
          ctx.globalAlpha = alphaOf(room);
          ctx.strokeStyle = ZONE_ROOM_FILL[room.tone] || ZONE_ROOM_FILL.other;
          ctx.lineWidth = armWidth;
          ctx.beginPath();
          for (const arm of o.arms ?? []) {
            ctx.moveTo(cx, cy);
            ctx.lineTo(t.originX + arm.x * t.k, t.originY + arm.y * t.k);
          }
          ctx.stroke();
        }
        ctx.globalAlpha = my;
      }

      // ③ 回退：中心块（走廊臂已在 ①b 画过）
      if (fallbackRooms.length) {
        for (const room of fallbackRooms) {
          const o = room.outline;
          if (!o) continue;
          const half = Math.max(1.5, o.half * t.k);
          const cx = t.originX + o.center.x * t.k;
          const cy = t.originY + o.center.y * t.k;
          const r = o.isEnd ? Math.min(4, half * 0.35) : 0;
          roomGeom.push({ room, x: cx - half, y: cy - half, w: half * 2, h: half * 2, cx, cy, half });
          ctx.globalAlpha = alphaOf(room);
          ctx.fillStyle = ZONE_FILL[room.tone] || ZONE_FILL.other;
          if (r > 0) { roundRect(ctx, cx - half, cy - half, half * 2, half * 2, r); ctx.fill(); }
          else ctx.fillRect(cx - half, cy - half, half * 2, half * 2);
          ctx.globalAlpha = my;
          if (!o.isEnd) continue;
          ctx.strokeStyle = room.onRoute ? C.roomBorderRoute : C.roomBorder;
          ctx.lineWidth = 1;
          roundRect(ctx, cx - half + 0.5, cy - half + 0.5, half * 2 - 1, half * 2 - 1, r);
          ctx.stroke();
        }
      }

      // 路线高亮交给下面的路线段折线统一画（这里只做端点小圆点，避免大色块糊住房间形状）
      if (hasRoute) {
        ctx.globalAlpha = my;
        for (const room of layout.rooms) {
          const o = room.outline;
          if (!o || !room.onRoute) continue;
          const cx = t.originX + o.center.x * t.k;
          const cy = t.originY + o.center.y * t.k;
          ctx.beginPath();
          ctx.arc(cx, cy, Math.max(1.5, t.k * 0.8), 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,212,0,0.9)';
          ctx.fill();
        }
        ctx.globalAlpha = my;
      }

      // ④ 门口亮点（只在回退房间上画，因为图标本身已画出门口形状）
      if (fallbackRooms.length) {
        for (const room of fallbackRooms) {
          const o = room.outline;
          if (!o) continue;
          for (const arm of o.arms ?? []) {
            if (!arm.connected) continue;
            const ax = t.originX + arm.x * t.k;
            const ay = t.originY + arm.y * t.k;
            ctx.beginPath();
            ctx.arc(ax, ay, Math.max(1.6, t.k * 0.9), 0, Math.PI * 2);
            ctx.fillStyle = C.door;
            ctx.fill();
          }
        }
      }
    }

    // 兼容旧布局（无 outline）：退回等大方块
    if (!hasOutline) {
      for (const room of layout.rooms) {
        const x = t.originX + room.x * t.k;
        const y = t.originY + room.y * t.k;
        const w = room.w * t.k;
        const h = room.h * t.k;
        const geom = { room, x, y, w, h, cx: x + w / 2, cy: y + h / 2, half: w / 2 };
        roomGeom.push(geom);
        ctx.fillStyle = ZONE_FILL[room.tone] || ZONE_FILL.other;
        ctx.globalAlpha = Math.max(0.15, Math.min(1, opacity)) * (hasRoute && !room.onRoute ? 0.72 : 1);
        ctx.fillRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));
        ctx.globalAlpha = Math.max(0.15, Math.min(1, opacity));
        if (room.onRoute) {
          ctx.fillStyle = 'rgba(255,212,0,0.14)';
          ctx.fillRect(x, y, w, h);
        }
      }
    }

    // 墙 + 门（先把门换算到边的位置，再挖缺口）
    // 方案 B 下走廊臂已经表达了通路，不再叠一层方格墙，否则形状会被方框盖回去。
    const doorGap = Math.max(4, Math.min(9, t.k * 4.2));
    for (const { room, x, y, w, h } of hasOutline ? [] : roomGeom) {
      const gaps = { top: [], right: [], bottom: [], left: [] };
      for (const door of room.doors || []) {
        const dx = t.originX + door.x * t.k;
        const dy = t.originY + door.y * t.k;
        const dist = [
          { side: 'top', d: Math.abs(dy - y), pos: dx },
          { side: 'bottom', d: Math.abs(dy - (y + h)), pos: dx },
          { side: 'left', d: Math.abs(dx - x), pos: dy },
          { side: 'right', d: Math.abs(dx - (x + w)), pos: dy },
        ].sort((a, b) => a.d - b.d)[0];
        if (dist.d > Math.max(3, t.k * 9)) continue;
        gaps[dist.side].push([dist.pos - doorGap / 2, dist.pos + doorGap / 2]);
      }

      ctx.strokeStyle = room.onRoute ? C.roomBorderRoute : C.roomBorder;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const [s, e] of wallRuns(x, x + w, gaps.top)) {
        ctx.moveTo(s, y + 0.5);
        ctx.lineTo(e, y + 0.5);
      }
      for (const [s, e] of wallRuns(x, x + w, gaps.bottom)) {
        ctx.moveTo(s, y + h - 0.5);
        ctx.lineTo(e, y + h - 0.5);
      }
      for (const [s, e] of wallRuns(y, y + h, gaps.left)) {
        ctx.moveTo(x + 0.5, s);
        ctx.lineTo(x + 0.5, e);
      }
      for (const [s, e] of wallRuns(y, y + h, gaps.right)) {
        ctx.moveTo(x + w - 0.5, s);
        ctx.lineTo(x + w - 0.5, e);
      }
      ctx.stroke();

      // 门：缺口中间画一条短亮线
      ctx.strokeStyle = C.door;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (const [s, e] of gaps.top) {
        const c = (s + e) / 2;
        ctx.moveTo(c - doorGap / 3, y + 0.5);
        ctx.lineTo(c + doorGap / 3, y + 0.5);
      }
      for (const [s, e] of gaps.bottom) {
        const c = (s + e) / 2;
        ctx.moveTo(c - doorGap / 3, y + h - 0.5);
        ctx.lineTo(c + doorGap / 3, y + h - 0.5);
      }
      for (const [s, e] of gaps.left) {
        const c = (s + e) / 2;
        ctx.moveTo(x + 0.5, c - doorGap / 3);
        ctx.lineTo(x + 0.5, c + doorGap / 3);
      }
      for (const [s, e] of gaps.right) {
        const c = (s + e) / 2;
        ctx.moveTo(x + w - 0.5, c - doorGap / 3);
        ctx.lineTo(x + w - 0.5, c + doorGap / 3);
      }
      ctx.stroke();
    }

    // ── 路线 ────────────────────────────────────────────────
    if (layout.route && layout.route.ok) {
      const segs = layout.route.segments || [];
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const segment of segs) {
        if (segment.points.length < 2) continue;
        const pts = segment.points.map((p) => toScreen(p, t));
        ctx.save();
        ctx.shadowColor = 'rgba(255,212,0,0.35)';
        ctx.shadowBlur = 14;
        ctx.strokeStyle = C.route;
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
        ctx.restore();
      }

      // 跨层：用正交虚线连接两段（先竖下、再横移、再竖下），而不是斜穿整张图
      for (let i = 1; i < segs.length; i += 1) {
        const a = segs[i - 1].points.at(-1);
        const b = segs[i].points[0];
        if (!a || !b) continue;
        const pa = toScreen(a, t);
        const pb = toScreen(b, t);
        const midY = (pa.y + pb.y) / 2;
        ctx.save();
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = C.portal;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pa.x, midY);
        ctx.lineTo(pb.x, midY);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
        ctx.restore();
        const note = segs[i].enterNote;
        if (note) {
          ctx.font = FONT;
          const w = ctx.measureText(`↓ ${note}`).width + 10;
          const cx = Math.min(Math.max(pa.x, t.panelX + 4 + w / 2), t.panelX + t.panelW - 4 - w / 2);
          const box = chip(ctx, `↓ ${note}`, cx, pa.y + 12, { align: 'center', baseline: 'top', bg: 'rgba(10,20,34,0.9)', color: '#BFDBFF' });
          labelBoxes.push({ x: box.x, y: box.y, w: box.w, h: box.h });
        }
      }

      // 起终点
      const start = layout.route.start ? toScreen(layout.route.start, t) : null;
      const end = layout.route.end ? toScreen(layout.route.end, t) : null;
      const dot = (p, color) => {
        if (!p) return;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 8.5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.stroke();
      };
      dot(start, C.start);
      dot(end, C.end);
    }

    // ── POI ────────────────────────────────────────────────
    const pois = (layout.pois || []).slice().sort((a, b) => (b.priority || 0) - (a.priority || 0));
    ctx.font = FONT;
    for (const poi of pois) {
      if (poi.kind === 'Pocket') continue;
      const p = toScreen(poi, t);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4.6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = poi.color || '#9AA4B2';
      ctx.fill();
    }

    if (showLabels) {
      // 先放路线端点标签，再按优先级放其余
      const clipX0 = t.panelX + 2;
      const clipX1 = t.panelX + t.panelW - 2;
      const clipY0 = t.panelY + 2;
      const clipY1 = t.panelY + t.panelH - 2;
      const ordered = (layout.pois || []).slice().sort((a, b) => {
        const rank = (p) => (p.onRoute ? 2 : 0) + (p.priority >= 70 ? 1 : 0);
        return rank(b) - rank(a) || (b.priority || 0) - (a.priority || 0);
      });
      const endpointIds = new Set([layout.route?.fromRoomId, layout.route?.toRoomId].filter(Boolean));
      for (const poi of ordered) {
        if (poi.kind === 'Pocket') continue;
        // 只有起终点标签强制显示；路线中间经过的点位照常参与避让，避免密集区糊成一团
        const force = endpointIds.has(poi.roomId);
        const must = poi.onRoute || poi.priority >= 85;
        // 全设施视图是战略总览，只留高优先级标签，避免密集区糊成一片
        const minPriority = layout.bands.length > 1 ? 70 : 50;
        if (!force && !must && (!poi.showLabel || (poi.priority || 0) < minPriority)) continue;
        if (!force && must && !poi.showLabel && !endpointIds.has(poi.roomId)) continue;
        const p = toScreen(poi, t);
        const width = ctx.measureText(poi.label).width + 10;
        // 依次尝试：右 → 左 → 下 → 上，取第一个不撞的；must 的允许硬放
        const candidates = [
          { x: p.x + 7, y: p.y - 8 },
          { x: p.x - 7 - width, y: p.y - 8 },
          { x: p.x - width / 2, y: p.y + 6 },
          { x: p.x - width / 2, y: p.y - 22 },
        ];
        let placed = null;
        for (const candidate of candidates) {
          const x = Math.min(Math.max(candidate.x, clipX0), Math.max(clipX0, clipX1 - width));
          const y = Math.min(Math.max(candidate.y, clipY0), Math.max(clipY0, clipY1 - 16));
          const box = { x, y, w: width, h: 16 };
          const overlaps = labelBoxes.some((b) => !(box.x > b.x + b.w || box.x + box.w < b.x || box.y > b.y + b.h || box.y + box.h < b.y));
          if (!overlaps) {
            placed = box;
            break;
          }
          if (!placed) placed = box;
        }
        if (!placed) continue;
        const overlapsFinal = labelBoxes.some((b) => !(placed.x > b.x + b.w || placed.x + placed.w < b.x || placed.y > b.y + b.h || placed.y + placed.h < b.y));
        if (overlapsFinal && !force) continue;
        const drawn = chip(ctx, poi.label, placed.x, placed.y, { align: 'left', baseline: 'top', font: FONT, color: '#F2F5F8', bg: 'rgba(0,0,0,0.66)' });
        labelBoxes.push(drawn);
      }
    }

    ctx.restore();
    ctx.restore();

    // v0.3.0：把屏幕空间几何存下来，供悬停命中检测（overlay.js 的 roomAt）与导出合成用
    lastRoomGeom = roomGeom.filter(Boolean);
  }

  /**
   * v0.3.0：命中检测 —— 屏幕坐标（CSS 像素）落在哪个房间里。
   * 取**最上面**命中的房间（数组后面的后画，视觉上在上层）。
   * @param {number} x 屏幕 X（CSS 像素）
   * @param {number} y 屏幕 Y（CSS 像素）
   * @returns {{room: object, cx:number, cy:number, w:number, h:number}|null}
   */
  function roomAt(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    for (let i = lastRoomGeom.length - 1; i >= 0; i -= 1) {
      const g = lastRoomGeom[i];
      if (!g || !Number.isFinite(g.x)) continue;
      if (x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h) {
        return { room: g.room, cx: g.cx, cy: g.cy, w: g.w, h: g.h };
      }
    }
    return null;
  }

  /**
   * v0.3.0：导出合成 —— 面板区域离屏 canvas（2 倍分辨率），
   * 不含状态条（那是 DOM）。透明区域垫上深色底，跟覆盖层视觉一致。
   * @param {object} t computeTransform 的返回值
   * @param {number} dpr 设备像素比
   * @returns {HTMLCanvasElement|null}
   */
  function composeExport(t, dpr = 1) {
    if (!t) return null;
    const scale = 2; // 2 倍超采样，PNG 放大也清晰
    const w = Math.max(1, Math.round(t.panelW * scale));
    const h = Math.max(1, Math.round(t.panelH * scale));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const c2 = cv.getContext('2d');
    c2.fillStyle = '#0d1015'; // 覆盖层窗口底色（窗口本身全透明，这里垫一层深色）
    c2.fillRect(0, 0, w, h);
    c2.drawImage(
      document.getElementById('map'),
      Math.round(t.panelX * dpr), Math.round(t.panelY * dpr),
      Math.round(t.panelW * dpr), Math.round(t.panelH * dpr),
      0, 0, w, h,
    );
    return cv;
  }

  /** v0.3.0：当前布局/变换的只读快照（悬停、导出、selftest 都用） */
  function lastDrawState() {
    return { transform: lastTransform, roomCount: lastRoomGeom.length };
  }

  /** 贴图是否已全部解码完（决定能否走"离屏合并"路径）。
   *  要求"没有一张还在解码中"，否则会画出"一半贴图一半方块"的中间态；
   *  解码失败的（404）不算待定 —— 那些房间会逐个走块+臂回退。 */
  function iconCacheReady() {
    let any = false;
    for (const rec of iconCache.values()) {
      if (rec.ready) any = true;
      else if (!rec.failed) return false;
    }
    return any;
  }

  /** 图标加载状态（离屏出图工具用它判断"可以截图了"） */
  function iconsStatus() {
    let loaded = 0;
    for (const rec of iconCache.values()) if (rec.ready) loaded += 1;
    return { total: iconCache.size, loaded };
  }

  window.OverlayRender = {
    draw, computeTransform, toScreen, chip, roundRect, wallRuns, loadIcons, iconsStatus,
    roomAt, composeExport, lastDrawState,
    C, FONT, PAD,
  };
})();
