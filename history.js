/**
 * SessionPort — history.js
 * История снапшотов внутри popup: cards, diff, linked pairs, filters, export.
 * Зависимости: popup-utils.js, projects.js (currentProject), db.js, shared-utils.js
 */

// ── State ─────────────────────────────────────────────────
let diffMode    = false;
let diffFirstId = null;
let histFilter     = 'all';
let histSearch     = '';
let histProjFilter = '';

function _syncProjectBarToSnap(snap) {
  if (!snap?.project) return;
  if (typeof currentProject !== 'undefined') currentProject = snap.project;
  const nameEl = document.getElementById('projName');
  if (nameEl) nameEl.textContent = snap.project.length > 28
    ? snap.project.slice(0, 28) + '…'
    : snap.project;
  if (typeof renderProjectDropdown === 'function') renderProjectDropdown();
}

function _snapDesc(s) {
  if (!s.payload) return '';
  try {
    const d = JSON.parse(PR_Utils.base64ToUtf8(s.payload));
    const text = d?.dna?.goal || d?.state?.current_task || '';
    return text.length > 90 ? text.slice(0, 90) + '…' : text;
  } catch { return ''; }
}

// ── Render main history screen ────────────────────────────
async function renderHistoryScreen() {
  const list     = document.getElementById('histList');
  const badge    = document.getElementById('histBadge');
  const diffArea = document.getElementById('diffArea');
  if (!list) return;

  const activeId = await SessionPortDB.getActive();
  const _HIST_FIELDS = ['snapshot_id','created_at','size_bytes','target_host','source_host',
    'project','parent_id','parent_transfer_id','transfer_id','payload'];
  let snapshots  = await SessionPortDB.listAll({ limit: 0, fields: _HIST_FIELDS });
  snapshots.sort((a, b) => b.created_at.localeCompare(a.created_at));

  // Populate project dropdown (preserve selection)
  const projDrop = document.getElementById('histProjDropdown');
  if (projDrop) {
    const projs = [...new Set(snapshots.map(s => s.project).filter(Boolean))].sort();
    projDrop.innerHTML = `<option value="">${PR_i18n.t('hist.all_projects')}</option>` +
      projs.map(p => `<option value="${PR_Utils.esc(p)}"${histProjFilter===p?' selected':''}>${PR_Utils.esc(p)}</option>`).join('');
  }

  if (histProjFilter) {
    snapshots = snapshots.filter(s => s.project === histProjFilter);
  } else if (histFilter === 'linked') {
    // Bug-10: reuse already-fetched snapshots — no second listAll
    const snapMap = new Map(snapshots.map(s => [s.snapshot_id, s]));
    // v1.2.38: build transfer_id index for cross-device chain resolution
    const byTransferId = new Map(snapshots.filter(s => s.transfer_id).map(s => [s.transfer_id, s]));
    const linkedIds = new Set();
    snapshots.forEach(s => {
      // Legacy: parent_id cross-project link (local DB chain)
      if (s.parent_id) {
        const parent = snapMap.get(s.parent_id);
        if (parent && parent.project !== s.project) {
          linkedIds.add(s.snapshot_id);
          linkedIds.add(s.parent_id);
        }
      }
      // v1.2.38: parent_transfer_id cross-device/cross-platform link
      if (s.parent_transfer_id) {
        const parent = byTransferId.get(s.parent_transfer_id);
        if (parent) {
          if (parent.project !== s.project) {
            linkedIds.add(s.snapshot_id);
            linkedIds.add(parent.snapshot_id);
          }
        } else {
          linkedIds.add(s.snapshot_id); // parent from another device — include by default
        }
      }
    });
    snapshots = snapshots.filter(s => linkedIds.has(s.snapshot_id));
  }

  if (histSearch) {
    const q = histSearch.toLowerCase();
    snapshots = snapshots.filter(s =>
      (s.project     || '').toLowerCase().includes(q) ||
      (s.source_host || '').toLowerCase().includes(q) ||
      (s.target_host || '').toLowerCase().includes(q)
    );
  }

  if (badge) badge.textContent = snapshots.length + ' ' + PR_Utils.pluralSnap(snapshots.length);

  if (!snapshots.length) {
    list.innerHTML = `<div class="hist-empty">${PR_i18n.t('hist.empty')}</div>`;
    return;
  }

  list.innerHTML = snapshots.map(s => {
    const isHead = s.snapshot_id === activeId;
    const date   = PR_Utils.fmtDate(s.created_at);
    const kb     = (s.size_bytes / 1024).toFixed(1);
    const target = s.target_host
      ? `<span class="hist-sep">→</span><span>${PR_Utils.esc(s.target_host || "")}</span>` : '';
    const diffBtnClass = diffMode && diffFirstId && diffFirstId !== s.snapshot_id
      ? 'btn-hsm diff-active' : 'btn-hsm';
    const diffBtnText  = diffMode && diffFirstId === s.snapshot_id ? '…' : 'Diff';
    const desc = _snapDesc(s);

    return `<div class="hist-card${isHead ? ' is-head' : ''}" data-id="${s.snapshot_id}">
      <div class="hist-card-top">
        ${isHead ? '<span class="hist-head-badge">HEAD</span>' : ''}
        <span class="hist-date">${date}</span>
        <div class="hist-card-top-actions">
          <button class="${diffBtnClass}" data-diff="${s.snapshot_id}">${diffBtnText}</button>
          <button class="btn-hsm" data-fork="${s.snapshot_id}">${PR_i18n.t('hist.branch')}</button>
          <button class="hist-delete-btn" data-soft-delete="${s.snapshot_id}" title="${PR_i18n.t('trash.delete')}">🗑</button>
        </div>
      </div>
      <div class="hist-project" title="${PR_Utils.esc(s.project || "")}">${PR_Utils.esc(s.project || "")}</div>
      ${desc ? `<div class="hist-desc">${PR_Utils.esc(desc)}</div>` : ''}
      <div class="hist-meta">
        <span>${PR_Utils.esc(s.source_host || "")}</span>${target}
        <span class="hist-sep">·</span><span>${kb} KB</span>
      </div>
      <div class="hist-files" data-files-for="${s.snapshot_id}">
        <div class="hist-files-header">
          <span class="hist-files-label">📎 <span class="hist-files-count">…</span></span>
        </div>
        <div class="hist-files-list"></div>
        <div class="hist-card-dropzone" data-snap="${s.snapshot_id}">${PR_i18n.t('hist.card_drop', { id: s.snapshot_id })}</div>
      </div>
      <div class="hist-paste-row">
        <button class="hist-paste-btn primary" data-paste-with-files="${s.snapshot_id}">${PR_i18n.t('hist.card_load')}</button>
        <button class="hist-paste-btn" data-paste-only="${s.snapshot_id}">${PR_i18n.t('hist.card_ctx_only')}</button>
      </div>
    </div>`;
  }).join('');

  // Загружаем файлы карточек с небольшой задержкой между запросами,
  // чтобы не перегружать chrome.runtime.sendMessage при большом числе снапшотов
  snapshots.forEach((s, i) => setTimeout(() => loadHistCardFiles(s.snapshot_id), i * 30));
  _attachHistCardHandlers();
}

