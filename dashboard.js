/**
 * SessionPort — dashboard.js (refactored)
 * Зависимости: db.js, shared-utils.js (PR_Utils), map-renderer.js (PR_MapRenderer)
 */

let allSnapshots  = [];
let activeId      = null;
let diffMode      = false;
let diffSelected  = [];
let currentFilter = 'all';
let _mapRenderer  = null;

async function init() {
  await PR_i18n.ready;
  PR_i18n.applyI18n();
  await SessionPortDB.migrateFromFlowState();
  activeId     = await SessionPortDB.getActive();
  allSnapshots = await SessionPortDB.listAll({ limit: 0 });
  renderFilters();
  renderCards();
  switchTab('map');
  PR_Utils.loadTheme(light => {
    document.body.classList.toggle('light', light);
    const thumb  = document.getElementById('themeThumb');
    const toggle = document.getElementById('themeToggle');
    if (toggle) toggle.style.background = light ? '#aaff00' : '#334155';
    if (thumb)  { thumb.style.left = light ? '15px' : '2px'; thumb.style.background = light ? '#fff' : '#94a3b8'; }
  });
}

function renderFilters() {
  const hosts     = [...new Set(allSnapshots.map(s => s.source_host).filter(Boolean))];
  const container = document.getElementById('filters');
  if (!container) return;
  container.innerHTML = `<button class="filter-btn active" data-host="all">${PR_i18n.t('hist.filter_all')}</button>` +
    hosts.map(h => `<button class="filter-btn" data-host="${PR_Utils.esc(h)}">${PR_Utils.esc(h)}</button>`).join('');
}

function setFilter(host, btn) {
  currentFilter = host;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn?.classList.add('active');
  renderCards();
}

function renderCards() {
  const filtered = currentFilter === 'all'
    ? allSnapshots : allSnapshots.filter(s => s.source_host === currentFilter);

  const badge = document.getElementById('countBadge');
  if (badge) badge.textContent = filtered.length + ' ' + PR_i18n.pluralSnap(filtered.length);

  const grid = document.getElementById('cardsGrid');
  if (!grid) return;
  if (!filtered.length) { grid.innerHTML = `<div class="empty">${PR_i18n.t('hist.empty')}</div>`; return; }

  grid.innerHTML = filtered.map(s => {
    const isHead = s.snapshot_id === activeId;
    const date   = PR_Utils.fmtDate(s.created_at);
    const sizeKb = (s.size_bytes / 1024).toFixed(1);
    const target = s.target_host ? `<span class="sep">→</span><span>${PR_Utils.esc(s.target_host || "")}</span>` : '';
    const diffBtn = diffMode
      ? `<button class="btn-sm diff-pick" data-id="${s.snapshot_id}">${PR_i18n.t('hist.diff_select')}</button>`
      : `<button class="btn-sm btn-diff">${PR_i18n.t('dash.diff')}</button>`;
    return `<div class="snap-card${isHead ? ' is-head' : ''}" data-id="${s.snapshot_id}">
      <div class="card-top">${isHead ? '<span class="badge-head">HEAD</span>' : ''}<span class="card-date">${date}</span></div>
      <div class="card-project" title="${PR_Utils.esc(s.project || "")}">${PR_Utils.esc(s.project || "")}</div>
      <div class="card-meta"><span>${PR_Utils.esc(s.source_host || "")}</span>${target}<span class="sep">·</span><span>${sizeKb} KB</span></div>
      <div class="card-actions">
        <button class="btn-load">${PR_i18n.t('dash.load')}</button>${diffBtn}<button class="btn-sm btn-fork">${PR_i18n.t('dash.fork')}</button>
      </div></div>`;
  }).join('');
}

async function loadSnapshot(id) {
  const snap = await SessionPortDB.getSnapshot(id);
  if (!snap) return;
  await new Promise(res => chrome.storage.local.set({ flow_state: PR_Utils.snapToFlowState(snap) }, res));
  await SessionPortDB.setActive(id);
  activeId = id; renderCards(); window.close();
}

function startDiff(id) {
  diffMode = true; diffSelected = [id];
  document.getElementById('diffPanel')?.classList.add('open');
  const t = document.getElementById('diffTitle');
  const c = document.getElementById('diffContent');
  if (t) t.textContent = PR_i18n.t('hist.diff_select');
  if (c) c.innerHTML = `<div class="diff-empty">${PR_i18n.t('hist.select_diff')}</div>`;
  renderCards();
}

