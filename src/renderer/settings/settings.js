/* 设置窗口逻辑：所有改动都是 intent / settings 写入，状态由主进程广播回来（§7） */
(function () {
  'use strict';

  const api = window.mapOverlay;
  const $ = (id) => document.getElementById(id);
  let boot = null;      // app:getStatus 的返回
  let hotkeyReport = {};

  /** 自定义路线的名称来自用户输入，插入 DOM 前必须转义 */
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function applyStatus(payload) {
    if (!payload) return;
    const status = payload.status ?? payload;
    const meta = payload.meta ?? boot?.meta ?? {};
    if (payload.hotkeyReport) hotkeyReport = payload.hotkeyReport;
    if (payload.watcher) boot.watcher = payload.watcher;

    $('pill-seed').textContent = `种子 ${status.seed ?? '—'}`;
    $('pill-seed').className = `pill ${status.seed ? 'ok' : ''}`;
    const v = status.version ?? {};
    $('pill-version').textContent = `游戏 ${v.game ?? '?'} · 模板 ${v.template ?? '?'}`;
    $('pill-version').className = `pill ${v.match ? 'ok' : v.game ? 'warn' : ''}`;
    const w = boot?.watcher ?? {};
    const watcherText = w.exists === false ? '日志未找到' : w.state === 'degraded' ? '读取异常' : '监听中';
    $('pill-watcher').textContent = `${watcherText} · ${status.seedSource ?? '-'}`;
    $('pill-watcher').className = `pill ${w.exists === false ? 'err' : 'ok'}`;

    $('v-game').textContent = `${v.game ?? '—'}（${v.gameSource ?? '-'}）`;
    $('v-template').textContent = v.template ?? '—';
    $('v-poi').textContent = `${v.poi ?? '—'}（${status.poiTableFile ?? '-'}）`;
    $('v-gate').textContent = status.banner ? `[${status.banner.level}] ${status.banner.text}` : '—';
    $('v-rooms').textContent = `${status.roomCount ?? 0} / ${status.edgeCount ?? 0}`;
    const d = status.diagnostics ?? {};
    $('v-unpaired').textContent = d.unpairedConnectorCount === undefined ? '—' : `${d.unpairedConnectorCount} / ${d.connectorCount ?? '?'}`;
    $('v-portals').textContent = status.portalCount ?? '—';
    $('v-timing').textContent = `${status.timing?.generateMs ?? '—'} ms / ${status.timing?.layoutMs ?? '—'} ms`;
    $('v-poi-stats').textContent = status.poiStats ? `exact ${status.poiStats.exact} · heuristic ${status.poiStats.heuristic} · manual ${status.poiStats.manual}` : '—';
    $('v-missing').textContent = status.missingPois?.length ? status.missingPois.join(', ') : '无';

    if (status.hotkeys) {
      $('hk-toggle-hint').textContent = status.hotkeys.toggle || '未设置';
      $('hk-edit-hint').textContent = status.hotkeys.editMode || '未设置';
      $('hk-route-hint').textContent = status.hotkeys.cycleRoute || '未设置';
    }
    if (status.viewLabel) $('subtitle').textContent = `离线地图覆盖层 · 当前视图 ${status.viewLabel} · 不读内存 · 不注入 · 不模拟操作`;
  }

  function renderHotkeys(settings, report) {
    const list = $('hotkeyList');
    const labels = boot?.meta?.hotkeyLabels ?? {};
    if (!list.dataset.built) {
      list.innerHTML = '';
      for (const action of Object.keys(labels)) {
        const item = document.createElement('div');
        item.className = 'hotkey-item';
        item.innerHTML = `<span class="label">${labels[action]}</span>
          <input type="text" readonly data-action="${action}" placeholder="未设置（点击后按键）" />
          <span class="hotkey-note" data-note="${action}"></span>`;
        list.appendChild(item);
      }
      list.dataset.built = '1';
      list.querySelectorAll('input').forEach((input) => {
        input.addEventListener('focus', () => {
          input.classList.add('capturing');
          input.value = '按下新热键…（1–3 键，Esc 取消，Del 清空）';
          // 录入期间临时注销全局热键，否则按下的组合会被 RegisterHotKey 抢走、根本到不了这里
          api.intent.setCapture(true);
        });
        input.addEventListener('blur', () => {
          input.classList.remove('capturing');
          input.value = settingsCache?.hotkeys?.[input.dataset.action] ?? '';
          api.intent.setCapture(false);
        });
        input.addEventListener('keydown', async (event) => {
          event.preventDefault();
          const action = input.dataset.action;
          // 按键 → accelerator 的判定在主进程做（hotkeys.js，可单测），这里只显示结果
          const result = await api.intent.captureKey({
            code: event.code,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            shiftKey: event.shiftKey,
            metaKey: event.metaKey,
          });
          if (!result || result.action === 'wait') {
            input.value = '再按一个主键…（共 1–3 键）';
            return;
          }
          if (result.action === 'cancel') { input.blur(); return; }
          if (result.action === 'reject') { input.value = result.reason ?? '这个组合不支持'; return; }
          const accelerator = result.action === 'clear' ? '' : String(result.accelerator ?? '');
          if (accelerator) {
            const labelsMap = boot?.meta?.hotkeyLabels ?? {};
            const dup = Object.entries(settingsCache?.hotkeys ?? {})
              .find(([other, value]) => other !== action && String(value).toLowerCase() === accelerator.toLowerCase());
            if (dup) {
              input.value = `与「${labelsMap[dup[0]] ?? dup[0]}」重复，换一个`;
              return;
            }
          }
          const saved = await api.settings.set({ hotkeys: { [action]: accelerator } });
          settingsCache = saved.settings ?? settingsCache;
          applyStatus(saved);
          input.blur(); // blur → setCapture(false) → 主进程重注册并广播 hotkey:conflict → 列表刷新
        });
      });
    }
    for (const [action, accel] of Object.entries(settings.hotkeys ?? {})) {
      const input = list.querySelector(`input[data-action="${action}"]`);
      if (input && document.activeElement !== input) input.value = accel ?? '';
      const note = list.querySelector(`[data-note="${action}"]`);
      if (!note) continue;
      const report_ = report?.[action];
      if (!accel) {
        note.className = 'hotkey-note';
        note.textContent = '已停用（点击输入框可重新设置）';
      } else if (report_ && report_.ok === false) {
        note.className = 'hotkey-note err';
        note.textContent = report_.error ?? '注册失败';
      } else if (report_ && report_.conflict) {
        note.className = 'hotkey-note warn';
        note.textContent = `⚠ ${report_.note}`;
      } else if (!String(accel).includes('+')) {
        note.className = 'hotkey-note warn';
        note.textContent = '⚠ 单键会在所有程序里抢走该键（含游戏内打字）';
      } else {
        note.className = 'hotkey-note ok';
        note.textContent = '✅ 可用';
      }
    }
  }

  function renderPresets(settings) {
    const list = $('presetList');
    const presets = boot?.meta?.presets ?? [];
    list.innerHTML = '';
    for (const preset of presets) {
      const label = document.createElement('label');
      const checked = (settings.presets ?? []).includes(preset.id);
      label.innerHTML = `<input type="checkbox" ${checked ? 'checked' : ''} data-preset="${preset.id}" />
        <span>${preset.label}</span><span class="hint">${preset.hint ?? ''}</span>`;
      label.querySelector('input').addEventListener('change', (event) => {
        const current = new Set(settingsCache.presets ?? []);
        if (event.target.checked) current.add(preset.id);
        else current.delete(preset.id);
        api.intent.setPresets([...current]).then((result) => {
          settingsCache = result.settings ?? settingsCache;
          applyStatus(result);
        });
      });
      list.appendChild(label);
    }
  }

  let settingsCache = null;
  let routeTargets = [];
  let targetsBuilt = false;

  /* ── 自定义路线 ───────────────────────────────────────────
     端点用「与种子无关」的选择器（房名 / prefab / 类别）保存，
     所以换种子后同一条路线会自动落到当局限定的那个房间上。 */
  function buildTargetOptions() {
    // 优先用主进程给的全量清单（与种子无关）；没有就退回内置预设里的类别
    let list = boot?.meta?.routeTargets ?? [];
    if (!Array.isArray(list) || list.length === 0) {
      list = (boot?.meta?.presets ?? []).map((p) => ({
        id: `preset:${p.id}`, group: '预设', label: p.label, sub: p.id, selector: p.from,
      }));
    }
    routeTargets = list;
    const groups = new Map();
    for (const target of list) {
      const key = target.group ?? '其他';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(target);
    }
    for (const selectId of ['cr-from', 'cr-to']) {
      const select = $(selectId);
      select.innerHTML = '';
      for (const [group, items] of groups) {
        const optgroup = document.createElement('optgroup');
        optgroup.label = group;
        for (const item of items) {
          const option = document.createElement('option');
          option.value = item.id;
          const zone = item.zone ? `${item.zone} · ` : '';
          option.textContent = `${zone}${item.label}${item.sub ? `（${item.sub}）` : ''}`;
          select.appendChild(option);
        }
        select.appendChild(optgroup);
      }
    }
    targetsBuilt = true;
    // 默认选一对常见的：A 大门 → 核弹井（用户举的例子）
    pickDefault(('cr-from'), ['room:EzGateA', 'prefab:EZ_GateA', 'kind:Gate']);
    pickDefault(('cr-to'), ['room:HczWarhead', 'kind:WarheadSilo']);
  }

  function pickDefault(selectId, preferred) {
    const select = $(selectId);
    if (!select || select.options.length === 0) return;
    for (const id of preferred) {
      const hit = [...select.options].find((o) => o.value === id);
      if (hit) { select.value = id; return; }
    }
  }

  function targetById(id) {
    return routeTargets.find((t) => t.id === id) ?? null;
  }

  function renderCustomRoutes(settings) {
    const list = $('cr-list');
    const routes = settings.customRoutes ?? [];
    list.innerHTML = '';
    if (routes.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = '还没有自定义路线。选好起点终点，点「添加路线」。';
      list.appendChild(empty);
      return;
    }
    for (const route of routes) {
      const row = document.createElement('label');
      const checked = route.enabled !== false;
      row.innerHTML = `<input type="checkbox" ${checked ? 'checked' : ''} data-route="${route.id}" />
        <span>${escapeHtml(route.label)}</span>
        <span class="hint">${escapeHtml(describeSelector(route.from))} → ${escapeHtml(describeSelector(route.to))}</span>
        <button class="btn danger tiny" data-del="${route.id}">删除</button>`;
      row.querySelector('input').addEventListener('change', (event) => {
        updateRoutes(routes.map((r) => (r.id === route.id ? { ...r, enabled: event.target.checked } : r)));
      });
      row.querySelector('button').addEventListener('click', (event) => {
        event.preventDefault();
        updateRoutes(routes.filter((r) => r.id !== route.id));
      });
      list.appendChild(row);
    }
  }

  /** 选择器 → 可读文本（先按点位清单反查友好名字，查不到再退回原始标识） */
  function describeSelector(selector) {
    if (!selector) return '?';
    const first = (list, prefix) => (Array.isArray(list) && list.length ? `${prefix}${list[0]}` : null);
    const key = first(selector.roomNames, 'room:') ?? first(selector.prefabs, 'prefab:') ?? first(selector.kinds, 'kind:');
    const hit = key ? targetById(key) : null;
    if (hit) return hit.label;
    if (selector.roomNames?.length) return selector.roomNames.join(' / ');
    if (selector.prefabs?.length) return selector.prefabs.join(' / ');
    if (selector.kinds?.length) {
      const meta = boot?.meta?.kindLabels ?? {};
      return selector.kinds.map((k) => meta[k] ?? k).join(' / ');
    }
    return '?';
  }

  async function updateRoutes(routes) {
    const result = await api.settings.set({ customRoutes: routes });
    settingsCache = result.settings ?? settingsCache;
    applyStatus(result);
    applySettings(settingsCache);
  }

  async function addRoute() {
    const fromTarget = targetById($('cr-from').value);
    const toTarget = targetById($('cr-to').value);
    if (!fromTarget || !toTarget) { $('cr-status').textContent = '请先选择起点与终点'; return; }
    if (fromTarget.id === toTarget.id) { $('cr-status').textContent = '起点和终点不能是同一个点位'; return; }
    const label = $('cr-label').value.trim() || `${fromTarget.label} → ${toTarget.label}`;
    const id = `user-${Date.now().toString(36)}`;
    const next = [...(settingsCache.customRoutes ?? []), { id, label, from: fromTarget.selector, to: toTarget.selector, enabled: true }];
    await updateRoutes(next);
    $('cr-label').value = '';
    $('cr-status').textContent = `已添加「${label}」。换种子时会自动重算。`;
  }

  function applySettings(settings) {
    settingsCache = settings;
    $('autoStart').checked = Boolean(settings.autoStart);
    $('visibleOnStart').checked = Boolean(settings.overlay.visibleOnStart);
    $('logPath').value = settings.seed.logPath ?? '';
    $('logPath').placeholder = boot?.meta?.defaultLogPath ?? '自动检测 Player.log';
    $('manualSeed').value = settings.seed.manualOverride ?? '';
    $('logLevel').value = settings.logLevel ?? 'info';
    $('opacity').value = settings.overlay.opacity;
    $('opacityValue').textContent = Number(settings.overlay.opacity).toFixed(2);
    $('scaleIndex').value = settings.overlay.scaleIndex;
    const steps = boot?.meta?.scaleSteps ?? [0.8, 1, 1.3, 1.6];
    $('scaleValue').textContent = `${Number(steps[settings.overlay.scaleIndex] ?? 1).toFixed(2)}×`;
    $('autoFit').checked = Boolean(settings.overlay.autoFit);
    $('showLabels').checked = Boolean(settings.overlay.showLabels);
    $('colorByCategory').checked = settings.overlay.colorByCategory !== false;
    $('showSurfaceBand').checked = settings.overlay.showSurfaceBand !== false;
    $('smartVisibility').checked = Boolean(settings.overlay.smartVisibility);
    $('displayMode').value = settings.overlay.display === 'primary' ? 'primary' : 'auto';
    $('anchorHint').textContent = `x ${Number(settings.overlay.anchor.x).toFixed(2)} · y ${Number(settings.overlay.anchor.y).toFixed(2)}（编辑模式下拖动覆盖层）`;
    $('store-hint').textContent = boot?.meta?.settingsPath ? `配置：${boot.meta.settingsPath}` : '';
    if (!boot.meta?.noticeAcknowledged) $('notice').classList.remove('hidden');
    if (!targetsBuilt) buildTargetOptions();
    renderHotkeys(settings, hotkeyReport);
    renderPresets(settings);
    renderCustomRoutes(settings);
    renderSeedHistory(settings.seed.history ?? []);
  }

  /**
   * v0.3.0：种子历史列表。点击条目 = 切到那个种子重新出图
   * （通过 intent:setSeed 走完整链路，含历史记录）。
   */
  function renderSeedHistory(history) {
    const list = $('seedHistory');
    if (!list) return;
    list.innerHTML = '';
    if (!Array.isArray(history) || history.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = '还没有历史记录。每局成功算出布局后会自动记在这里（最多 20 条）。';
      list.appendChild(empty);
      return;
    }
    const srcLabel = { log: '日志', 'prev-log': '上局日志', manual: '手动', cli: 'CLI', test: '测试' };
    for (const entry of history) {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.title = '点击用这个种子重新出图';
      item.innerHTML = `<span class="seed">${escapeHtml(String(entry.seed))}</span>`
        + `<span class="src">${escapeHtml(srcLabel[entry.source] ?? entry.source ?? '—')}</span>`
        + `<span class="srv">${escapeHtml(entry.server ?? '')}</span>`
        + `<span class="at">${escapeHtml(formatHistoryTime(entry.at))}</span>`;
      item.addEventListener('click', async () => {
        await api.intent.setSeed(entry.seed);
        const r = await api.app.status();
        boot = { ...boot, ...r };
        applyStatus(r);
      });
      list.appendChild(item);
    }
  }

  function formatHistoryTime(at) {
    if (!at) return '—';
    const d = new Date(at);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function bind() {
    $('autoStart').addEventListener('change', (e) => api.app.setAutoStart(e.target.checked).then(applySettings));
    $('visibleOnStart').addEventListener('change', (e) => api.settings.set({ overlay: { visibleOnStart: e.target.checked } }).then((r) => applySettings(r.settings)));
    $('logPath').addEventListener('change', (e) => api.settings.set({ seed: { logPath: e.target.value.trim() || null } }).then((r) => { applySettings(r.settings); applyStatus(r); }));
    $('auto-log').addEventListener('click', () => api.settings.set({ seed: { logPath: null } }).then((r) => { applySettings(r.settings); applyStatus(r); }));
    $('pick-log').addEventListener('click', async () => {
      const file = await api.app.pickLogFile();
      if (file) {
        const r = await api.settings.set({ seed: { logPath: file } });
        applySettings(r.settings);
        applyStatus(r);
      }
    });
    $('apply-seed').addEventListener('click', async () => {
      const value = Number($('manualSeed').value.trim());
      if (!Number.isInteger(value) || value < 1 || value > 2147483647) {
        $('manualSeed').value = '';
        $('manualSeed').placeholder = '种子必须是 1 – 2147483647 的整数';
        return;
      }
      const r = await api.intent.setSeed(value);
      applyStatus(r);
    });
    $('reread').addEventListener('click', () => api.intent.rereadSeed().then(applyStatus));
    $('logLevel').addEventListener('change', (e) => api.settings.set({ logLevel: e.target.value }).then((r) => applySettings(r.settings)));
    $('open-logs').addEventListener('click', () => api.intent.openLogFolder());
    $('opacity').addEventListener('input', (e) => {
      $('opacityValue').textContent = Number(e.target.value).toFixed(2);
      api.intent.setOverlay({ opacity: Number(e.target.value) });
    });
    $('scaleIndex').addEventListener('input', (e) => {
      const steps = boot?.meta?.scaleSteps ?? [0.8, 1, 1.3, 1.6];
      $('scaleValue').textContent = `${Number(steps[e.target.value] ?? 1).toFixed(2)}×`;
      api.intent.setScaleIndex(Number(e.target.value));
    });
    $('autoFit').addEventListener('change', (e) => api.intent.setOverlay({ autoFit: e.target.checked }));
    $('showLabels').addEventListener('change', (e) => api.intent.setOverlay({ showLabels: e.target.checked }));
    $('colorByCategory').addEventListener('change', (e) => api.intent.setOverlay({ colorByCategory: e.target.checked }));
    $('showSurfaceBand').addEventListener('change', (e) => api.intent.setOverlay({ showSurfaceBand: e.target.checked }));
    $('smartVisibility').addEventListener('change', (e) => api.intent.setOverlay({ smartVisibility: e.target.checked }));
    $('displayMode').addEventListener('change', (e) => {
      api.intent.setOverlay({ display: e.target.value }).then((r) => applySettings(r.settings));
    });
    $('export-png').addEventListener('click', async () => {
      // 画布在 overlay 窗口里：经主进程转告它合成（与 Ctrl+6 完全同一条路径）。
      // 覆盖层隐藏时先点亮，让用户看见导出的就是当前这张图。
      $('export-png').disabled = true;
      try {
        await api.intent.setOverlay({ toggleVisible: true });
        const result = await api.intent.exportPng();
        if (result?.ok) {
          const r = await api.app.status();
          boot = { ...boot, ...r };
          applyStatus(r);
        }
      } finally {
        $('export-png').disabled = false;
      }
    });
    $('clear-history').addEventListener('click', async () => {
      const r = await api.settings.set({ seed: { history: [] } });
      applySettings(r.settings);
    });
    $('cr-add').addEventListener('click', addRoute);
    $('reset-anchor').addEventListener('click', () => api.intent.setOverlay({ anchor: { x: 0.5, y: 0.62 } }).then((r) => applySettings(r.settings)));
    $('toggle-overlay').addEventListener('click', () => api.intent.setOverlay({ toggleVisible: true }));
    $('ack-notice').addEventListener('click', async () => {
      await api.settings.set({ noticeAcknowledged: true });
      $('notice').classList.add('hidden');
    });
    $('recheck').addEventListener('click', async () => {
      const r = await api.app.status();
      boot = { ...boot, ...r };
      applyStatus(r);
    });
    $('verify').addEventListener('click', async () => {
      $('verifyOut').textContent = '正在跑对拍（需要 test/fixtures 下的 SCPSL_Template_export snapshot）…';
      const r = await api.intent.verifyRun(null);
      $('verifyOut').textContent = typeof r === 'string' ? r : JSON.stringify(r, null, 2);
    });
    $('open-readme').addEventListener('click', () => api.intent.openExternal('README.md'));
    $('quit').addEventListener('click', () => api.app.quit());

    api.onStatus((payload) => { if (payload?.status) applyStatus(payload); boot = { ...boot, ...payload }; });
    api.onSeed(() => api.app.status().then((r) => { boot = { ...boot, ...r }; applyStatus(r); }));
    api.onError((payload) => {
      $('verifyOut').textContent = `[${payload.code}] ${payload.message}\n${payload.detail ?? ''}`;
    });
  }

  (async function start() {
    if (!api) {
      document.body.innerHTML = '<p style="padding:20px">preload 未加载</p>';
      return;
    }
    boot = await api.app.status();
    $('compliance').textContent = boot.meta?.complianceText ?? '';
    applySettings(boot.settings);
    applyStatus(boot);
    bind();
    // 首屏永远停在最上面（首次运行的必读提示在顶部，别让用户以为没有）
    window.scrollTo(0, 0);
    api.onHotkeyConflict((report) => {
      hotkeyReport = report;
      if (settingsCache) renderHotkeys(settingsCache, hotkeyReport);
    });
  })();
})();