// ── Diff helpers ──────────────────────────────────────────
function closeDiffMode() {
  diffMode = false; diffFirstId = null;
  const diffArea = document.getElementById('diffArea');
  if (diffArea) { diffArea.style.display = 'none'; diffArea.innerHTML = ''; }
  renderHistoryScreen();
}

function showDiffResult(result) {
  const diffArea = document.getElementById('diffArea');
  if (!diffArea || !result) return;
  diffArea.style.display = 'block';
  const { esc } = PR_Utils;

  if (!result.added.length && !result.removed.length && !result.changed.length) {
    diffArea.innerHTML = `<div class="diff-panel"><div class="diff-panel-header">
      <span>${PR_i18n.t('hist.diff_identical')}</span>
      <button class="diff-close-btn" id="btnDiffCloseId">✕</button></div></div>`;
    document.getElementById('btnDiffCloseId')?.addEventListener('click', closeDiffMode);
    return;
  }

  const rows = [
    ...result.added.map(t =>   `<div class="diff-row"><span class="diff-badge add">+</span><span class="diff-txt">${esc(t)}</span></div>`),
    ...result.removed.map(t => `<div class="diff-row"><span class="diff-badge rem">−</span><span class="diff-txt">${esc(t)}</span></div>`),
    ...result.changed.map(ch => `<div class="diff-row"><span class="diff-badge chg">~</span><span class="diff-txt"><b>${esc(ch.key)}</b>: ${esc(String(ch.to))}</span></div>`)
  ];
  diffArea.innerHTML = `<div class="diff-panel">
    <div class="diff-panel-header"><span>Diff · ${result.summary}</span>
      <button class="diff-close-btn" id="btnDiffClose2">✕</button></div>
    <div class="diff-legend">
      <span class="diff-badge add">${PR_i18n.t('hist.diff_added')}</span>
      <span class="diff-badge rem">${PR_i18n.t('hist.diff_removed')}</span>
      <span class="diff-badge chg">${PR_i18n.t('hist.diff_changed')}</span>
    </div>
    ${rows.join('')}
  </div>`;
  document.getElementById('btnDiffClose2')?.addEventListener('click', closeDiffMode);
}