async function pickDiff(id) {
  if (diffSelected[0] === id) return;
  diffSelected[1] = id; diffMode = false; renderCards();
  await runDiff(diffSelected[0], diffSelected[1]);
}

async function runDiff(idA, idB) {
  document.getElementById('diffPanel')?.classList.add('open');
  const content = document.getElementById('diffContent');
  if (content) content.innerHTML = '<div class="diff-empty">…</div>';
  const result = await SessionPortDB.diff(idA, idB);
  if (!result) { if (content) content.innerHTML = '<div class="diff-empty">⚠</div>'; return; }
  const t = document.getElementById('diffTitle');
  if (t) t.textContent = `Diff · ${result.summary}`;
  if (!result.added.length && !result.removed.length && !result.changed.length) {
    if (content) content.innerHTML = `<div class="diff-empty">${PR_i18n.t('hist.diff_identical')}</div>`; return;
  }
  const { esc } = PR_Utils;
  const rows = [
    ...result.added.map(x   => `<div class="diff-row"><span class="diff-sign add">+</span><span class="diff-text">${esc(x)}</span></div>`),
    ...result.removed.map(x => `<div class="diff-row"><span class="diff-sign rem">−</span><span class="diff-text">${esc(x)}</span></div>`),
    ...result.changed.map(ch => `<div class="diff-row"><span class="diff-sign chg">~</span><span class="diff-text"><b>${esc(ch.key)}</b>: ${esc(String(ch.to))}</span></div>`)
  ];
  if (content) content.innerHTML = rows.join('');
}

function closeDiff() {
  diffMode = false; diffSelected = [];
  document.getElementById('diffPanel')?.classList.remove('open');
  renderCards();
}

async function forkSnapshot(id) {
  PR_Utils.customPrompt(PR_i18n.t('hist.fork_prompt'), async name => {
    if (!name) return;
    await SessionPortDB.fork(id, name.trim());
    activeId = id; renderCards();
  });
}

