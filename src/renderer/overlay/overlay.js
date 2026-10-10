/* 覆盖层窗口逻辑：只做「收数据 → 画」和「发意图」，不改任何状态（§5.2 / §7） */
(function () {
  'use strict';

  const api = window.mapOverlay || null;
  const params = new URLSearchParams(location.search);
  const isPreview = params.get('preview') === '1';

  const canvas = document.getElementById('map');
  const ctx = canvas.getContext('2d');
  const statusbar = document.getElementById('statusbar');
  const legend = document.getElementById('legend');
  const errorCard = document.getElementById('error');
  const editFrame = document.getElementById('editframe');
  const sbSeed = document.getElementById('sb-seed');
  const sbView = document.getElementById('sb-view');
  const sbRoute = document.getElementById('sb-route');
  const sbVersion = document.getElementById('sb-version');
  const sbBanner = document.getElementById('sb-banner');
  const lgHint = document.getElementById('lg-hint');
  const lgSwatches = document.getElementById('lg-swatches');
  const efHintExit = document.getElementById('ef-hint-exit');

  const state = {
    layout: null,
    status: null,
    transform: null,
    opacity: 0.75,
    scale: 1,
    autoFit: true,
    anchor: { x: 0.5, y: 0.62 },
    showLabels: true,
    colorByCategory: true,
    editMode: false,
    fitHeightRatio: 0.35,
    hotkeys: null,
    visible: false,
  };

  if (isPreview) document.body.classList.add('preview');

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    state.dpr = dpr;
    state.cssWidth = w;
    state.cssHeight = h;
    state.transform = null; // 尺寸变了重新 auto-fit
    redraw();
  }

  function redraw() {
    applyChromeOpacity();
    if (!state.layout) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const t = window.OverlayRender.computeTransform({
      layout: state.layout,
      cssWidth: state.cssWidth,
      cssHeight: state.cssHeight,
      scale: state.scale,
      autoFit: state.autoFit,
      anchor: state.anchor,
      fitHeightRatio: state.fitHeightRatio,
      frozen: state.transform,
    });
    state.transform = t;
    window.OverlayRender.draw(ctx, {
      layout: state.layout,
      transform: t,
      opacity: state.opacity,
      showLabels: state.showLabels,
      colorByCategory: state.colorByCategory,
      preview: isPreview,
      dpr: state.dpr || 1,
    });
    positionChrome(t);
  }

  /**
   * 把 top/left 夹进窗口内。
   * 历史 bug：状态条 `white-space:nowrap` + 按面板宽度设 max-width 时，文字压不下去会跑出方框。
   * 现在 flex 子项都有 min-width:0 / 溢出隐藏，文字超长改走**换行**（style.css `flex-wrap`），
   * 因此可以放心把条的宽度贴回地图面板。
   */
  function clampLeft(desired, width, margin) {
    const max = Math.max(margin, state.cssWidth - margin - Math.max(width, 0));
    return Math.min(Math.max(desired, margin), max);
  }

  function positionChrome(t) {
    if (!t) return;
    const margin = 8;
    // 两条状态条与地图面板**等宽对齐**（用户反馈：条比地图宽出很多很违和）。
    // 面板过窄时给 320px 保底，保证单分区小图下文字仍可读。
    const barW = Math.max(320, t.panelW);
    const left = clampLeft(t.panelX, barW, margin);
    for (const el of [statusbar, legend]) {
      el.style.width = `${Math.min(barW, state.cssWidth - margin * 2)}px`;
      el.style.maxWidth = `${state.cssWidth - margin * 2}px`;
      el.style.left = `${left}px`;
    }
    // 高度按**实际测量**：状态条超长换行后会变两行高，写死 32 会盖到地图上（用户反馈）
    const sbH = statusbar.offsetHeight || 32;
    const lgH = legend.offsetHeight || 28;
    statusbar.style.top = `${Math.max(margin, t.panelY - sbH - 8)}px`;
    legend.style.top = `${Math.min(state.cssHeight - lgH - margin, t.panelY + t.panelH + 6)}px`;
  }

  /** 图例：按房间分类色生成色块（与渲染实际用的 accent 分类一致） */
  function renderLegend() {
    const cats = state.layout?.icons?.categories ?? null;
    if (!cats) return;
    const items = Object.entries(cats).filter(([, meta]) => meta?.accent && meta?.color);
    const neutral = cats.corridor?.color ?? '#D6DCE8';
    const html = items.map(([, meta]) => `<span class="lg-item"><i class="sw" style="background:${meta.color}"></i>${meta.short ?? meta.label ?? ''}</span>`).join('')
      + `<span class="lg-item"><i class="sw" style="background:${neutral}"></i>其余</span>`;
    if (lgSwatches.dataset.html !== html) {
      lgSwatches.innerHTML = html;
      lgSwatches.dataset.html = html;
      if (state.transform) positionChrome(state.transform);
    }
  }

  /** HUD 条（顶部状态条 / 底部图例条）透明度跟随设置里的透明度滑块。
   *  两条与地图一致、互相一致（用户反馈：图例条曾因自动淡出一直偏透明）。 */
  function applyChromeOpacity() {
    const value = Math.max(0.3, Math.min(1, Number(state.opacity) || 0.75));
    document.documentElement.style.setProperty('--hud-opacity', String(value));
  }

  function renderStatus() {
    const s = state.status;
    if (!s) return;
    sbSeed.textContent = s.seed ? `种子 ${s.seed}` : '种子 —（去游戏里敲一次 seed）';
    sbView.textContent = s.viewLabel ?? '—';
    const route = s.route;
    if (route && route.ok !== false) {
      const cross = route.portalCount ? ` · 跨层 ${route.portalCount}` : '';
      sbRoute.textContent = `路线 ${route.fromLabel ?? '?'} → ${route.toLabel ?? '?'}（${route.rooms} 房间${cross}）`;
    } else if (route && route.reason) {
      sbRoute.textContent = `路线不可用：${route.reason}`;
    } else {
      sbRoute.textContent = '无路线';
    }
    const v = s.version;
    sbVersion.textContent = v ? `游戏 ${v.game ?? '?'} · 模板 ${v.template ?? '?'}` : '';
    const banner = s.banner;
    if (banner && banner.code !== 'OK') {
      sbBanner.textContent = banner.text;
      sbBanner.className = `sb-banner ${banner.level}`;
    } else if (banner) {
      sbBanner.textContent = '版本匹配';
      sbBanner.className = 'sb-banner info';
    }
    if (s.hotkeys) {
      state.hotkeys = s.hotkeys;
      lgHint.textContent = `${s.hotkeys.cycleView} 切视图 · ${s.hotkeys.cycleRoute} 切路线 · ${s.hotkeys.toggle} 隐藏 · ${s.hotkeys.editMode} 编辑`;
      efHintExit.textContent = s.hotkeys.editMode ?? 'Ctrl+0';
    }
    statusbar.classList.toggle('hidden', !state.visible && !isPreview);
    legend.classList.toggle('hidden', !state.visible && !isPreview);
    editFrame.classList.toggle('hidden', !state.editMode);
    // 显示状态变了，尺寸也就变了 —— 重新夹一次位置（否则刚显出来的条可能还压在旧宽度上）
    positionChrome(state.transform);
  }

  function showError(payload) {
    errorCard.classList.remove('hidden');
    document.getElementById('ec-title').textContent = payload.title || payload.code || '出错了';
    document.getElementById('ec-body').textContent = payload.detail || payload.message || '';
  }

  function clearError() {
    errorCard.classList.add('hidden');
  }

  /* ── 编辑模式：拖动 / 滚轮 ─────────────────────────────── */
  let dragging = null;
  window.addEventListener('mousedown', (e) => {
    if (!state.editMode || e.button !== 0) return;
    dragging = { startX: e.clientX, startY: e.clientY, anchor: { ...state.anchor } };
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = (e.clientX - dragging.startX) / state.cssWidth;
    const dy = (e.clientY - dragging.startY) / state.cssHeight;
    state.anchor = {
      x: Math.min(1, Math.max(0, dragging.anchor.x + dx)),
      y: Math.min(1, Math.max(0, dragging.anchor.y + dy)),
    };
    redraw();
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = null;
    api?.intent?.setOverlay?.({ anchor: state.anchor });
  });
  window.addEventListener('wheel', (e) => {
    if (!state.editMode) return;
    api?.intent?.cycleScale?.(e.deltaY > 0 ? -1 : 1);
  }, { passive: true });
  window.addEventListener('contextmenu', () => {
    if (!state.editMode) return;
    state.anchor = { x: 0.5, y: 0.62 };
    redraw();
    api?.intent?.setOverlay?.({ anchor: state.anchor });
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.editMode) api?.intent?.setOverlay?.({ editMode: false });
  });

  /* ── IPC 接线 ─────────────────────────────────────────── */
  if (api) {
    api.onLayout((layout) => {
      state.layout = layout;
      state.transform = null;
      redraw();
      renderLegend();
    });
    api.onStatus((payload) => {
      // 主进程广播的是 { status, watcher, hotkeyReport }，这里要拆开
      state.status = payload?.status ?? payload ?? null;
      state.watcher = payload?.watcher ?? state.watcher;
      renderStatus();
    });
    api.onOverlayState((overlay) => {
      const prevScale = state.scale;
      state.opacity = overlay.opacity ?? state.opacity;
      state.scale = overlay.scale ?? state.scale;
      state.autoFit = overlay.autoFit ?? state.autoFit;
      state.anchor = overlay.anchor ?? state.anchor;
      state.showLabels = overlay.showLabels ?? state.showLabels;
      state.colorByCategory = overlay.colorByCategory ?? state.colorByCategory;
      state.editMode = Boolean(overlay.editMode);
      state.visible = overlay.visible ?? state.visible;
      state.fitHeightRatio = overlay.fitHeightRatio ?? state.fitHeightRatio;
      if (prevScale !== state.scale) state.transform = null;
      redraw();
      renderStatus();
    });
    api.onError((payload) => {
      if (payload?.code === 'CLEAR') clearError();
      else showError(payload);
    });
    api.ready();
  } else if (!isPreview) {
    showError({ title: 'preload 未加载', detail: '窗口未通过 preload 暴露 API。' });
  }

  window.addEventListener('resize', resize);

  // 房间图标是异步解码的：加载完一张就重绘一次，避免首帧空白
  window.__onIconLoaded = () => { if (state.layout) redraw(); };

  // 预览模式：允许外部直接喂 layout（tools/render-preview.mjs 用）
  window.__overlayPreview = {
    setLayout(layout, options = {}) {
      state.layout = layout;
      if (options.status) state.status = options.status;
      if (options.visible !== undefined) state.visible = options.visible;
      if (options.scale !== undefined) state.scale = options.scale;
      if (options.fitHeightRatio !== undefined) state.fitHeightRatio = options.fitHeightRatio;
      if (options.colorByCategory !== undefined) state.colorByCategory = options.colorByCategory;
      if (options.anchor !== undefined) state.anchor = options.anchor;
      state.transform = null;
      resize();
      redraw();
      renderLegend();
      renderStatus();
      positionChrome(state.transform);
      statusbar.classList.remove('hidden');
      legend.classList.remove('hidden');
      positionChrome(state.transform);
      return { transform: state.transform };
    },
    ready: false,
  };

  resize();
  if (isPreview) {
    statusbar.classList.remove('hidden');
    legend.classList.remove('hidden');
  }
})();