// ── History tab switch — inline tabs (не переход на другой screen) ──
let _histActiveTab = 'history';
let _hmapRenderer  = null;

function switchHistTab(tab) {
  _histActiveTab = tab;
  const histPanel = document.getElementById('histPanel');
  const mapPanel  = document.getElementById('histMapPanel');
  const tH = document.getElementById('htabHistory');
  const tM = document.getElementById('htabMap');

  const typeFilters = document.getElementById('histTypeFilters');
  const searchRow   = document.getElementById('histSearchRow');
  if (tab === 'history') {
    if (histPanel)   histPanel.style.display   = '';
    if (mapPanel)    mapPanel.style.display    = 'none';
    if (typeFilters) typeFilters.style.display = '';
    if (searchRow)   searchRow.style.display   = '';
    tH?.classList.add('on');    tM?.classList.remove('on');
    renderHistoryScreen();
  } else {
    if (histPanel)   histPanel.style.display   = 'none';
    if (mapPanel)    mapPanel.style.display    = '';
    if (typeFilters) typeFilters.style.display = 'none';
    if (searchRow)   searchRow.style.display   = 'none';
    tM?.classList.add('on');    tH?.classList.remove('on');
    _initHistMap();
  }
}

async function _initHistMap() {
  const canvas  = document.getElementById('hmapCanvasEl');
  const svgEl   = document.getElementById('hmapSvgEl');
  const emptyEl = document.getElementById('hmapEmptyEl');
  if (!canvas || !svgEl) return;

  const _HMAP_FIELDS = ['snapshot_id','parent_id','project','created_at',
    'source_host','target_host','size_bytes','transfer_id','parent_transfer_id'];
  const snaps = await SessionPortDB.listAll({ limit: 0, fields: _HMAP_FIELDS });
  const aid   = await SessionPortDB.getActive();

  if (!_hmapRenderer) {
    _hmapRenderer = new PR_MapRenderer(canvas, svgEl, { emptyEl, initX: 20, initY: 20 });
    _hmapRenderer.onNodeClick = snap => {
      // selectedId already set by renderer before this fires — just show info panel
      _showHmapNodeInfo(snap);
    };
  }
  _hmapRenderer.draw(snaps, aid);
  _buildHistMapProjSel(snaps);
}

function _buildHistMapProjSel(snaps) {
  const container = document.getElementById('hmapProjSel');
  if (!container) return;
  const projs = [...new Set(snaps.map(s => s.project).filter(Boolean))].sort();
  const cur   = _hmapRenderer?.filter || '';
  const sel   = document.createElement('select');
  sel.className = 'hist-proj-select';
  sel.style.width = '100%';
  sel.innerHTML = `<option value="">${PR_i18n.t('hist.all_projects')}</option>` +
    projs.map(p => `<option value="${PR_Utils.esc(p)}"${cur===p?' selected':''}>${PR_Utils.esc(p)}</option>`).join('');
  sel.addEventListener('change', () => {
    if (!_hmapRenderer) return;
    _hmapRenderer.setFilter(sel.value || null);
  });
  container.innerHTML = '';
  container.appendChild(sel);
}