async function doExportAll() {
  const json = await SessionPortDB.exportAll();
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `SessionPort_export_${Date.now()}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

function toggleTheme() {
  const light = !document.body.classList.contains('light');
  document.body.classList.toggle('light', light);
  PR_Utils.saveTheme(light);
  // Update toggle thumb
  const thumb = document.getElementById('themeThumb');
  const toggle = document.getElementById('themeToggle');
  if (toggle) toggle.style.background = light ? '#aaff00' : '#334155';
  if (thumb)  { thumb.style.left = light ? '15px' : '2px'; thumb.style.background = light ? '#fff' : '#94a3b8'; }
}

chrome.storage.onChanged.addListener(changes => {
  if (changes.pr_theme) {
    const light = changes.pr_theme.newValue === 'light';
    document.body.classList.toggle('light', light);
    const thumb  = document.getElementById('themeThumb');
    const toggle = document.getElementById('themeToggle');
    if (toggle) toggle.style.background = light ? '#aaff00' : '#334155';
    if (thumb)  { thumb.style.left = light ? '15px' : '2px'; thumb.style.background = light ? '#fff' : '#94a3b8'; }
  }
});

// ── Tab switching ──────────────────────────────────────────
function switchTab(tab) {
  const histPanel = document.getElementById('snapList');
  const mapPanel  = document.getElementById('mapPanel');
  const tH = document.getElementById('dashTabHistory');
  const tM = document.getElementById('dashTabMap');
  if (tab === 'history') {
    if (histPanel) histPanel.style.display = '';
    if (mapPanel)  mapPanel.style.display  = 'none';
    if (tH) { tH.className = 'dash-tab active-hist'; }
    if (tM) { tM.className = 'dash-tab'; }
  } else {
    if (histPanel) histPanel.style.display = 'none';
    if (mapPanel)  mapPanel.style.display  = 'flex';
    if (tH) { tH.className = 'dash-tab'; }
    if (tM) { tM.className = 'dash-tab active-map'; }
    _initMap();
  }
}

// ── Map tab — PR_MapRenderer ───────────────────────────────
async function _initMap() {
  const canvas  = document.getElementById('mapCanvas');
  const svgEl   = document.getElementById('mapSvg');
  const emptyEl = document.getElementById('mapEmpty');
  if (!canvas || !svgEl) return;
  const _DMAP_FIELDS = ['snapshot_id','parent_id','project','created_at',
    'source_host','target_host','size_bytes','transfer_id','parent_transfer_id'];
  const snaps = await SessionPortDB.listAll({ limit: 0, fields: _DMAP_FIELDS });
  const aid   = await SessionPortDB.getActive();
  const { pr_manual_links: manualLinks = [] } = await new Promise(r =>
    chrome.storage.local.get('pr_manual_links', r));
  if (!_mapRenderer) {
    _mapRenderer = new PR_MapRenderer(canvas, svgEl, { emptyEl, initX: 40, initY: 30 });
    _mapRenderer.onNodeClick = snap => _showMapNodeInfo(snap);
  }
  _mapRenderer.draw(snaps, aid, manualLinks);
  _buildMapProjSel(snaps);
}

// ── Map node info panel ─────────────────────────────────────
function _showMapNodeInfo(snap) {
  const panel = document.getElementById('dashMapNodeInfo');
  if (!panel) return;
  document.getElementById('dashMapInfoProj').textContent = snap.project || '';
  document.getElementById('dashMapInfoDate').textContent = PR_Utils.fmtDate(snap.created_at || '');
  const kb = ((snap.size_bytes || 0) / 1024).toFixed(1);
  const src = snap.source_host || '';
  const tgt = snap.target_host ? ' → ' + snap.target_host : '';
  const metaEl = document.getElementById('dashMapInfoMeta');
  const baseMeta = src + tgt + ' · ' + kb + ' KB';
  if (metaEl) metaEl.textContent = baseMeta;
  panel.classList.add('visible');
  if (snap.snapshot_id) {
    chrome.runtime.sendMessage({ action: 'LIST_FILES', snapshot_id: snap.snapshot_id }, resp => {
      if (chrome.runtime.lastError || !metaEl) return;
      const n = (resp?.files || []).length;
      if (n > 0) metaEl.textContent = baseMeta + ' · 📎 ' + n;
    });
  }
  const oldBtn = document.getElementById('dashMapInfoLoad');
  if (oldBtn) {
    const btn = oldBtn.cloneNode(true);
    oldBtn.replaceWith(btn);
    btn.id = 'dashMapInfoLoad';
    btn.addEventListener('click', () => _loadFromMap(snap));
  }
}

// ── Link mode ───────────────────────────────────────────────
let _dashLinkMode   = false;
let _dashLinkFromId = null;

function _dashSetLinkHint(text) {
  const el = document.getElementById('dashMapLinkHint');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('visible', !!text);
}

function _dashExitLinkMode() {
  _dashLinkMode   = false;
  _dashLinkFromId = null;
  document.getElementById('dashMapBtnLink')?.classList.remove('link-active');
  _dashSetLinkHint('');
  if (_mapRenderer && _mapRenderer._prevOnNodeClick !== undefined) {
    _mapRenderer.onNodeClick = _mapRenderer._prevOnNodeClick;
    delete _mapRenderer._prevOnNodeClick;
  }
  if (document._dashLinkEscHandler) {
    document.removeEventListener('keydown', document._dashLinkEscHandler);
    delete document._dashLinkEscHandler;
  }
}

async function _dashCompleteLinkMode(fromId, toId) {
  _dashExitLinkMode();
  const comment = (window.prompt(PR_i18n.t('map.link_comment')) || '').trim();
  const link = { from_id: fromId, to_id: toId, comment, created_at: new Date().toISOString() };
  const { pr_manual_links: existing = [] } = await new Promise(r =>
    chrome.storage.local.get('pr_manual_links', r));
  existing.push(link);
  await new Promise(r => chrome.storage.local.set({ pr_manual_links: existing }, r));
  _initMap();
}

function _dashEnterLinkMode(fromId) {
  _dashLinkMode = true;
  document.getElementById('dashMapBtnLink').classList.add('link-active');
  document._dashLinkEscHandler = e => { if (e.key === 'Escape') _dashExitLinkMode(); };
  document.addEventListener('keydown', document._dashLinkEscHandler);
  _mapRenderer._prevOnNodeClick = _mapRenderer.onNodeClick;
  if (fromId) {
    _dashLinkFromId = fromId;
    _dashSetLinkHint(PR_i18n.t('map.link_hint3'));
    _mapRenderer.onNodeClick = snap => {
      if (snap.snapshot_id === _dashLinkFromId) return;
      _dashCompleteLinkMode(_dashLinkFromId, snap.snapshot_id);
    };
  } else {
    _dashSetLinkHint(PR_i18n.t('map.link_hint1'));
    _mapRenderer.onNodeClick = snap => {
      _dashLinkFromId = snap.snapshot_id;
      _mapRenderer.selectNode(_dashLinkFromId);
      _dashSetLinkHint(PR_i18n.t('map.link_hint2'));
      _mapRenderer.onNodeClick = snap2 => {
        if (snap2.snapshot_id === _dashLinkFromId) return;
        _dashCompleteLinkMode(_dashLinkFromId, snap2.snapshot_id);
      };
    };
  }
}

function _buildMapProjSel(snaps) {
  const sel = document.getElementById('mapProjSel');
  if (!sel) return;
  const projs = [...new Set(snaps.map(s => s.project).filter(Boolean))];
  const cur   = _mapRenderer?.filter;
  sel.innerHTML = `<button class="filter-btn${!cur ? ' active' : ''}" data-proj="">${PR_i18n.t('map.all')}</button>` +
    projs.map(p => `<button class="filter-btn${cur===p?' active':''}" data-proj="${p.replace(/"/g,'&quot;')}">${p.length>20?p.slice(0,20)+'…':p}</button>`).join('');
}

