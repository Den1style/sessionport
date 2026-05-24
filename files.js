/**
 * SessionPort — files.js
 * Главный dropzone + список прикреплённых файлов к активному снапшоту.
 * Зависимости: popup-utils.js (setStatus, $), shared-utils.js (PR_Utils), db.js
 */

// ── EXT color map ─────────────────────────────────────────
const EXT_COLORS = {
  py:   { label: 'PY',   bg: 'rgba(59,130,246,0.15)',  fg: '#60a5fa' },
  js:   { label: 'JS',   bg: 'rgba(239,159,39,0.15)',  fg: '#fbbf24' },
  ts:   { label: 'TS',   bg: 'rgba(59,130,246,0.15)',  fg: '#60a5fa' },
  json: { label: 'JSON', bg: 'rgba(239,159,39,0.15)',  fg: '#fbbf24' },
  md:   { label: 'MD',   bg: 'rgba(29,158,117,0.15)',  fg: '#34d399' },
  txt:  { label: 'TXT',  bg: 'rgba(148,163,184,0.15)', fg: '#94a3b8' },
  html: { label: 'HTML', bg: 'rgba(239,68,68,0.15)',   fg: '#f87171' },
  css:  { label: 'CSS',  bg: 'rgba(59,130,246,0.15)',  fg: '#60a5fa' },
  pdf:  { label: 'PDF',  bg: 'rgba(239,68,68,0.15)',   fg: '#f87171' },
  docx: { label: 'DOC',  bg: 'rgba(59,130,246,0.15)',  fg: '#60a5fa' },
};

function _extIcon(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return EXT_COLORS[ext] || { label: ext.toUpperCase().slice(0, 4) || '?', bg: '#2a3140', fg: '#94a3b8' };
}

// ── Snap card (active snapshot preview) ──────────────────
const snapCard    = document.getElementById('snapCard');
const projBar     = document.querySelector('.proj-bar');
const projInfoBtn = document.getElementById('projInfoBtn');

projInfoBtn?.addEventListener('click', e => {
  e.stopPropagation();
  if (typeof toggleProjectDropdown === 'function') toggleProjectDropdown(false);
  const isOpen = snapCard?.classList.toggle('open');
  projInfoBtn.classList.toggle('active', !!isOpen);
  projBar?.classList.toggle('snap-open', !!isOpen);
  if (isOpen) _fillSnapCard();
});

async function _fillSnapCard() {
  const activeId = await new Promise(r =>
    chrome.runtime.sendMessage({ action: 'GET_ACTIVE' }, resp => r(resp?.snapshot_id)));
  if (!activeId) return;
  if (SessionPortDB.openDB) await SessionPortDB.openDB();
  const snap = await SessionPortDB.getSnapshot(activeId);
  if (!snap) return;
  const p = snap.payload || {};
  const esc = PR_Utils.esc;
  const el = id => document.getElementById(id);

  const isV11 = !!p.dna || !!p.state;

  // Goal
  const goal = isV11
    ? (p.dna?.goal || p.meta?.project || '—')
    : (p.core?.intent || p.meta?.project || p.project || '—');
  if (el('snapGoal')) el('snapGoal').textContent = goal;

  // Status / current task
  const status = isV11
    ? (p.state?.current_task || '—')
    : (p.runtime?.current_status || '—');
  if (el('snapStatus')) el('snapStatus').textContent = status;

  // Next step
  const next = isV11
    ? (p.state?.next_step || '—')
    : (p.runtime?.immediate_next_step || '—');
  if (el('snapNext')) el('snapNext').textContent = next;

  // Decisions
  let decisions = [];
  if (isV11) {
    decisions = (p.decisions || []).slice(0, 5).map(d => d.what || String(d));
  } else {
    decisions = (p.ledger?.critical_decisions || []).slice(0, 5);
  }
  const ul = el('snapDecisions');
  if (ul) ul.innerHTML = decisions.length
    ? decisions.map(d => `<li>${esc(d)}</li>`).join('')
    : `<li class="no-decisions">${PR_i18n.t('snap.no_decisions')}</li>`;

  // Update project bar
  if (typeof initProjectBar === 'function') initProjectBar();
}

// ── Main dropzone ─────────────────────────────────────────
const dropzone  = document.getElementById('dropzone');

// Direct call — как в рабочей v1.2.37
const _debouncedLoadAttachedFiles = () => loadAttachedFiles();
const filesList = document.getElementById('filesList');
const filesCount = document.getElementById('filesCount');

// Bug-06: track already-staged drag IDs so renderFiles doesn't re-stage on every render
const _stagedDragIds = new Set();