function _showHmapNodeInfo(snap) {
  const panel = document.getElementById('hmapNodeInfo');
  if (!panel) return;

  document.getElementById('hmapInfoProj').textContent = snap.project || PR_i18n.t('hist.no_project');
  document.getElementById('hmapInfoDate').textContent = PR_Utils.fmtDate(snap.created_at || '');
  const kb = ((snap.size_bytes || 0) / 1024).toFixed(1);
  const src = snap.source_host || '';
  const tgt = snap.target_host ? ' → ' + snap.target_host : '';
  const hmapMetaEl = document.getElementById('hmapInfoMeta');
  const hbaseMeta = src + tgt + ' · ' + kb + ' KB';
  if (hmapMetaEl) hmapMetaEl.textContent = hbaseMeta;
  panel.classList.add('visible');

  if (snap.snapshot_id) {
    chrome.runtime.sendMessage({ action: 'LIST_FILES', snapshot_id: snap.snapshot_id }, resp => {
      if (chrome.runtime.lastError || !hmapMetaEl) return;
      const n = (resp?.files || []).length;
      if (n > 0) hmapMetaEl.textContent = hbaseMeta + ' · 📎 ' + n;
    });
  }

  const oldBtn = document.getElementById('hmapInfoLoad');
  if (oldBtn) {
    const btn = oldBtn.cloneNode(true);
    oldBtn.replaceWith(btn);
    btn.id = 'hmapInfoLoad';
    btn.addEventListener('click', async () => {
      let fullSnap = snap;
      if (!snap.payload && snap.snapshot_id) {
        fullSnap = await SessionPortDB.getSnapshot(snap.snapshot_id);
        if (!fullSnap) return;
      }
      await new Promise(res => chrome.storage.local.set({
        flow_state: { ...PR_Utils.snapToFlowState(fullSnap), from_history: true }
      }, res));
      await SessionPortDB.setActive(fullSnap.snapshot_id);
      if (_hmapRenderer) {
        _hmapRenderer.activeId = fullSnap.snapshot_id;
        _hmapRenderer._render();
      }
      panel.classList.remove('visible');
      showScreen('main');
      _syncProjectBarToSnap(fullSnap);
      showPastePanel('paste_msg.from_map');
      if (typeof _fillSnapCard === 'function') _fillSnapCard();
    });
  }
}

document.getElementById('histSearch')?.addEventListener('input', e => {
  histSearch = e.target.value;
  renderHistoryScreen();
});

document.getElementById('htabHistory')?.addEventListener('click', () => switchHistTab('history'));
document.getElementById('htabMap')?.addEventListener('click',     () => switchHistTab('map'));

// Inline map toolbar
document.getElementById('hmapZoomIn')?.addEventListener('click',    () => _hmapRenderer?.zoom(1.2));
document.getElementById('hmapZoomOut')?.addEventListener('click',   () => _hmapRenderer?.zoom(0.8));
document.getElementById('hmapZoomReset')?.addEventListener('click', () => _hmapRenderer?.reset(20, 20));
document.getElementById('hmapBtnBranch')?.addEventListener('click', () => {
  PR_Utils.customPrompt(PR_i18n.t('hist.fork_prompt'), async name => {
    if (!name?.trim()) return;
    const id = await SessionPortDB.getActive();
    if (!id) { setStatus(PR_i18n.t('hist.branch_no_snap'), 'error'); return; }
    await SessionPortDB.fork(id, name.trim());
    _initHistMap();
  });
});
document.getElementById('hmapBtnDashboard')?.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html#map') });
});

// ── Filter controls ───────────────────────────────────────
function setHistFilter(filter, btn) {
  histFilter = filter;
  histProjFilter = '';
  const drop = document.getElementById('histProjDropdown');
  if (drop) drop.value = '';
  document.querySelectorAll('.hist-filter').forEach(b => b.classList.remove('on'));
  btn?.classList.add('on');
  if (_histActiveTab === 'map') {
    _syncFilterToMap();
  } else {
    renderHistoryScreen();
  }
}

document.getElementById('hfAll')?.addEventListener('click',    function() { setHistFilter('all', this); });
document.getElementById('hfLinked')?.addEventListener('click', function() { setHistFilter('linked', this); });

document.getElementById('histProjDropdown')?.addEventListener('change', function() {
  histProjFilter = this.value;
  histFilter = 'all';
  document.querySelectorAll('.hist-filter').forEach(b => b.classList.remove('on'));
  document.getElementById('hfAll')?.classList.add('on');
  renderHistoryScreen();
});