async function _loadFromMap(snap) {
  // snap may be projected (no payload) — load full snapshot
  let fullSnap = snap;
  if (!snap.payload && snap.snapshot_id) {
    fullSnap = await SessionPortDB.getSnapshot(snap.snapshot_id);
    if (!fullSnap) return;
  }
  await new Promise(res => chrome.storage.local.set({ flow_state: PR_Utils.snapToFlowState(fullSnap) }, res));
  await SessionPortDB.setActive(fullSnap.snapshot_id);
  if (_mapRenderer) { _mapRenderer.activeId = fullSnap.snapshot_id; _mapRenderer._render(); }
  // FIX: no alert() — use chrome.notifications for non-blocking feedback
  chrome.notifications.create({
    type: 'basic', iconUrl: 'icons/icon48.png',
    title: 'SessionPort',
    message: `Snapshot "${snap.project || 'unknown'}" loaded. Open the extension and click Paste.`
  });
}

// ── Event bindings ─────────────────────────────────────────
document.getElementById('dashBack')?.addEventListener('click',       e => { e.preventDefault(); window.close(); });
document.getElementById('dashLogo')?.addEventListener('click',       () => window.close());
document.getElementById('dashTabHistory')?.addEventListener('click', () => switchTab('history'));
document.getElementById('dashTabMap')?.addEventListener('click',     () => switchTab('map'));
document.getElementById('themeToggle')?.addEventListener('click',    toggleTheme);
document.getElementById('diffCloseBtn')?.addEventListener('click',   closeDiff);
document.getElementById('btnExportAll')?.addEventListener('click',   doExportAll);
document.getElementById('mapZoomIn')?.addEventListener('click',      () => _mapRenderer?.zoom(1.2));
document.getElementById('mapZoomOut')?.addEventListener('click',     () => _mapRenderer?.zoom(0.8));
document.getElementById('mapZoomReset')?.addEventListener('click',   () => _mapRenderer?.reset(40, 30));

document.getElementById('filters')?.addEventListener('click', e => {
  const btn = e.target.closest('.filter-btn');
  if (btn) setFilter(btn.dataset.host, btn);
});
document.getElementById('cardsGrid')?.addEventListener('click', e => {
  const card = e.target.closest('.snap-card');
  if (!card) return;
  const id = card.dataset.id;
  if (e.target.closest('.btn-load'))  loadSnapshot(id);
  if (e.target.closest('.btn-diff'))  startDiff(id);
  if (e.target.closest('.diff-pick')) pickDiff(id);
  if (e.target.closest('.btn-fork'))  forkSnapshot(id);
});
document.getElementById('mapProjSel')?.addEventListener('click', e => {
  const btn = e.target.closest('[data-proj]');
  if (!btn || !_mapRenderer) return;
  _mapRenderer.setFilter(btn.dataset.proj || null);
  _buildMapProjSel(_mapRenderer.snaps || []);
});
document.getElementById('dashMapBtnLink')?.addEventListener('click', () => {
  if (_dashLinkMode) { _dashExitLinkMode(); return; }
  if (!_mapRenderer) return;
  _dashEnterLinkMode(_mapRenderer.selectedId || null);
});

init();