let _loadingFiles = false;
async function loadAttachedFiles() {
  if (_loadingFiles) return; // prevent concurrent calls
  _loadingFiles = true;
  try {
  const flowState = await new Promise(r =>
    chrome.storage.local.get(['flow_state'], res => r(res.flow_state || {})));

  const isReady     = flowState.status === 'READY_TO_INJECT';
  const fromHistory = !!flowState.from_history;
  // inject_files: undefined (btn-hload/map) → show files; false (paste-only) → hide
  const injectFiles = flowState.inject_files !== false;

  const activeId = await new Promise(r =>
    chrome.runtime.sendMessage({ action: 'GET_ACTIVE' }, resp => {
      if (chrome.runtime.lastError) { console.warn('[PR] GET_ACTIVE:', chrome.runtime.lastError.message); r(null); }
      else r(resp?.snapshot_id);
    }));

  const committed = (flowState.mode === 'simple' && flowState.step >= 3) ||
                     (flowState.mode === 'extended' && flowState.step >= 4);

  // Dropzone is active only during a live transfer — never for history loads
  updateDropzoneState(isReady && !!activeId && !committed && !fromHistory);

  const overlayS = document.getElementById('overlaySimple');
  const overlayE = document.getElementById('overlayExtended');
  const overlayVisible = (overlayS && overlayS.style.display !== 'none') || (overlayE && overlayE.style.display !== 'none');
  if (!activeId || !isReady || overlayVisible || committed) { renderFiles([]); return; }

  const resp = await Promise.race([
    new Promise(r => chrome.runtime.sendMessage({ action: 'LIST_FILES', snapshot_id: activeId }, r2 => {
      if (chrome.runtime.lastError) { console.warn('[PR] LIST_FILES:', chrome.runtime.lastError.message); r({ files: [] }); }
      else r(r2);
    })),
    new Promise(r => setTimeout(() => r({ files: [], error: 'timeout' }), 10000))
  ]);

  const files = resp?.files || [];
  // Read-only when from history and files are meant to be included in paste
  renderFiles(files, fromHistory && injectFiles);

  // History mode: show section only if files exist and will be pasted; always hide dropzone
  if (fromHistory) {
    const filesSection = document.getElementById('filesSection');
    const showSection  = injectFiles && files.length > 0;
    if (filesSection) filesSection.style.display = showSection ? '' : 'none';
    if (dropzone)     dropzone.style.display = 'none';
  }
  } finally { _loadingFiles = false; }
}

function updateDropzoneState(hasSnap) {
  const filesSection = document.getElementById('filesSection');
  if (filesSection) filesSection.style.display = hasSnap ? '' : 'none';
  if (!dropzone) return;
  const titleEl = dropzone.querySelector('.dropzone-title');
  const hintEl  = dropzone.querySelector('.dropzone-hint');
  if (hasSnap) {
    dropzone.classList.remove('disabled');
    if (titleEl) titleEl.textContent  = PR_i18n.t('files.dropzone_title');
    if (hintEl)  hintEl.innerHTML     = PR_i18n.t('files.dropzone_hint');
    // Re-bind browse button since innerHTML replaced it
    document.getElementById('btnBrowseFiles')?.addEventListener('click', _onBrowseClick);
  } else {
    dropzone.classList.add('disabled');
    if (titleEl) titleEl.textContent  = PR_i18n.t('files.dropzone_title');
    if (hintEl)  hintEl.innerHTML     = PR_i18n.t('files.dropzone_locked');
  }
}