// Sync filters to mind map when in map tab
function _syncFilterToMap() {
  if (!_hmapRenderer || _histActiveTab !== 'map') return;
  _buildHistMapProjSel(_hmapRenderer.snaps || []);
}

// ── Counters ──────────────────────────────────────────────
async function refreshHistoryCounters() {
  try {
    const snaps    = await SessionPortDB.listAll({ limit: 0, fields: ['snapshot_id'] });
    const histCount = document.getElementById('histCount');
    const histBadge = document.getElementById('histBadge');
    if (histCount) histCount.textContent = snaps.length;
    if (histBadge) histBadge.textContent = snaps.length + ' ' + PR_Utils.pluralSnap(snaps.length);
  } catch (_) {}
}

// ── Export ────────────────────────────────────────────────
// Handler registered in settings.js (_openExportModal) after it's defined

document.getElementById('btnHistImport')?.addEventListener('click', () => {
  document.getElementById('importFileInput')?.click();
});

document.getElementById('importFileInput')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const btn = document.getElementById('btnHistImport');
  const orig = btn?.textContent;
  if (btn) btn.textContent = '…';
  try {
    const text = await file.text();
    await SessionPortDB.importAll(text);
    chrome.storage.local.set({ snapshot_added_at: Date.now() });
    await renderHistoryScreen();
    if (typeof refreshHistoryCounters === 'function') refreshHistoryCounters();
    setStatus(PR_i18n.t('status.import_ok'), 'active');
  } catch (err) {
    console.error('[PR] import error:', err);
    setStatus(PR_i18n.t('status.import_err') + err.message, 'error');
  } finally {
    if (btn) btn.textContent = orig;
    e.target.value = ''; // reset для повторного выбора того же файла
  }
});

// ── Navigation ────────────────────────────────────────────
// Nav handlers registered in popup-shell.js — not duplicated here

// ── Internal: hist card handlers — event delegation (FIX: no per-element binding leak) ──
let _histListDelegated = false;

function _attachHistCardHandlers() {
  const list = document.getElementById('histList');
  if (!list || _histListDelegated) return;
  _histListDelegated = true;

  // Drag over / leave for dropzones
  list.addEventListener('dragenter', e => {
    const dz = e.target.closest('.hist-card-dropzone');
    if (dz) { e.preventDefault(); e.stopPropagation(); dz.classList.add('drag-over'); }
  });
  list.addEventListener('dragover', e => {
    const dz = e.target.closest('.hist-card-dropzone');
    if (dz) { e.preventDefault(); e.stopPropagation(); }
  });
  list.addEventListener('dragleave', e => {
    const dz = e.target.closest('.hist-card-dropzone');
    if (dz) { e.preventDefault(); e.stopPropagation(); dz.classList.remove('drag-over'); }
  });

  // Drop on hist card dropzone
  list.addEventListener('drop', async e => {
    const dz = e.target.closest('.hist-card-dropzone');
    if (!dz) return;
    e.preventDefault(); e.stopPropagation();
    dz.classList.remove('drag-over');
    const snapId = dz.dataset.snap;

    let files = Array.from(e.dataTransfer.files || []);
    if (!files.length && e.dataTransfer.items)
      for (const item of e.dataTransfer.items)
        if (item.kind === 'file') { const f = item.getAsFile(); if (f) files.push(f); }

    if (!files.length) {
      const origHTML = dz.innerHTML;
      dz.textContent = PR_i18n.t('hist.not_file');
      setTimeout(() => { dz.innerHTML = origHTML; }, 2500); return;
    }

    const MAX_FILE_BYTES = 25 * 1024 * 1024;
    const ORIG_HTML = () => PR_i18n.t('hist.card_drop', { id: snapId });
    dz.innerHTML = PR_i18n.t('hist.attaching');
    try {
      for (const file of files) {
        if (file.size > MAX_FILE_BYTES) {
          dz.textContent = PR_i18n.t('hist.too_big', { size: PR_Utils.fmtBytes(file.size) });
          setTimeout(() => { dz.innerHTML = ORIG_HTML(); }, 3000); continue;
        }
        try {
          const b64 = PR_Utils.arrayBufferToBase64(await file.arrayBuffer());
          const r = await Promise.race([
            new Promise(res => chrome.runtime.sendMessage({
              action: 'ATTACH_FILE', snapshot_id: snapId,
              filename: file.name, mime: file.type, size_bytes: file.size, content_b64: b64
            }, resp => { if (chrome.runtime.lastError) res({ success: false }); else res(resp); })),
            new Promise(res => setTimeout(() => res({ success: false, error: 'timeout' }), 30000))
          ]);
          if (!r?.success) console.warn('[PR-hist] attach failed:', file.name, r?.error);
        } catch (err) { console.error('[PR-hist] attach:', err); }
      }
    } finally {
      dz.innerHTML = ORIG_HTML();
      loadHistCardFiles(snapId);
      chrome.storage.local.set({ files_changed_at: Date.now() });
    }
  });

  // Click delegation: file-rm, paste-with-files, paste-only, load, diff, fork
  list.addEventListener('click', async e => {
    // UI-14: browse button inside hist-card-dropzone
    const browseSpan = e.target.closest('.hist-dz-browse');
    if (browseSpan) {
      e.stopPropagation();
      const snapId = browseSpan.dataset.snap;
      const input = document.createElement('input');
      input.type = 'file'; input.multiple = true;
      input.onchange = async () => {
        if (!input.files.length) return;
        const dz = list.querySelector(`.hist-card-dropzone[data-snap="${snapId}"]`);
        const ORIG_HTML = () => PR_i18n.t('hist.card_drop', { id: snapId });
        if (dz) dz.innerHTML = PR_i18n.t('hist.attaching');
        const MAX = 25 * 1024 * 1024;
        for (const file of input.files) {
          if (file.size > MAX) {
            if (dz) { dz.textContent = PR_i18n.t('hist.too_big', { size: PR_Utils.fmtBytes(file.size) }); setTimeout(() => { dz.innerHTML = ORIG_HTML(); }, 3000); }
            continue;
          }
          try {
            const b64 = PR_Utils.arrayBufferToBase64(await file.arrayBuffer());
            await new Promise(res => chrome.runtime.sendMessage({
              action: 'ATTACH_FILE', snapshot_id: snapId,
              filename: file.name, mime: file.type, size_bytes: file.size, content_b64: b64
            }, r => { if (chrome.runtime.lastError) res({ success: false }); else res(r); }));
          } catch (err) { console.error('[PR-hist] browse attach:', err); }
        }
        if (dz) dz.innerHTML = ORIG_HTML();
        loadHistCardFiles(snapId);
        chrome.storage.local.set({ files_changed_at: Date.now() });
      };
      input.click();
      return;
    }

    // Diff
    const diffBtn = e.target.closest('[data-diff]');
    if (diffBtn) {
      e.stopPropagation();
      const id = diffBtn.dataset.diff;
      if (!diffMode) {
        diffMode = true; diffFirstId = id;
        const diffArea = document.getElementById('diffArea');
        if (diffArea) {
          diffArea.style.display = 'block';
          diffArea.innerHTML = `<div class="diff-panel"><div class="diff-panel-header">
            <span>${PR_i18n.t('hist.diff_select')}</span>
            <button class="diff-close-btn" id="btnDiffClose">✕</button></div></div>`;
          document.getElementById('btnDiffClose')?.addEventListener('click', closeDiffMode);
        }
        renderHistoryScreen();
      } else if (diffFirstId && diffFirstId !== id) {
        const result = await SessionPortDB.diff(diffFirstId, id);
        closeDiffMode();
        showDiffResult(result);
      }
      return;
    }

    // Fork
    const forkBtn = e.target.closest('[data-fork]');
    if (forkBtn) {
      e.stopPropagation();
      PR_Utils.customPrompt(PR_i18n.t('hist.fork_prompt'), async name => {
        if (!name) return;
        await SessionPortDB.fork(forkBtn.dataset.fork, name.trim());
        renderHistoryScreen();
      });
      return;
    }

    // Remove file
    const rmBtn = e.target.closest('.hist-file-rm');
    if (rmBtn) {
      e.stopPropagation();
      const confirmed = await PR_Utils.customConfirm(PR_i18n.t('files.detach_confirm'), {
        confirmText: PR_i18n.t('files.detach_ok'),
        cancelText:  PR_i18n.t('files.detach_cancel'),
        danger: true
      });
      if (!confirmed) return;
      const jid = parseInt(rmBtn.dataset.jid, 10);
      try {
        await Promise.race([
          new Promise(r => chrome.runtime.sendMessage({ action: 'DETACH_FILE', junction_id: jid }, resp => {
            if (chrome.runtime.lastError) console.warn('[PR-hist] DETACH:', chrome.runtime.lastError.message);
            r(resp);
          })),
          new Promise(r => setTimeout(() => r({}), 10000))
        ]);
      } catch (err) { console.error('[PR-hist] DETACH exception:', err); }
      loadHistCardFiles(rmBtn.dataset.snap);
      chrome.storage.local.set({ files_changed_at: Date.now() }); return;
    }

    // Paste with files
    const pwfBtn = e.target.closest('[data-paste-with-files]');
    if (pwfBtn) { e.stopPropagation(); loadSnapAsActive(pwfBtn.dataset.pasteWithFiles, true); return; }

    // Paste only
    const poBtn = e.target.closest('[data-paste-only]');
    if (poBtn) { e.stopPropagation(); loadSnapAsActive(poBtn.dataset.pasteOnly, false); return; }

    // Soft delete → trash
    const delBtn = e.target.closest('[data-soft-delete]');
    if (delBtn) {
      e.stopPropagation();
      const confirmed = await PR_Utils.customConfirm(PR_i18n.t('hist.trash_confirm'), {
        confirmText: PR_i18n.t('hist.trash_ok'), cancelText: PR_i18n.t('hist.trash_cancel'), danger: true
      });
      if (!confirmed) return;
      const id = delBtn.dataset.softDelete;
      await SessionPortDB.softDelete(id);
      const activeId = await SessionPortDB.getActive();
      if (activeId === id) await SessionPortDB.setActive(null);
      renderHistoryScreen();
      refreshHistoryCounters();
      if (typeof _updateTrashBadge === 'function') _updateTrashBadge();
      return;
    }

    // Card body click → select (fallback when no button matched)
    const card = e.target.closest('.hist-card');
    if (card && card.dataset.id) {
      list.querySelectorAll('.hist-card.selected').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      // Pre-select in map so it's highlighted when switching to map tab
      if (_hmapRenderer) _hmapRenderer.selectedId = card.dataset.id;
    }
  });
}