function renderFiles(files, readOnly = false) {
  if (!filesList) return;
  filesList.innerHTML = '';
  const total = files.reduce((a, f) => a + (f.size_bytes || 0), 0);
  if (filesCount) filesCount.textContent = `${files.length} · ${PR_Utils.fmtBytes(total)}`;
  for (const f of files) {
    const ic  = _extIcon(f.filename);
    const div = document.createElement('div');
    div.className = 'file-item';
    div.draggable = true;
    div.title = PR_i18n.t('files.drag_title');
    div.innerHTML = `
      <div class="file-icon" style="background:${ic.bg};color:${ic.fg};">${PR_Utils.esc(ic.label)}</div>
      <div class="file-meta">
        <div class="file-name">${PR_Utils.esc(f.filename)}</div>
        <div class="file-sub">${f.hash.slice(0, 14)}… · ${PR_Utils.fmtBytes(f.size_bytes)}</div>
      </div>
      ${readOnly ? '' : `<div class="file-remove" data-jid="${f.junction_id}" title="${PR_i18n.t('files.unbind_title')}">×</div>`}`;
    if (!readOnly) {
      div.querySelector('.file-remove').addEventListener('click', e => {
        const jid = parseInt(e.target.dataset.jid, 10);
        chrome.runtime.sendMessage({ action: 'DETACH_FILE', junction_id: jid }, () => {
          if (chrome.runtime.lastError) console.warn('[PR] DETACH:', chrome.runtime.lastError.message);
          loadAttachedFiles();
          chrome.storage.local.set({ files_changed_at: Date.now() });
        });
      });
    }
    // ── Drag-out: side panel → page ──────────────────────────
    // dragId фиксированный per-file — стейджим один раз за сессию popup
    const fixedDragId = 'pr-file-' + f.junction_id;
    if (!_stagedDragIds.has(fixedDragId)) {
      _stagedDragIds.add(fixedDragId);
      chrome.runtime.sendMessage({
        action: 'STAGE_DRAG_FILE',
        drag_id: fixedDragId,
        junction_id: f.junction_id
      });
    }

    div.addEventListener('mousedown', e => {
      div.draggable = !e.target.classList.contains('file-remove');
    });

    div.addEventListener('dragstart', e => {
      // Подавляем text/plain через пустой drag image — clearData() не работает в Chrome
      // когда div содержит текст
      const ghost = document.createElement('canvas');
      ghost.width = 1; ghost.height = 1;
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 0, 0);
      setTimeout(() => ghost.remove(), 0);

      e.dataTransfer.clearData();
      e.dataTransfer.effectAllowed = 'copy';
      try { e.dataTransfer.setData('application/x-SessionPort-drag', fixedDragId); } catch (_) {}
      try { e.dataTransfer.setData('text/x-SessionPort-drag', fixedDragId); } catch (_) {}
      // Не добавляем text/uri-list — он присутствует во всех drop с файлами автоматически
      // и вызывал ложные срабатывания capture-listener на синтетических drop
      div.classList.add('dragging');
    });
    div.addEventListener('dragend', () => {
      div.classList.remove('dragging');
    });
    filesList.appendChild(div);
  }
}

// ── Shared file attachment logic ──────────────────────────
async function _attachFiles(files) {
  const activeId = await new Promise(r =>
    chrome.runtime.sendMessage({ action: 'GET_ACTIVE' }, resp => r(resp?.snapshot_id)));
  if (!activeId) {
    const titleEl = dropzone?.querySelector('.dropzone-title');
    const hintEl  = dropzone?.querySelector('.dropzone-hint');
    const origT = titleEl?.textContent, origH = hintEl?.innerHTML;
    if (titleEl) titleEl.textContent = PR_i18n.t('files.no_snap_title');
    if (hintEl)  hintEl.innerHTML    = PR_i18n.t('files.no_snap_hint');
    dropzone?.classList.add('disabled', 'shake');
    setTimeout(() => {
      dropzone?.classList.remove('shake');
      if (titleEl && origT) titleEl.textContent = origT;
      if (hintEl  && origH) hintEl.innerHTML    = origH;
    }, 4000);
    setStatus(PR_i18n.t('status.no_snap_ctx'), 'error');
    return;
  }

  setStatus(PR_i18n.t('status.attaching'), 'working');
  let attached = 0;
  const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      setStatus(PR_i18n.t('status.attach_big', { name: file.name, size: PR_Utils.fmtBytes(file.size) }), 'error');
      continue;
    }
    try {
      const b64    = PR_Utils.arrayBufferToBase64(await file.arrayBuffer());
      const result = await Promise.race([
        new Promise(res => chrome.runtime.sendMessage({
          action: 'ATTACH_FILE', snapshot_id: activeId,
          filename: file.name, mime: file.type, size_bytes: file.size, content_b64: b64
        }, r => { if (chrome.runtime.lastError) res({ success: false, error: chrome.runtime.lastError.message }); else res(r); })),
        new Promise(res => setTimeout(() => res({ success: false, error: 'timeout' }), 30000))
      ]);
      if (result?.success) attached++;
      else {
        const err = result?.error || '';
        if (err.toLowerCase().includes('quota')) setStatus(PR_i18n.t('status.attach_err_quota'), 'error');
        else if (err === 'timeout') setStatus(PR_i18n.t('status.attach_timeout', { name: file.name }), 'error');
        console.warn('[PR] attach failed:', file.name, err);
      }
    } catch (err) { console.error('[PR] attach exception:', file.name, err); }
  }
  await loadAttachedFiles();
  chrome.storage.local.set({ files_changed_at: Date.now() });
  setStatus(PR_i18n.t('status.attach_n', { n: attached, total: files.length }), 'active');
}

// ── Dropzone events ───────────────────────────────────────
if (dropzone) {
  ['dragenter', 'dragover'].forEach(ev =>
    dropzone.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); dropzone.classList.add('drag-over'); }));
  ['dragleave', 'drop'].forEach(ev =>
    dropzone.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); dropzone.classList.remove('drag-over'); }));

  dropzone.addEventListener('drop', async e => {
    let files = Array.from(e.dataTransfer.files || []);
    if (!files.length && e.dataTransfer.items)
      for (const item of e.dataTransfer.items)
        if (item.kind === 'file') { const f = item.getAsFile(); if (f) files.push(f); }
    if (!files.length) {
      setStatus(PR_i18n.t('hist.not_file'), 'error'); return;
    }
    await _attachFiles(files);
  });
}

// ── File input (browse button) ────────────────────────────
const fileInput = document.getElementById('fileInput');
function _onBrowseClick(e) {
  e.stopPropagation();
  if (dropzone?.classList.contains('disabled')) {
    setStatus(PR_i18n.t('files.dropzone_locked'), 'error');
    return;
  }
  fileInput?.click();
}
document.getElementById('btnBrowseFiles')?.addEventListener('click', _onBrowseClick);
fileInput?.addEventListener('change', async () => {
  const files = Array.from(fileInput.files || []);
  if (files.length) await _attachFiles(files);
  fileInput.value = ''; // reset so same file can be re-selected
});

// ── Hist card files (reused by history.js) ────────────────
async function loadHistCardFiles(snapshot_id) {
  const card = document.querySelector(`.hist-files[data-files-for="${snapshot_id}"]`);
  if (!card) return;
  const list  = card.querySelector('.hist-files-list');
  const count = card.querySelector('.hist-files-count');
  try {
    const resp = await Promise.race([
      new Promise(r => chrome.runtime.sendMessage({ action: 'LIST_FILES', snapshot_id }, r2 => {
        if (chrome.runtime.lastError) r({ files: [] });
        else r(r2);
      })),
      new Promise(r => setTimeout(() => r({ files: [], error: 'timeout' }), 10000))
    ]);
    const files = resp?.files || [];
    const total = files.reduce((a, f) => a + (f.size_bytes || 0), 0);
    const header = card.querySelector('.hist-files-header');
    if (files.length === 0) {
      if (header) header.style.display = 'none';
      if (count) count.textContent = resp?.error === 'timeout' ? '⚠ timeout' : '';
    } else {
      if (header) header.style.display = '';
      if (count) count.textContent = `${files.length} · ${PR_Utils.fmtBytes(total)}`;
    }
    if (list) list.innerHTML = files.map(f => {
      const ic = _extIcon(f.filename);
      return `<div class="hist-file-row">
        <div class="hist-file-ic" style="background:${ic.bg};color:${ic.fg};">${PR_Utils.esc(ic.label)}</div>
        <div class="hist-file-name">${PR_Utils.esc(f.filename)}</div>
        <div class="hist-file-rm" data-jid="${f.junction_id}" data-snap="${snapshot_id}" title="${PR_i18n.t('files.unbind_title')}">×</div>
      </div>`;
    }).join('');
  } catch (err) {
    console.error('[PR] loadHistCardFiles:', err);
    if (count) count.textContent = '⚠ error';
  }
}

// ── Init & reactive ───────────────────────────────────────
loadAttachedFiles();
// Bug-05 fix: debounce focus to avoid repeated GET_ACTIVE + LIST_FILES on each panel return
let _focusDebounce = null;
window.addEventListener('focus', () => {
  // Не загружаем файлы если overlay успеха показан
  const oS = document.getElementById('overlaySimple');
  const oE = document.getElementById('overlayExtended');
  if ((oS && oS.style.display !== 'none') || (oE && oE.style.display !== 'none')) return;
  clearTimeout(_focusDebounce);
  _focusDebounce = setTimeout(loadAttachedFiles, 500);
});

// FIX Issue 7: don't reload main files on hist-card changes
// Main panel only cares about flow_state changes (new HEAD set)
// hist-card file changes are handled by loadHistCardFiles() directly
chrome.storage.onChanged.addListener(changes => {
  const oS = document.getElementById('overlaySimple');
  const oE = document.getElementById('overlayExtended');
  const overlayVisible = (oS && oS.style.display !== 'none') || (oE && oE.style.display !== 'none');
  if (overlayVisible) return;

  if (changes.flow_state) {
    const newState = changes.flow_state.newValue;
    if (newState?.status === 'READY_TO_INJECT' || newState?.status === 'IDLE') {
      loadAttachedFiles();
    }
  }

  // Дополнительный триггер после snapshot_added_at (гарантия что activeId уже в DB)
  if (changes.snapshot_added_at && !overlayVisible) {
    loadAttachedFiles();
  }
});