async function loadSnapAsActive(id, withFiles) {
  const snap = await SessionPortDB.getSnapshot(id);
  if (!snap) return;
  const state = { ...PR_Utils.snapToFlowState(snap), inject_files: !!withFiles, from_history: true };
  await new Promise(res => chrome.storage.local.set({ flow_state: state }, res));
  await SessionPortDB.setActive(snap.snapshot_id);
  showScreen('main');
  _syncProjectBarToSnap(snap);

  // Bug-4: схлопываем секции переноса, раскрываем paste
  // filesSection управляется через loadAttachedFiles() — from_history + inject_files
  document.getElementById('sectionSimple')?.classList.remove('open');
  document.getElementById('sectionExtended')?.classList.remove('open');
  if (!withFiles) document.getElementById('filesSection')?.style.setProperty('display', 'none');

  showPastePanel(withFiles ? 'hist.snap_with_files' : 'hist.snap_loaded');
  if (typeof _fillSnapCard === 'function') _fillSnapCard();
  setStatus(PR_i18n.t(withFiles ? 'hist.status_loaded_files' : 'hist.status_loaded'), 'active');
}

// ── Reactive: storage changes ─────────────────────────────
chrome.storage.onChanged.addListener(changes => {
  if (changes.flow_state) {
    const ns = changes.flow_state.newValue;
    if (ns?.status === 'READY_TO_INJECT' && ns?.payload && ns?.source_host !== 'test') {
      showPastePanel('paste_msg.captured');
      refreshHistoryCounters();
      initProjectBar();
      if (document.getElementById('screenHistory')?.classList.contains('visible'))
        renderHistoryScreen();
    }
  }
  if (changes.snapshot_added_at) {
    refreshHistoryCounters();
    if (document.getElementById('screenHistory')?.classList.contains('visible'))
      renderHistoryScreen();
  }
  if (changes.pr_theme) {
    document.body.classList.toggle('light', changes.pr_theme.newValue === 'light');
  }
  if (changes.files_changed_at) {
    if (document.getElementById('screenHistory')?.classList.contains('visible'))
      renderHistoryScreen();
  }
});
